// ============================================================
//  config.js — конфигурация, переменные окружения, справочник законов
// ============================================================

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SESSION_STRING = process.env.SESSION_STRING || '';
const TG_API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const TG_API_HASH = process.env.TG_API_HASH || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }
if (!SESSION_STRING) { console.error('❌ Не задан SESSION_STRING.'); process.exit(1); }
if (!TG_API_ID || !TG_API_HASH) { console.error('❌ Не заданы TG_API_ID / TG_API_HASH.'); process.exit(1); }
if (!GEMINI_API_KEY) { console.error('❌ Не задан GEMINI_API_KEY.'); process.exit(1); }

const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
if (!EXTERNAL_URL) { console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.'); process.exit(1); }

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '300', 10);
const CHUNK_SIZE = 40;
const GEMINI_MIN_INTERVAL_MS = 4200;
const SCAN_COOLDOWN_MS = parseInt(process.env.SCAN_COOLDOWN_MINUTES || '10', 10) * 60 * 1000;

// ⚠️ Бот открыт для всех — квота Gemini общая, поэтому есть кулдаун на пользователя.

const LAW_MAP = {
    personal_data: ['https://gdpr-info.eu/art-6-gdpr/', 'https://gdpr-info.eu/art-9-gdpr/', 'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:12012P/TXT#P8'],
    illegal_goods: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2065'],
    csam: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0093'],
    terrorism_violence: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32021R0784'],
    hate_speech: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32008F0913'],
    copyright: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32019L0790'],
    malware_fraud: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2065'],
    other: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2065']
};
function getLawLinks(lawType) { return LAW_MAP[lawType] || LAW_MAP.other; }

module.exports = {
    BOT_TOKEN, SESSION_STRING, TG_API_ID, TG_API_HASH, GEMINI_API_KEY,
    PORT, EXTERNAL_URL, WEBHOOK_PATH, GEMINI_MODEL, GEMINI_URL,
    SCAN_LIMIT, CHUNK_SIZE, GEMINI_MIN_INTERVAL_MS, SCAN_COOLDOWN_MS,
    LAW_MAP, getLawLinks
};
// ============================================================
//  telegram-client.js — бот, вебхук-сервер, MTProto-сессия, кэш ToS
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');
const { BOT_TOKEN, SESSION_STRING, TG_API_ID, TG_API_HASH, PORT, EXTERNAL_URL, WEBHOOK_PATH } = require('./config');

const bot = new TelegramBot(BOT_TOKEN, { webHook: false });
console.log('🚀 Бот-анализатор запущен (webhook)');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            try { bot.processUpdate(JSON.parse(body)); } catch (e) { console.error('parse error:', e); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});
server.listen(PORT, async () => {
    console.log(`✅ Сервер на порту ${PORT}`);
    try {
        await bot.setWebHook(`${EXTERNAL_URL}${WEBHOOK_PATH}`);
        console.log('✅ Webhook установлен');
    } catch (e) { console.error('❌ Webhook error:', e); }
});

// ====== MTPROTO-КЛИЕНТ ======
let mtClient = null, mtReady = false;
async function ensureMtClient() {
    if (mtReady && mtClient) return mtClient;
    mtClient = new TelegramClient(new StringSession(SESSION_STRING), TG_API_ID, TG_API_HASH, { connectionRetries: 3 });
    await mtClient.connect();
    mtReady = true;
    console.log('✅ MTProto-сессия подключена');
    return mtClient;
}

// ====== ТЕКСТ TOS TELEGRAM (кэш на сутки, подтягивается перед анализом) ======
let tosCache = { text: '', fetchedAt: 0 };
async function getTelegramTos() {
    if (tosCache.text && Date.now() - tosCache.fetchedAt < 24 * 3600 * 1000) return tosCache.text;
    try {
        const res = await fetch('https://telegram.org/tos', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) return tosCache.text; // старый кэш лучше, чем ничего
        const html = await res.text();
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        tosCache = { text: text.slice(0, 3000), fetchedAt: Date.now() };
    } catch (e) {
        console.error('getTelegramTos error:', e.message);
    }
    return tosCache.text;
}

module.exports = { bot, server, ensureMtClient, getTelegramTos };
            // ============================================================
//  gemini.js — анализ пачек сообщений через Gemini + генерация жалобы
// ============================================================
const { GEMINI_URL, GEMINI_MIN_INTERVAL_MS } = require('./config');

let lastGeminiCall = 0;
async function throttleGemini() {
    const wait = GEMINI_MIN_INTERVAL_MS - (Date.now() - lastGeminiCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeminiCall = Date.now();
}

// ====== АНАЛИЗ ПАЧКИ СООБЩЕНИЙ ======
// Возвращает { violations: [...], manualReview: [...] }.
// Если Gemini блокирует пачку целиком (PROHIBITED_CONTENT / SAFETY), пачка
// дробится пополам рекурсивно — так вместо "пачка не проверилась" мы находим
// конкретные подозрительные сообщения. Сам защитный фильтр Gemini НЕ обходится:
// если сообщение блокируется даже поштучно, оно просто помечается для ручной
// проверки человеком, а не прогоняется через промпт заново в другой форме.
async function analyzeChunk(messages, tosText, attempt = 1) {
    const MAX_ATTEMPTS = 4;
    await throttleGemini();

    const listText = messages.map((m) => {
        const fwdTag = m.isForwarded ? '[ПЕРЕСЛАНО] ' : '';
        return `[${m.id}] ${fwdTag}${m.text.replace(/\n/g, ' ').slice(0, 500)}`;
    }).join('\n');

    const prompt = `Ты — модератор, проверяющий сообщения Telegram-канала/группы на нарушения официальных Условий использования Telegram (текст ниже) и применимого законодательства EU, включая:
- публикацию личных данных людей без согласия ("пробив", доксинг): ФИО + телефон/паспорт/СНИЛС/ИНН/адрес/номер авто;
- продажу оружия, наркотиков, поддельных документов;
- мошенничество и финансовые схемы обмана;
- контент с сексуализацией несовершеннолетних;
- пропаганду терроризма или насилия;
- разжигание ненависти по признаку расы/религии/национальности;
- массовое нарушение авторских прав;
- вредоносное ПО/фишинговые ссылки;
- любые другие нарушения официальных условий использования Telegram ниже.

=== Официальные условия использования Telegram (для сверки) ===
${tosText || '(не удалось загрузить, полагайся на список выше)'}
=== конец условий ===

ВАЖНО: сообщения [ПЕРЕСЛАНО] — репост из другого источника. Переслан от Telegram/поддержки официальный текст — это НЕ фишинг, канал просто переслал пост. Оценивай нейтрально, если сам канал не добавил обманный контент.

ВАЖНО: оценивай строго по фактическому содержанию сообщений. Если нарушений нет — так и верни, не придумывай их.

Верни ТОЛЬКО JSON-массив (без markdown):
[{"id":123,"category_ru":"тип на русском","category_en":"короткая EN-фраза для жалобы, без имени канала","law_type":"personal_data|illegal_goods|csam|terrorism_violence|hate_speech|copyright|malware_fraud|other","severity":1-5,"reason":"причина на русском"}]
severity 5 = гарантированный бан. Нарушений нет — верни [].

Сообщения:
${listText}`;

    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
            safetySettings: [
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' }
            ]
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        const transient = res.status === 503 || res.status === 500 || res.status === 429;
        if (transient && attempt < MAX_ATTEMPTS) {
            const waitMs = 3000 * attempt;
            console.error(`Gemini ${res.status} (попытка ${attempt}/${MAX_ATTEMPTS}), жду ${waitMs}мс`);
            await new Promise((r) => setTimeout(r, waitMs));
            return analyzeChunk(messages, tosText, attempt + 1);
        }
        throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    }

    const data = await res.json();

    const blockReason = data.promptFeedback?.blockReason
        || (['SAFETY', 'PROHIBITED_CONTENT'].includes(data.candidates?.[0]?.finishReason) ? data.candidates[0].finishReason : null);

    if (blockReason) {
        if (messages.length > 1) {
            // Дробим пачку пополам, чтобы найти конкретные проблемные сообщения,
            // а не терять всю пачку целиком.
            const mid = Math.ceil(messages.length / 2);
            const [left, right] = await Promise.all([
                analyzeChunk(messages.slice(0, mid), tosText),
                analyzeChunk(messages.slice(mid), tosText)
            ]);
            return {
                violations: [...left.violations, ...right.violations],
                manualReview: [...left.manualReview, ...right.manualReview]
            };
        }
        // Дошли до одного сообщения — дальше дробить некуда, это конкретный
        // подозрительный пост. Помечаем его для ручной проверки человеком.
        return {
            violations: [],
            manualReview: [{ id: messages[0].id, reason: `Gemini отказался анализировать (${blockReason}) — вероятно серьёзное нарушение, требует ручной проверки` }]
        };
    }

    const candidate = data.candidates?.[0];
    const raw = candidate?.content?.parts?.map((p) => p.text).join('') || '[]';
    let violations;
    try { violations = JSON.parse(raw); } catch (e) { console.error('JSON parse error:', raw.slice(0, 300)); violations = []; }
    return { violations, manualReview: [] };
}

// ====== ЗАПАСНЫЕ ШАБЛОНЫ ЖАЛОБЫ ======
const COMPLAINT_TEMPLATES = [
    (ch, vl, desc) => `Dear Telegram Support Team,\n\nI am writing to report a serious violation of Telegram's Terms of Service and applicable European Union law on the channel ${ch}. The channel is engaged in ${desc}, as evidenced by the post ${vl}.\n\nThis content is unacceptable and requires immediate attention. I urge you to investigate this matter promptly and take appropriate action, including removal of the content and/or suspension of the channel.\n\nThank you for your swift response.`,
    (ch, vl, desc) => `Dear Telegram Support Team,\n\nI would like to report the channel ${ch} for violating both Telegram's Terms of Service and European Union law. The post ${vl} clearly demonstrates ${desc}.\n\nI kindly request that you review this content as a matter of urgency and take the necessary enforcement action against the channel.\n\nThank you for your attention to this matter.`,
    (ch, vl, desc) => `Dear Telegram Support Team,\n\nThis is a formal report regarding the channel ${ch}, which is in breach of Telegram's Terms of Service and European Union law through ${desc}. A clear example of this can be found at ${vl}.\n\nPlease investigate this matter and take appropriate action against the channel as soon as possible.\n\nI appreciate your prompt handling of this report.`
];
function buildComplaintFallback(channelLink, violationLink, categoryEn) {
    const desc = categoryEn ? categoryEn.trim() : "the publication of content that violates Telegram's policies";
    const template = COMPLAINT_TEMPLATES[Math.floor(Math.random() * COMPLAINT_TEMPLATES.length)];
    return template(channelLink, violationLink, desc);
}

const EFFECTIVE_LINE = "Please immediately investigate and take action for violating EU law and Telegram's Terms of Service.";
function insertBeforeClosing(text) {
    if (text.includes(EFFECTIVE_LINE)) return text;
    const idx = text.lastIndexOf('\n\n');
    return idx === -1 ? `${text}\n\n${EFFECTIVE_LINE}` : `${text.slice(0, idx)}\n\n${EFFECTIVE_LINE}${text.slice(idx)}`;
}

async function generateComplaintViaAI(channelLink, violationLink, violation) {
    await throttleGemini();
    const prompt = `Напиши короткое официальное письмо-жалобу на английском в поддержку Telegram ("Dear Telegram Support Team") про нарушение конкретным каналом одновременно и Условий использования Telegram, и применимого законодательства EU — явно укажи в тексте оба этих основания (Telegram ToS И EU law), а не только одно.

Канал: ${channelLink}
Пост-доказательство: ${violationLink}
Тип нарушения: ${violation.category_en}
Детали: ${violation.reason}

Требования:
- 3 коротких абзаца, формальный тон, без markdown.
- Упомяни ссылку на канал и ссылку на пост-доказательство.
- Не упоминай ссылки на конкретные статьи законов — они уходят отдельным сообщением, но сам факт "нарушение EU law и Telegram ToS" упомяни текстом.
- Не упоминай юзернейм канала как часть описания нарушения — только как ссылку.
- Заверши вежливой финальной фразой.
- После текста автоматически добавится фраза "${EFFECTIVE_LINE}" — не пиши похожего по смыслу сама.
- Формулируй каждый раз немного иначе.
- Верни ТОЛЬКО текст письма.`;
    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9 } })
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`); }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text.trim()) throw new Error('Пустой ответ от нейросети при генерации жалобы.');
    return text.trim();
}

async function buildComplaint(channelLink, violationLink, violation) {
    let text;
    try {
        text = await generateComplaintViaAI(channelLink, violationLink, violation);
    } catch (e) {
        console.error('generateComplaintViaAI error, использую запасной шаблон:', e.message);
        text = buildComplaintFallback(channelLink, violationLink, violation.category_en);
    }
    return insertBeforeClosing(text);
}

module.exports = { analyzeChunk, buildComplaint };
      // ============================================================
//  scan.js — сканирование канала/группы, прогресс, финальный отчёт
// ============================================================
const fs = require('fs');
const path = require('path');
const { Api } = require('teleproto');
const { bot, ensureMtClient, getTelegramTos } = require('./telegram-client');
const { analyzeChunk, buildComplaint } = require('./gemini');
const { CHUNK_SIZE, SCAN_LIMIT, getLawLinks } = require('./config');

// ====== ПРОГРЕСС-БАР И ФОРМАТИРОВАНИЕ ======
function renderProgressBar(current, total, width = 20) {
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    const filledExact = ratio * width;
    const filled = Math.floor(filledExact);
    const partial = filledExact - filled;
    const partialChar = partial > 0.66 ? '▓' : partial > 0.33 ? '▒' : '';
    const emptyCount = width - filled - (partialChar ? 1 : 0);
    const bar = '█'.repeat(filled) + partialChar + '░'.repeat(Math.max(0, emptyCount));
    return `[${bar}] ${Math.min(100, Math.round(ratio * 100))}%`;
}
function formatElapsed(ms) {
    const sec = Math.round(ms / 1000);
    return sec < 60 ? `${sec}с` : `${Math.floor(sec / 60)}м ${sec % 60}с`;
}
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ====== РАЗБОР ССЫЛКИ — ТОЛЬКО ПОЛНЫЙ ФОРМАТ t.me/..., БЕЗ @юзернейм/имени ======
function extractUsername(text) {
    const m = text.trim().match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,32})\/?$/i);
    return m ? m[1] : null;
}

// ====== АДМИНЫ ГРУППЫ (Telegram банит группы по постам админов, не участников) ======
async function getGroupAdminIds(client, entity) {
    const adminIds = new Set();
    try {
        if (entity.className === 'Channel') {
            const result = await client.invoke(new Api.channels.GetParticipants({
                channel: entity,
                filter: new Api.ChannelParticipantsAdmins(),
                offset: 0,
                limit: 200,
                hash: BigInt(0)
            }));
            (result.users || []).forEach((u) => adminIds.add(Number(u.id)));
        } else if (entity.className === 'Chat') {
            const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
            const participants = full.fullChat?.participants?.participants || [];
            participants.forEach((p) => {
                if (p.className === 'ChatParticipantAdmin' || p.className === 'ChatParticipantCreator') {
                    adminIds.add(Number(p.userId));
                }
            });
        }
    } catch (e) {
        console.error('getGroupAdminIds error:', e.message);
    }
    return adminIds;
}

// ====== ОСНОВНОЙ АНАЛИЗ ======
async function scanChannel(chatId, username, progressMsgId, mode) {
    const scanStartedAt = Date.now();
    const client = await ensureMtClient();
    const entity = await client.getEntity(username);
    const channelLink = `https://t.me/${username}`;

    if (entity.className === 'User') {
        await bot.editMessageText('❌ Это ссылка на профиль пользователя, а не на канал или группу. Пришли ссылку именно на канал/группу.', { chat_id: chatId, message_id: progressMsgId });
        return;
    }

    const detectedGroup = entity.className === 'Chat' || (entity.className === 'Channel' && entity.megagroup);
    const isGroupChat = mode ? mode === 'group' : detectedGroup;

    const rawMessages = await client.getMessages(entity, { limit: SCAN_LIMIT });
    let textMessages = rawMessages
        .filter((m) => m.message && m.message.trim().length > 0)
        .map((m) => ({ id: m.id, text: m.message, isForwarded: !!m.fwdFrom, senderId: m.senderId != null ? Number(m.senderId) : null }));

    if (isGroupChat) {
        try {
            await bot.editMessageText('👥 Это группа — определяю админов и создателя (проверяем только их сообщения, за обычных участников группу не банят)...', { chat_id: chatId, message_id: progressMsgId });
        } catch (e) {}
        const adminIds = await getGroupAdminIds(client, entity);
        if (adminIds.size) {
            textMessages = textMessages.filter((m) => m.senderId !== null && adminIds.has(m.senderId));
        }
    }

    if (!textMessages.length) {
        await bot.editMessageText(
              isGroupChat
                ? 'Не нашлось текстовых сообщений от админов/создателя группы для проверки.'
                : 'В канале не нашлось текстовых сообщений для проверки (возможно, только медиа без подписей).',
            { chat_id: chatId, message_id: progressMsgId }
        );
        return;
    }

    const tosText = await getTelegramTos();

    const chunks = [];
    for (let i = 0; i < textMessages.length; i += CHUNK_SIZE) chunks.push(textMessages.slice(i, i + CHUNK_SIZE));

    const violations = [], failedChunks = [], manualReview = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            const result = await analyzeChunk(chunks[i], tosText);
            result.violations.forEach((f) => violations.push(f));
            result.manualReview.forEach((m) => manualReview.push(m));
        } catch (e) {
            console.error('analyzeChunk error:', e.message);
            failedChunks.push({ chunk: i + 1, error: e.message });
        }
        const done = Math.min((i + 1) * CHUNK_SIZE, textMessages.length);
        try {
            await bot.editMessageText(
                `🔍 <b>Сканирую ${isGroupChat ? 'группу' : 'канал'}</b>\n\n<code>${renderProgressBar(done, textMessages.length)}</code>\n\n` +
                `📨 Проверено: <b>${done}/${textMessages.length}</b>\n⚠️ Найдено нарушений: <b>${violations.length}</b>\n🚫 На ручной проверке: <b>${manualReview.length}</b>\n⏱ ${formatElapsed(Date.now() - scanStartedAt)}`,
                { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
            );
        } catch (e) {}
    }

    try { await bot.deleteMessage(chatId, progressMsgId); } catch (e) {}

    if (!violations.length) {
        let text = `✅ Проверено ${textMessages.length} сообщений в ${channelLink} — явных нарушений (найденных моделью) не найдено.\n⏱ Заняло: ${formatElapsed(Date.now() - scanStartedAt)}`;
        if (failedChunks.length) text += `\n\n⚠️ ${failedChunks.length} из ${chunks.length} пачек не проверились. Причина: ${failedChunks[0].error}`;
        if (manualReview.length) {
            text += `\n\n🚫 Gemini отказался анализировать ${manualReview.length} сообщений (вероятно серьёзные) — проверь вручную:\n`;
            manualReview.forEach((m) => { text += `${channelLink}/${m.id}\n`; });
        }
        await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] } });
        return;
    }

    violations.sort((a, b) => (b.severity || 0) - (a.severity || 0));
    const main = violations[0];
    const mainLink = `${channelLink}/${main.id}`;

    const genMsg = await bot.sendMessage(chatId, `🤖 <b>Готовлю жалобу</b> под самое серьёзное из ${violations.length} нарушений...`, { parse_mode: 'HTML' });

    let linksText = `🔗 <b>Найденные нарушения — ${violations.length}</b> (по убыванию серьёзности)\n\n`;
    if (failedChunks.length) linksText = `⚠️ <b>${failedChunks.length}/${chunks.length} пачек не проверились</b> — список может быть неполным.\n\n` + linksText;
    violations.forEach((v, i) => { linksText += `${i + 1}. ${channelLink}/${v.id} — <b>${escapeHtml(v.category_ru || 'нарушение')}</b> (${v.severity || '?'}/5)\n   ${escapeHtml(v.reason)}\n\n`; });
    if (manualReview.length) {
        linksText += `🚫 <b>На ручной проверке — ${manualReview.length}</b> (Gemini отказался анализировать, проверь сам):\n`;
        manualReview.forEach((m) => { linksText += `${channelLink}/${m.id}\n`; });
    }
    for (let i = 0; i < linksText.length; i += 3500) await bot.sendMessage(chatId, linksText.slice(i, i + 3500), { parse_mode: 'HTML' });

    const complaintText = await buildComplaint(channelLink, mainLink, main);
    try { await bot.deleteMessage(chatId, genMsg.message_id); } catch (e) {}
    await bot.sendMessage(chatId, `📋 <b>Жалоба</b> по самому серьёзному нарушению (${escapeHtml(main.category_ru || '—')}, ${main.severity || '?'}/5) — нажми на текст, чтобы скопировать:`, { parse_mode: 'HTML' });
    await bot.sendMessage(chatId, `<pre>${escapeHtml(complaintText)}</pre>`, { parse_mode: 'HTML' });

    const lawLinks = getLawLinks(main.law_type);
    const lawsText = lawLinks.map((l, i) => `${i + 1}. ${l}`).join('\n');
    await bot.sendMessage(chatId, '⚖️ <b>Законы EU</b> по типу нарушения — отдельно, тоже копируется нажатием:', { parse_mode: 'HTML' });
    await bot.sendMessage(chatId, `<pre>${escapeHtml(lawsText)}</pre>`, { parse_mode: 'HTML' });

    let report = `${isGroupChat ? 'Группа' : 'Канал'}: ${channelLink}\nПроверено сообщений: ${textMessages.length}\nНайдено нарушений: ${violations.length}\nНа ручной проверке: ${manualReview.length}\nВремя: ${formatElapsed(Date.now() - scanStartedAt)}\n\n`;
    report += '=== Нарушения ===\n';
    violations.forEach((v) => { report += `${channelLink}/${v.id} — [${v.category_ru}, ${v.severity}/5] ${v.reason}\n`; });
    if (manualReview.length) {
        report += '\n=== На ручной проверке (Gemini отказался анализировать) ===\n';
        manualReview.forEach((m) => { report += `${channelLink}/${m.id} — ${m.reason}\n`; });
    }
    report += '\n=== Жалоба ===\n\n' + complaintText + '\n\n=== Законы ===\n\n' + lawsText;
    const filePath = path.join('/tmp', `report_${username}_${Date.now()}.txt`);
    fs.writeFileSync(filePath, report, 'utf-8');
    await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
    await bot.sendMessage(chatId, 'Готово ✅', { reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] } });
}

module.exports = { scanChannel, extractUsername };
                // ============================================================
//  index.js — точка входа: хендлеры бота, меню, кулдаун
// ============================================================
const { bot } = require('./telegram-client');
const { scanChannel, extractUsername } = require('./scan');
const { SCAN_LIMIT, SCAN_COOLDOWN_MS } = require('./config');

// ====== КУЛДАУН НА ПОЛЬЗОВАТЕЛЯ (бот открыт всем, квота Gemini общая) ======
const lastScanByUser = new Map();
function checkCooldown(chatId) {
    const last = lastScanByUser.get(chatId) || 0;
    const remaining = SCAN_COOLDOWN_MS - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
}

// ====== СОСТОЯНИЕ ОЖИДАНИЯ ССЫЛКИ ======
const awaitingLink = new Map(); // chatId -> { mode: 'channel'|'group' }

function startMenuText() {
    return `🛡 <b>Channel Guard</b> — анализ Telegram-каналов и групп на нарушения\n\n` +
        `Проверяю через нейросеть на все виды нарушений ToS Telegram и законодательства EU: слив личных данных, оружие/наркотики, мошенничество, разжигание ненависти и другое.\n\n` +
        `Что получишь:\n🔗 все нарушения со ссылками\n📋 готовую жалобу (нажми, чтобы скопировать)\n⚖️ ссылки на законы EU\n📄 полный отчёт файлом\n\n` +
        `⏳ Проверка последних ${SCAN_LIMIT} сообщений занимает от минуты до нескольких.\n` +
        `🔁 Кулдаун: ${Math.round(SCAN_COOLDOWN_MS / 60000)} мин на пользователя.`;
}
function startMenuKeyboard() {
    return { inline_keyboard: [
        [{ text: '📡 Канал', callback_data: 'mode_channel' }, { text: '👥 Группа', callback_data: 'mode_group' }],
        [{ text: '📖 Формат ссылки', callback_data: 'help_format' }]
    ] };
}

// ====== ХЕНДЛЕРЫ ======
bot.onText(/^\/start$/, (msg) => {
    awaitingLink.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, startMenuText(), { parse_mode: 'HTML', reply_markup: startMenuKeyboard() });
});

bot.on('callback_query', async (query) => {
    await bot.answerCallbackQuery(query.id);
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'help_format') {
        await bot.sendMessage(chatId, 'Принимается только полный формат ссылки:\n<code>https://t.me/channelname</code>\n<code>t.me/channelname</code>\n\n❌ Просто @юзернейм или имя человека не подойдёт — так реже путают канал с профилем человека.', { parse_mode: 'HTML' });
        return;
    }

    if (data === 'back_to_start') {
        awaitingLink.delete(chatId);
        try {
            await bot.editMessageText(startMenuText(), { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: startMenuKeyboard() });
        } catch (e) {
            await bot.sendMessage(chatId, startMenuText(), { parse_mode: 'HTML', reply_markup: startMenuKeyboard() });
        }
        return;
    }

    if (data === 'mode_channel' || data === 'mode_group') {
        const mode = data === 'mode_channel' ? 'channel' : 'group';
        awaitingLink.set(chatId, { mode });
        const label = mode === 'channel' ? 'канал' : 'группу';
        await bot.editMessageText(
            `📎 Пришли ссылку на ${label}, например <code>https://t.me/name</code>`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'back_to_start' }]] } }
        );
        return;
    }
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;

    const username = extractUsername(msg.text);
    if (!username) {
        await bot.sendMessage(chatId, '❌ Нужна полная ссылка формата <code>https://t.me/name</code> — просто @юзернейм или имя не подойдёт.', {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] }
        });
        return;
    }

    const remaining = checkCooldown(chatId);
    if (remaining > 0) {
        const mins = Math.ceil(remaining / 60000);
        await bot.sendMessage(chatId, `⏳ Подожди ещё ~${mins} мин перед следующей проверкой — бот общий, квота нейросети одна на всех.`);
        return;
    }
    lastScanByUser.set(chatId, Date.now());
    const chosenMode = awaitingLink.get(chatId)?.mode || null;
    awaitingLink.delete(chatId);

    const wait = await bot.sendMessage(chatId, '🔌 <b>Подключаюсь...</b>', { parse_mode: 'HTML' });
    try {
        await scanChannel(chatId, username, wait.message_id, chosenMode);
    } catch (e) {
        console.error('scanChannel error:', e.message);
        await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
    }
});
  
