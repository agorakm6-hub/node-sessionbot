// ============================================================
//  bot.js — анализ Telegram-каналов и групп на нарушения ToS/EU
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

// ====== КОНФИГ ======
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

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash-exp';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '100', 10);
const CHUNK_SIZE = 1;
const GEMINI_MIN_INTERVAL_MS = 4200;
const SCAN_COOLDOWN_MS = parseInt(process.env.SCAN_COOLDOWN_MINUTES || '10', 10) * 60 * 1000;

// ====== ЗАКОНЫ EU ======
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
// ====== БОТ / СЕРВЕР ======
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

// ====== ТЕКСТ TOS TELEGRAM ======
let tosCache = { text: '', fetchedAt: 0 };
async function getTelegramTos() {
    if (tosCache.text && Date.now() - tosCache.fetchedAt < 24 * 3600 * 1000) return tosCache.text;
    try {
        const res = await fetch('https://telegram.org/tos', { headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (!res.ok) return tosCache.text;
        const html = await res.text();
        const text = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        tosCache = { text: text.slice(0, 5000), fetchedAt: Date.now() };
    } catch (e) {
        console.error('getTelegramTos error:', e.message);
    }
    return tosCache.text;
}

// ====== ОГРАНИЧЕНИЕ СКОРОСТИ ======
let lastGeminiCall = 0;
async function throttleGemini() {
    const wait = GEMINI_MIN_INTERVAL_MS - (Date.now() - lastGeminiCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeminiCall = Date.now();
}

// ====== ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ======
function renderProgressBar(current, total, width = 20) {
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    const filled = Math.floor(ratio * width);
    const empty = width - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    return `${bar} ${Math.min(100, Math.round(ratio * 100))}%`;
}

function formatElapsed(ms) {
    const sec = Math.round(ms / 1000);
    return sec < 60 ? `${sec}с` : `${Math.floor(sec / 60)}м ${sec % 60}с`;
}

function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function bold(text) {
    return `<b>${escapeHtml(text)}</b>`;
}

function code(text) {
    return `<code>${escapeHtml(text)}</code>`;
}

function extractUsername(text) {
    const m = text.trim().match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,32})\/?$/i);
    return m ? m[1] : null;
          }
// ====== АНАЛИЗ ПАЧКИ СООБЩЕНИЙ ======
async function analyzeChunk(messages, tosText, attempt = 1) {
    const MAX_ATTEMPTS = 4;
    await throttleGemini();

    const listText = messages.map((m) => {
        const fwdTag = m.isForwarded ? '[ПЕРЕСЛАНО] ' : '';
        return `[${m.id}] ${fwdTag}${m.text.replace(/\n/g, ' ').slice(0, 500)}`;
    }).join('\n');

    const prompt = `Ты — эксперт по модерации контента. Твоя задача — тщательно проанализировать ОДНО сообщение из Telegram-канала или группы на предмет нарушения:

1. Условий использования Telegram (Telegram ToS)
2. Законодательства Европейского Союза (EU law)

=== Официальные условия использования Telegram ===
${tosText || '(не удалось загрузить, используй общие правила)'}
=== конец условий ===

Проверь сообщение по следующим категориям нарушений (в порядке приоритета):

1. **CSAM** — контент с сексуализацией несовершеннолетних (САМЫЙ СЕРЬЁЗНЫЙ)
2. **Личные данные** — публикация ФИО + телефон/паспорт/СНИЛС/ИНН/адрес/номер авто без согласия (доксинг, "пробив")
3. **Терроризм и насилие** — пропаганда терроризма, угрозы насилия, призывы к насильственным действиям
4. **Незаконные товары** — продажа оружия, наркотиков, поддельных документов
5. **Разжигание ненависти** — по признаку расы, религии, национальности, пола
6. **Мошенничество** — финансовые схемы обмана, фишинг, вредоносное ПО
7. **Авторские права** — массовое нарушение авторских прав
8. **Другие нарушения** — иные нарушения ToS Telegram и EU law

⚠️ ВАЖНО: Если сообщение [ПЕРЕСЛАНО] — это репост из другого источника.

Верни ТОЛЬКО JSON-массив (без markdown):
[{"id":123,"category_ru":"тип нарушения на русском","category_en":"короткая EN-фраза для жалобы","law_type":"personal_data|illegal_goods|csam|terrorism_violence|hate_speech|copyright|malware_fraud|other","severity":1-5,"reason":"подробная причина на русском"}]

severity: 5=гарантированный бан, 4=вероятный бан, 3=нарушение ToS, 2=подозрительно, 1=незначительно

Если нарушений нет — верни [].

Сообщения для анализа:
${listText}`;

    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
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

    const blockReason = data.promptFeedback?.blockReason;
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const isBlocked = blockReason || finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT';

    if (isBlocked) {
        if (messages.length === 1) {
            return [{
                id: messages[0].id,
                category_ru: '🔴 ЗАБЛОКИРОВАНО — крайне серьёзное нарушение',
                category_en: 'Critical violation - content refused by AI safety filter',
                law_type: 'other',
                severity: 5,
                reason: `Сообщение содержит крайне серьёзный контент (${blockReason || finishReason}). Требует немедленной проверки.`
            }];
        }
        const mid = Math.ceil(messages.length / 2);
        const [left, right] = await Promise.all([
            analyzeChunk(messages.slice(0, mid), tosText, 1).catch((e) => { console.error('split-left error:', e.message); return []; }),
            analyzeChunk(messages.slice(mid), tosText, 1).catch((e) => { console.error('split-right error:', e.message); return []; })
        ]);
        return [...left, ...right];
    }

    const raw = candidate?.content?.parts?.map((p) => p.text).join('') || '[]';
    try { return JSON.parse(raw); } catch (e) { console.error('JSON parse error:', raw.slice(0, 300)); return []; }
}
// ====== ШАБЛОНЫ ЖАЛОБЫ ======
const COMPLAINT_TEMPLATES = [
    (ch, vl, desc) => `Dear Telegram Support Team,

I am writing to formally report a serious violation of both Telegram's Terms of Service and European Union law on the channel ${ch}.

The channel is engaged in ${desc}, as clearly evidenced by the post: ${vl}

This content violates Telegram's Terms of Service and is also prohibited under applicable EU legislation. I request that you investigate this matter immediately and take appropriate enforcement action, including removal of the content and suspension of the channel.

Thank you for your prompt attention to this serious matter.`,
    (ch, vl, desc) => `Dear Telegram Support Team,

I would like to report the channel ${ch} for violating Telegram's Terms of Service and European Union law.

The post ${vl} demonstrates ${desc}, which is a clear violation of both Telegram's policies and EU regulations.

Please review this content urgently and take necessary action against the channel. Thank you for your assistance.`,
    (ch, vl, desc) => `Dear Telegram Support Team,

This is a formal report regarding the channel ${ch}, which is in breach of Telegram's Terms of Service and European Union law.

A clear example of this violation can be found at ${vl}, where the channel engages in ${desc}.

I kindly request that you investigate this matter and take appropriate action against the channel as soon as possible.

Thank you for your prompt handling of this report.`
];

function buildComplaintFallback(channelLink, violationLink, categoryEn) {
    const desc = categoryEn ? categoryEn.trim() : "the publication of content that violates Telegram's policies and EU law";
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
    const prompt = `Напиши официальное письмо-жалобу на английском в поддержку Telegram ("Dear Telegram Support Team") о нарушении каналом одновременно:

1. Условий использования Telegram (Telegram ToS)
2. Законодательства Европейского Союза (EU law)

Канал: ${channelLink}
Пост-доказательство: ${violationLink}
Тип нарушения: ${violation.category_en || violation.category_ru}
Детали: ${violation.reason}

Требования:
- 3-4 коротких абзаца, формальный тон
- Обязательно укажи ссылку на канал и ссылку на пост-доказательство
- Чётко укажи, что нарушены И ToS Telegram, И EU law
- Не упоминай конкретные статьи законов (они пойдут отдельно)
- Заверши вежливой фразой
- В конце автоматически добавится "${EFFECTIVE_LINE}" — не пиши похожего сама

Верни ТОЛЬКО текст письма.`;

    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.7 }
        })
    });

    if (!res.ok) {
        const t = await res.text();
        throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`);
    }

    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text.trim()) throw new Error('Пустой ответ от нейросети');
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

// ====== АДМИНЫ ГРУППЫ ======
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
async function scanChannel(chatId, username, progressMsgId, selectedMode) {
    const scanStartedAt = Date.now();
    const client = await ensureMtClient();
    const entity = await client.getEntity(username);
    const channelLink = `https://t.me/${username}`;

    if (entity.className === 'User') {
        await bot.editMessageText(
            '❌ Это ссылка на профиль пользователя, а не на канал или группу.\n\n' +
            '📌 Пришли ссылку именно на канал или группу в формате:\n' +
            '<code>https://t.me/channelname</code>',
            { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
        );
        return;
    }

    const isGroup = entity.className === 'Chat' || (entity.className === 'Channel' && entity.megagroup);
    const isChannel = entity.className === 'Channel' && !entity.megagroup;

    if (selectedMode === 'channel' && isGroup) {
        await bot.editMessageText(
            '❌ Вы выбрали анализ канала, но ссылка ведёт на группу.\n\n' +
            '📌 Нажмите "◀️ В меню" и выберите "👥 Группа".',
            { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
        );
        return;
    }

    if (selectedMode === 'group' && !isGroup) {
        await bot.editMessageText(
            '❌ Вы выбрали анализ группы, но ссылка ведёт на канал.\n\n' +
            '📌 Нажмите "◀️ В меню" и выберите "📡 Канал".',
            { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
        );
        return;
    }

    const isGroupChat = isGroup;

    const rawMessages = await client.getMessages(entity, { limit: SCAN_LIMIT });
    let textMessages = rawMessages
        .filter((m) => m.message && m.message.trim().length > 0)
        .map((m) => ({
            id: m.id,
            text: m.message,
            isForwarded: !!m.fwdFrom,
            senderId: m.senderId != null ? Number(m.senderId) : null
        }));

    if (isGroupChat) {
        try {
            await bot.editMessageText(
                '👥 Это группа — определяю админов и создателя...\n' +
                '🔍 Буду проверять только сообщения администраторов.',
                { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
            );
        } catch (e) {}

        const adminIds = await getGroupAdminIds(client, entity);
        if (adminIds.size) {
            textMessages = textMessages.filter((m) => m.senderId !== null && adminIds.has(m.senderId));
        }
    }

    if (!textMessages.length) {
        await bot.editMessageText(
            isGroupChat
                ? '⚠️ Не нашлось текстовых сообщений от админов группы.'
                : '⚠️ В канале не нашлось текстовых сообщений.',
            { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
        );
        return;
    }

    const tosText = await getTelegramTos();

    const chunks = [];
    for (let i = 0; i < textMessages.length; i += CHUNK_SIZE) {
        chunks.push(textMessages.slice(i, i + CHUNK_SIZE));
    }

    const violations = [];
    const failedChunks = [];

    for (let i = 0; i < chunks.length; i++) {
        try {
            const results = await analyzeChunk(chunks[i], tosText);
            results.forEach((f) => violations.push(f));
        } catch (e) {
            console.error('analyzeChunk error:', e.message);
            failedChunks.push({ chunk: i + 1, error: e.message });
        }

        const done = Math.min((i + 1) * CHUNK_SIZE, textMessages.length);
        try {
            await bot.editMessageText(
                `🔍 <b>Сканирую ${isGroupChat ? 'группу' : 'канал'}</b>\n\n` +
                `${renderProgressBar(done, textMessages.length)}\n\n` +
                `📨 Проверено: <b>${done}/${textMessages.length}</b>\n` +
                `⚠️ Найдено нарушений: <b>${violations.length}</b>\n` +
                `⏱ ${formatElapsed(Date.now() - scanStartedAt)}`,
                { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
            );
        } catch (e) {}
    }

    try { await bot.deleteMessage(chatId, progressMsgId); } catch (e) {}

    if (!violations.length) {
        let text = `✅ Проверено ${textMessages.length} сообщений в ${channelLink}\n` +
                   `⚠️ Явных нарушений не найдено.\n` +
                   `⏱ Заняло: ${formatElapsed(Date.now() - scanStartedAt)}`;
        if (failedChunks.length) {
            text += `\n\n⚠️ ${failedChunks.length} из ${chunks.length} пачек не проверились.`;
        }
        await bot.sendMessage(chatId, text, {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] }
        });
        return;
    }

    violations.sort((a, b) => (b.severity || 0) - (a.severity || 0));
    const main = violations[0];
    const mainLink = `${channelLink}/${main.id}`;

    const genMsg = await bot.sendMessage(
        chatId,
        `🤖 <b>Готовлю жалобу</b> по самому серьёзному из ${violations.length} нарушений...`,
        { parse_mode: 'HTML' }
    );

    let linksText = `🔗 <b>Найденные нарушения — ${violations.length}</b> (по убыванию серьёзности)\n\n`;
    if (failedChunks.length) {
        linksText = `⚠️ <b>${failedChunks.length}/${chunks.length} пачек не проверились</b> — список может быть неполным.\n\n` + linksText;
    }

    violations.forEach((v, i) => {
        linksText += `${i + 1}. <a href="${channelLink}/${v.id}">${channelLink}/${v.id}</a>\n` +
                     `   📌 <b>${escapeHtml(v.category_ru || 'нарушение')}</b> (${v.severity || '?'}/5)\n` +
                     `   📝 ${escapeHtml(v.reason)}\n\n`;
    });

    for (let i = 0; i < linksText.length; i += 4000) {
        await bot.sendMessage(chatId, linksText.slice(i, i + 4000), { parse_mode: 'HTML' });
    }

    let complaintText;
    try {
        complaintText = await buildComplaint(channelLink, mainLink, main);
    } catch (e) {
        console.error('buildComplaint error:', e);
        complaintText = buildComplaintFallback(channelLink, mainLink, main.category_en);
    }

    try { await bot.deleteMessage(chatId, genMsg.message_id); } catch (e) {}

    await bot.sendMessage(
        chatId,
        `📋 <b>Жалоба</b> по самому серьёзному нарушению\n` +
        `(${escapeHtml(main.category_ru || '—')}, ${main.severity || '?'}/5)\n\n` +
        `👇 Нажми на текст, чтобы скопировать:`,
        { parse_mode: 'HTML' }
    );
    await bot.sendMessage(chatId, `<pre>${escapeHtml(complaintText)}</pre>`, { parse_mode: 'HTML' });

    const lawLinks = getLawLinks(main.law_type);
    const lawsText = lawLinks.map((l, i) => `${i + 1}. ${l}`).join('\n');
    await bot.sendMessage(
        chatId,
        '⚖️ <b>Законы EU</b> по типу нарушения:\n👇 Нажми на текст, чтобы скопировать:',
        { parse_mode: 'HTML' }
    );
    await bot.sendMessage(chatId, `<pre>${escapeHtml(lawsText)}</pre>`, { parse_mode: 'HTML' });

    let report = `${isGroupChat ? 'Группа' : 'Канал'}: ${channelLink}\n` +
                 `Проверено сообщений: ${textMessages.length}\n` +
                 `Найдено нарушений: ${violations.length}\n` +
                 `Время: ${formatElapsed(Date.now() - scanStartedAt)}\n\n`;

    report += '=== Нарушения ===\n';
    violations.forEach((v) => {
        report += `${channelLink}/${v.id} — [${v.category_ru}, ${v.severity}/5] ${v.reason}\n`;
    });

    report += '\n=== Жалоба ===\n\n' + complaintText + '\n\n=== Законы ===\n\n' + lawsText;

    const filePath = path.join('/tmp', `report_${username}_${Date.now()}.txt`);
    fs.writeFileSync(filePath, report, 'utf-8');
    await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });

    await bot.sendMessage(
        chatId,
        '✅ Готово!',
        {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] }
        }
    );
}

// ====== ТУТОРИАЛ ПО ОТПРАВКЕ ЖАЛОБЫ ======
function getTutorialText() {
    return `📋 <b>Как отправить жалобу на DSA платформу Telegram</b>\n\n` +
           `<b>Шаг 1:</b> Перейдите на сайт\n` +
           `<a href="https://telegram.org/dsa-report">https://telegram.org/dsa-report</a>\n` +
           `⚠️ <b>ВАЖНО:</b> Используйте VPN с сервером в <b>Нидерландах</b>\n\n` +
           `<b>Шаг 2:</b> Зарегистрируйтесь в аккаунт Telegram\n\n` +
           `<b>Шаг 3:</b> Введите ссылку на канал/группу с нарушениями\n` +
           `Пример: <code>https://t.me/channelname</code>\n\n` +
           `<b>Шаг 4:</b> Введите ссылку на конкретное нарушение\n` +
           `Пример: <code>https://t.me/channelname/123</code>\n\n` +
           `<b>Шаг 5:</b> Выберите причину жалобы из списка:\n` +
           `• Hate speech\n• Harassment\n• Child safety\n• Violence\n• Illegal goods\n• Privacy violation\n• Other\n\n` +
           `<b>Шаг 6:</b> Вставьте текст жалобы, который выдал бот\n\n` +
           `<b>Шаг 7:</b> Выберите страну — укажите, что вы репортите от <b>EU law</b>\n\n` +
           `<b>Шаг 8:</b> Вставьте ссылки на законы EU (их выдал бот)\n\n` +
           `<b>Шаг 9:</b> Пропустите пункт про документацию (скип)\n\n` +
           `<b>Шаг 10:</b> Подтвердите жалобу\n\n` +
           `✅ <b>Готово!</b> Жалоба отправлена.`;
}

// ====== КУЛДАУН И СОСТОЯНИЕ ======
const lastScanByUser = new Map();
const awaitingLink = new Map();

function checkCooldown(chatId) {
    const last = lastScanByUser.get(chatId) || 0;
    const remaining = SCAN_COOLDOWN_MS - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
}

function startMenuText() {
    return `🛡 <b>Channel Guard</b> — анализ Telegram-каналов и групп на нарушения\n\n` +
           `🔍 Проверяю через нейросеть на все виды нарушений:\n` +
           `• Условия использования Telegram (ToS)\n` +
           `• Законодательство Европейского Союза (EU law)\n\n` +
           `📋 Что получишь:\n` +
           `🔗 все нарушения со ссылками\n` +
           `📋 готовую жалобу (нажми, чтобы скопировать)\n` +
           `⚖️ ссылки на законы EU\n` +
           `📄 полный отчёт файлом\n\n` +
           `⏳ Проверка последних ${SCAN_LIMIT} сообщений занимает 1-5 минут\n` +
           `🔁 Кулдаун: ${Math.round(SCAN_COOLDOWN_MS / 60000)} мин на пользователя\n\n` +
           `📌 <b>Выберите тип:</b>`;
}

function startMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: '📡 Канал', callback_data: 'mode_channel' }, { text: '👥 Группа', callback_data: 'mode_group' }],
            [{ text: '📖 Как отправить жалобу на DSA', callback_data: 'tutorial' }],
            [{ text: '📖 Формат ссылки', callback_data: 'help_format' }]
        ]
    };
}

// ====== ХЕНДЛЕРЫ ======
bot.onText(/^\/start$/, (msg) => {
    awaitingLink.delete(msg.chat.id);
    bot.sendMessage(msg.chat.id, startMenuText(), {
        parse_mode: 'HTML',
        reply_markup: startMenuKeyboard()
    });
});

bot.on('callback_query', async (query) => {
    await bot.answerCallbackQuery(query.id);
    const chatId = query.message.chat.id;
    const messageId = query.message.message_id;
    const data = query.data;

    if (data === 'tutorial') {
        await bot.sendMessage(chatId, getTutorialText(), {
            parse_mode: 'HTML',
            reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'back_to_start' }]] }
        });
        return;
    }

    if (data === 'help_format') {
        await bot.sendMessage(
            chatId,
            '📌 <b>Правильный формат ссылки:</b>\n\n' +
            '✅ <code>https://t.me/channelname</code>\n' +
            '✅ <code>t.me/channelname</code>\n\n' +
            '❌ <b>НЕ принимается:</b>\n' +
            '• @username (без t.me/)\n' +
            '• имя человека\n' +
            '• ссылка на профиль\n\n' +
            '💡 Только полный URL с t.me/',
            { parse_mode: 'HTML' }
        );
        return;
    }

    if (data === 'back_to_start') {
        awaitingLink.delete(chatId);
        try {
            await bot.editMessageText(startMenuText(), {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: startMenuKeyboard()
            });
        } catch (e) {
            await bot.sendMessage(chatId, startMenuText(), {
                parse_mode: 'HTML',
                reply_markup: startMenuKeyboard()
            });
        }
        return;
    }

    if (data === 'mode_channel' || data === 'mode_group') {
        const mode = data === 'mode_channel' ? 'channel' : 'group';
        awaitingLink.set(chatId, { mode });
        const label = mode === 'channel' ? 'канал' : 'группу';

        await bot.editMessageText(
            `📎 Пришли ссылку на <b>${label}</b>\n\n` +
            `📌 Формат: <code>https://t.me/username</code>\n\n` +
            `⚠️ Бот проверит, что ссылка ведёт именно на ${label}.`,
            {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'back_to_start' }]] }
            }
        );
        return;
    }
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;

    const username = extractUsername(msg.text);
    if (!username) {
        await bot.sendMessage(
            chatId,
            '❌ <b>Неправильный формат ссылки</b>\n\n' +
            '📌 Только полный URL:\n' +
            '<code>https://t.me/username</code>\n' +
            '<code>t.me/username</code>\n\n' +
            '❌ Не принимается @username или имя человека.',
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] }
            }
        );
        return;
    }

    const remaining = checkCooldown(chatId);
    if (remaining > 0) {
        const mins = Math.ceil(remaining / 60000);
        await bot.sendMessage(
            chatId,
            `⏳ Подожди ещё <b>~${mins} мин</b> перед следующей проверкой.`,
            { parse_mode: 'HTML' }
        );
        return;
    }

    const chosenMode = awaitingLink.get(chatId)?.mode || null;
    if (!chosenMode) {
        await bot.sendMessage(
            chatId,
            '❌ Сначала выбери тип: 📡 Канал или 👥 Группа\n\nНажми /start для меню.',
            {
                parse_mode: 'HTML',
                reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] }
            }
        );
        return;
    }

    awaitingLink.delete(chatId);
    lastScanByUser.set(chatId, Date.now());

    const waitMsg = await bot.sendMessage(
        chatId,
        `🔌 <b>Подключаюсь к ${chosenMode === 'channel' ? 'каналу' : 'группе'}...</b>`,
        { parse_mode: 'HTML' }
    );

    try {
        await scanChannel(chatId, username, waitMsg.message_id, chosenMode);
    } catch (e) {
        console.error('scanChannel error:', e);
        await bot.editMessageText(
            `❌ <b>Ошибка:</b>\n\n${escapeHtml(e.message)}`,
            { chat_id: chatId, message_id: waitMsg.message_id, parse_mode: 'HTML' }
        );
    }
});
