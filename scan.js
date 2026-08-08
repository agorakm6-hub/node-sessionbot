// ============================================================
//  bot.js — анализ Telegram-каналов и групп на нарушения ToS/EU
//  v3: аналитика как в старой рабочей версии + новые функции
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TG_API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const TG_API_HASH = process.env.TG_API_HASH || '';

// Пул из нескольких сессий/ключей для скорости: SESSION_STRING_1..5 и
// GEMINI_API_KEY_1..5. Можно задать хоть одну пару — остальные необязательны,
// бот будет ротировать между тем, что реально указано.
function collectPool(prefix, single) {
    const pool = [];
    for (let i = 1; i <= 5; i++) {
        const v = process.env[`${prefix}_${i}`];
        if (v) pool.push(v);
    }
    if (!pool.length && single) pool.push(single);
    return pool;
}
const SESSION_STRINGS = collectPool('SESSION_STRING', process.env.SESSION_STRING);
const GEMINI_API_KEYS = collectPool('GEMINI_API_KEY', process.env.GEMINI_API_KEY);

if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }
if (!SESSION_STRINGS.length) { console.error('❌ Не задано ни одной SESSION_STRING (или SESSION_STRING_1..5).'); process.exit(1); }
if (!TG_API_ID || !TG_API_HASH) { console.error('❌ Не заданы TG_API_ID / TG_API_HASH.'); process.exit(1); }
if (!GEMINI_API_KEYS.length) { console.error('❌ Не задано ни одного GEMINI_API_KEY (или GEMINI_API_KEY_1..5).'); process.exit(1); }
console.log(`🔑 Сессий: ${SESSION_STRINGS.length}, ключей Gemini: ${GEMINI_API_KEYS.length}`);

const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
if (!EXTERNAL_URL) { console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.'); process.exit(1); }

const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';
function geminiUrlFor(key) { return `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${key}`; }

const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '100', 10);
const CHUNK_SIZE = parseInt(process.env.SCAN_CHUNK_SIZE || '20', 10); // сообщений в одном запросе к Gemini — пачками быстрее, чем по одному
const GEMINI_MIN_INTERVAL_MS = 4200; // пауза НА ОДИН ключ — с 5 ключами это x5 к скорости, см. параллельный воркер-пул ниже
const SCAN_COOLDOWN_MS = parseInt(process.env.SCAN_COOLDOWN_MINUTES || '10', 10) * 60 * 1000;

// Сколько сообщений обрабатывать ОДНОВРЕМЕННО — по числу независимых ключей Gemini
// (у каждого ключа свой троттлинг, так что параллельность реально ускоряет скан,
// а не просто крутит один и тот же ключ по кругу).
const SCAN_CONCURRENCY = Math.max(1, GEMINI_API_KEYS.length);

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
    // ====== АНТИ-СЛИП: отдельный /health для само-пинга (см. keepAliveLoop ниже) ======
    if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', bot: 'running' }));
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
    keepAliveLoop();
});

// ====== АНТИ-СЛИП (порт из moder.py: бесплатный Render засыпает без входящего трафика — сами себя пингуем) ======
async function keepAliveLoop() {
    const url = `${EXTERNAL_URL}/health`;
    await new Promise((r) => setTimeout(r, 10000));
    while (true) {
        let success = false;
        for (let attempt = 1; attempt <= 3 && !success; attempt++) {
            try {
                const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
                console.log(`🔄 Keep-alive пинг: ${res.status}`);
                success = true;
            } catch (e) {
                console.warn(`⚠️ Keep-alive пинг не удался (попытка ${attempt}/3): ${e.message}`);
                await new Promise((r) => setTimeout(r, 5000));
            }
        }
        if (!success) console.error('❌ Keep-alive: все попытки пинга провалились в этом цикле');
        await new Promise((r) => setTimeout(r, 150000)); // раз в 2.5 мин — держит бесплатный Render живым
    }
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

// ====== РОТАЦИЯ КЛЮЧЕЙ GEMINI (независимый троттлинг на каждый ключ) ======
const geminiLastCall = new Map();
let geminiRoundRobin = 0;
function pickGeminiKey() {
    const key = GEMINI_API_KEYS[geminiRoundRobin % GEMINI_API_KEYS.length];
    geminiRoundRobin++;
    return key;
}
async function throttleGemini(key) {
    const last = geminiLastCall.get(key) || 0;
    const wait = GEMINI_MIN_INTERVAL_MS - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    geminiLastCall.set(key, Date.now());
}

// ====== РОТАЦИЯ СЕССИЙ (пул MTProto-клиентов) ======
const mtClients = new Array(SESSION_STRINGS.length).fill(null);
const mtReady = new Array(SESSION_STRINGS.length).fill(false);
let sessionRoundRobin = 0;
async function ensureMtClientAt(idx) {
    if (mtReady[idx] && mtClients[idx]) return mtClients[idx];
    const client = new TelegramClient(new StringSession(SESSION_STRINGS[idx]), TG_API_ID, TG_API_HASH, { connectionRetries: 3 });
    await client.connect();
    mtClients[idx] = client;
    mtReady[idx] = true;
    console.log(`✅ MTProto-сессия #${idx + 1} подключена`);
    return client;
}
async function pickMtClient() {
    const idx = sessionRoundRobin % SESSION_STRINGS.length;
    sessionRoundRobin++;
    return ensureMtClientAt(idx);
}

// ====== АНАЛИЗ ОДНОЙ ПАЧКИ СООБЩЕНИЙ (промпт и логика — как в проверенной рабочей версии) ======
async function analyzeChunk(messages, tosText, attempt = 1) {
    const MAX_ATTEMPTS = 4;
    const key = pickGeminiKey();
    await throttleGemini(key);

    const listText = messages.map((m) => {
        const fwdTag = m.isForwarded ? '[ПЕРЕСЛАНО] ' : '';
        return `[${m.id}] ${fwdTag}${m.text.replace(/\n/g, ' ').slice(0, 500)}`;
    }).join('\n');

    const prompt = `Ты — тщательный модератор, разбирающий ПАЧКУ сообщений Telegram-канала/группы (список ниже, каждое со своим [id]) построчно на нарушения официальных Условий использования Telegram (текст ниже) и применимого законодательства EU. Анализируй КАЖДОЕ сообщение из пачки отдельно и независимо от остальных — не пропускай ни одно. Не спеши с выводом "нарушений нет" — сначала обдумай каждое сообщение по каждому пункту ниже, включая:
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

Верни ТОЛЬКО JSON-массив по одному объекту на КАЖДОЕ сообщение с нарушением (без markdown, без объектов для чистых сообщений):
[{"id":123,"category_ru":"тип на русском","category_en":"короткая EN-фраза для репорта, без имени канала","law_type":"personal_data|illegal_goods|csam|terrorism_violence|hate_speech|copyright|malware_fraud|other","severity":1-5,"reason":"причина на русском"}]
severity 5 = гарантированный бан. Если нарушений нет ни в одном сообщении пачки — верни [].

Сообщения (${messages.length} шт., проверь каждое):
${listText}`;

    const res = await fetch(geminiUrlFor(key), {
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

    const blockReason = data.promptFeedback?.blockReason;
    const candidate = data.candidates?.[0];
    const finishReason = candidate?.finishReason;
    const isBlocked = blockReason || finishReason === 'SAFETY' || finishReason === 'PROHIBITED_CONTENT';

    if (isBlocked) {
        if (messages.length === 1) {
            return [{
                id: messages[0].id,
                category_ru: 'заблокировано нейросетью как крайне серьёзное',
                category_en: 'content severe enough that automated review refused to process it',
                law_type: 'other',
                severity: 5,
                reason: `Gemini отказался анализировать это сообщение (${blockReason || finishReason}) — обычно означает содержимое максимальной степени тяжести. Проверь вручную и сразу.`
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

// ====== ПАРАЛЛЕЛЬНАЯ ОБРАБОТКА ПАЧЕК (воркер-пул размером с число ключей Gemini) ======
// Раньше пачки анализировались строго одна за одной (await в цикле), поэтому
// даже с 5 ключами реально работал только один запрос за раз. Здесь запускается
// SCAN_CONCURRENCY параллельных "воркеров", каждый со своим независимым троттлингом
// по ключу — итоговая скорость реально растёт кратно числу ключей.
async function processChunksInParallel(chunks, tosText, onProgress) {
    const violations = [];
    const failedChunks = [];
    let nextIndex = 0;
    let completed = 0;
    let lastEditAt = 0;

    async function reportProgress(force = false) {
        const now = Date.now();
        if (!force && now - lastEditAt < 1200) return; // не спамим editMessageText
        lastEditAt = now;
        await onProgress(completed, violations.length);
    }

    async function worker() {
        while (true) {
            const i = nextIndex++;
            if (i >= chunks.length) return;
            try {
                (await analyzeChunk(chunks[i], tosText)).forEach((f) => violations.push(f));
            } catch (e) {
                console.error('analyzeChunk error:', e.message);
                failedChunks.push({ chunk: i + 1, error: e.message });
            }
            completed += chunks[i].length; // считаем СООБЩЕНИЯ в пачке, а не саму пачку
            await reportProgress();
        }
    }

    const workerCount = Math.min(SCAN_CONCURRENCY, chunks.length) || 1;
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await reportProgress(true); // финальное обновление — гарантированно 100%
    return { violations, failedChunks };
}

// ====== ПРОГРЕСС-БАР (без квадратных скобок, жирный) ======
function renderProgressBar(current, total, width = 20) {
    const ratio = total > 0 ? Math.min(1, current / total) : 0;
    const filled = Math.round(ratio * width);
    const bar = '●'.repeat(filled) + '○'.repeat(Math.max(0, width - filled));
    return `${bar}  ${Math.min(100, Math.round(ratio * 100))}%`;
}
function formatElapsed(ms) {
    const sec = Math.round(ms / 1000);
    return sec < 60 ? `${sec}с` : `${Math.floor(sec / 60)}м ${sec % 60}с`;
}
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ====== ЗАПАСНЫЕ ШАБЛОНЫ РЕПОРТА ======
const REPORT_TEMPLATES = [
    (ch, vl, desc) => `Dear Telegram Support Team,\n\nI am writing to report a serious violation of Telegram's Terms of Service and applicable European Union law on the channel ${ch}. The channel is engaged in ${desc}, as evidenced by the post ${vl}.\n\nThis content is unacceptable and requires immediate attention. I urge you to investigate this matter promptly and take appropriate action, including removal of the content and/or suspension of the channel.\n\nThank you for your swift response.`,
    (ch, vl, desc) => `Dear Telegram Support Team,\n\nI would like to report the channel ${ch} for violating both Telegram's Terms of Service and European Union law. The post ${vl} clearly demonstrates ${desc}.\n\nI kindly request that you review this content as a matter of urgency and take the necessary enforcement action against the channel.\n\nThank you for your attention to this matter.`,
    (ch, vl, desc) => `Dear Telegram Support Team,\n\nThis is a formal report regarding the channel ${ch}, which is in breach of Telegram's Terms of Service and European Union law through ${desc}. A clear example of this can be found at ${vl}.\n\nPlease investigate this matter and take appropriate action against the channel as soon as possible.\n\nI appreciate your prompt handling of this report.`
];
function buildReportFallback(channelLink, violationLink, categoryEn) {
    const desc = categoryEn ? categoryEn.trim() : "the publication of content that violates Telegram's policies";
    const template = REPORT_TEMPLATES[Math.floor(Math.random() * REPORT_TEMPLATES.length)];
    return template(channelLink, violationLink, desc);
}

const EFFECTIVE_LINE = "Please immediately investigate and take action for violating EU law and Telegram's Terms of Service.";
function insertBeforeClosing(text) {
    if (text.includes(EFFECTIVE_LINE)) return text;
    const idx = text.lastIndexOf('\n\n');
    return idx === -1 ? `${text}\n\n${EFFECTIVE_LINE}` : `${text.slice(0, idx)}\n\n${EFFECTIVE_LINE}${text.slice(idx)}`;
}

async function generateReportViaAI(channelLink, violationLink, violation) {
    const key = pickGeminiKey();
    await throttleGemini(key);
    const prompt = `Напиши короткий официальный репорт-письмо на английском в поддержку Telegram ("Dear Telegram Support Team") про нарушение конкретным каналом одновременно и Условий использования Telegram, и применимого законодательства EU — явно укажи в тексте оба этих основания (Telegram ToS И EU law), а не только одно.

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
    const res = await fetch(geminiUrlFor(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0.9 } })
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`); }
    const data = await res.json();
    const text = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text.trim()) throw new Error('Пустой ответ от нейросети при генерации репорта.');
    return text.trim();
}

async function buildReport(channelLink, violationLink, violation) {
    let text;
    try {
        text = await generateReportViaAI(channelLink, violationLink, violation);
    } catch (e) {
        console.error('generateReportViaAI error, использую запасной шаблон:', e.message);
        text = buildReportFallback(channelLink, violationLink, violation.category_en);
    }
    return insertBeforeClosing(text);
}

// ====== РАЗБОР ССЫЛКИ: публичный юзернейм ИЛИ приватный инвайт (+hash / joinchat) ======
function parseLink(text) {
    const raw = text.trim();
    let m = raw.match(/^(?:https?:\/\/)?t\.me\/\+([A-Za-z0-9_-]{10,64})\/?$/i);
    if (m) return { type: 'invite', hash: m[1] };
    m = raw.match(/^(?:https?:\/\/)?t\.me\/joinchat\/([A-Za-z0-9_-]{10,64})\/?$/i);
    if (m) return { type: 'invite', hash: m[1] };
    m = raw.match(/^(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]{4,32})\/?$/i);
    if (m) return { type: 'username', username: m[1] };
    return null;
}

// ====== ПРИВАТНЫЕ КАНАЛЫ ПО ИНВАЙТ-ССЫЛКЕ (в т.ч. с заявкой на вступление) ======
// Возвращает { entity, pending } — pending=true значит заявка отправлена, но
// ещё не одобрена админом, сканировать пока нельзя.
async function resolveInviteEntity(client, hash) {
    let invite;
    try {
        invite = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
    } catch (e) {
        throw new Error(`Ссылка недействительна или устарела (${e.message})`);
    }

    // Уже участник — сразу отдаём chat
    if (invite.className === 'ChatInviteAlready' || invite.className === 'ChatInvitePeek') {
        return { entity: invite.chat, pending: false };
    }

    // Ещё не в канале — пробуем вступить/отправить заявку
    try {
        const result = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
        const chat = result.chats?.[0];
        return { entity: chat, pending: false };
    } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes('INVITE_REQUEST_SENT')) {
            return { entity: null, pending: true };
        }
        if (msg.includes('USER_ALREADY_PARTICIPANT')) {
            const invite2 = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
            if (invite2.chat) return { entity: invite2.chat, pending: false };
        }
        throw new Error(`Не удалось вступить по инвайт-ссылке (${msg})`);
    }
}

// ====== АДМИНЫ ГРУППЫ (за обычных участников группу не банят) ======
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

// ====== ОСНОВНОЙ АНАЛИЗ (канал/группа, публичные и приватные — автоопределение) ======
async function scanChannel(chatId, link, progressMsgId, mode) {
    const scanStartedAt = Date.now();
    const client = await pickMtClient();

    let entity;
    let username; // для отображаемой ссылки и имени файла отчёта

    if (link.type === 'invite') {
        await bot.editMessageText('🔐 Приватная ссылка — пытаюсь получить доступ к каналу/группе...', { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' });
        const { entity: e, pending } = await resolveInviteEntity(client, link.hash);
        if (pending) {
            await bot.editMessageText(
                '📨 Это канал с заявками на вступление — заявка отправлена автоматически.\n' +
                'Как только администратор её одобрит, пришли ссылку ещё раз — тогда смогу просканировать.',
                { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
            );
            return;
        }
        entity = e;
        username = entity?.username || `private_${link.hash.slice(0, 8)}`;
    } else {
        entity = await client.getEntity(link.username);
        username = link.username;
    }

    const channelLink = link.type === 'invite'
        ? (entity?.username ? `https://t.me/${entity.username}` : `https://t.me/+${link.hash}`)
        : `https://t.me/${username}`;

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

    const { violations, failedChunks } = await processChunksInParallel(chunks, tosText, async (done, violCount) => {
        try {
            await bot.editMessageText(
                `🔍 <b>Сканирую ${isGroupChat ? 'группу' : 'канал'}</b>\n\n` +
                `<b>${renderProgressBar(done, textMessages.length)}</b>\n\n` +
                `📨 Проверено: <b>${done}/${textMessages.length}</b>\n⚠️ Найдено нарушений: <b>${violCount}</b>\n⏱ Время: <b>${formatElapsed(Date.now() - scanStartedAt)}</b>`,
                { chat_id: chatId, message_id: progressMsgId, parse_mode: 'HTML' }
            );
        } catch (e) {}
    });

    try { await bot.deleteMessage(chatId, progressMsgId); } catch (e) {}

    if (!violations.length) {
        let text = `✅ Проверено ${textMessages.length} сообщений в ${channelLink} — явных нарушений не найдено.\n⏱ Заняло: ${formatElapsed(Date.now() - scanStartedAt)}`;
        if (failedChunks.length) text += `\n\n⚠️ ${failedChunks.length} из ${chunks.length} пачек не проверились. Причина: ${failedChunks[0].error}`;
        await bot.sendMessage(chatId, text, { reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] } });
        return;
    }

    violations.sort((a, b) => (b.severity || 0) - (a.severity || 0) || (a.id || 0) - (b.id || 0));
    const main = violations[0];
    const mainLink = `${channelLink}/${main.id}`;

    const genMsg = await bot.sendMessage(chatId, `🤖 <b>Готовлю репорт</b> под самое серьёзное из ${violations.length} нарушений...`, { parse_mode: 'HTML' });

    let linksText = `🔗 <b>Найденные нарушения — ${violations.length}</b> (по убыванию серьёзности)\n\n`;
    if (failedChunks.length) linksText = `⚠️ <b>${failedChunks.length}/${chunks.length} пачек не проверились</b> — список может быть неполным.\n\n` + linksText;
    violations.forEach((v, i) => { linksText += `${i + 1}. ${channelLink}/${v.id} — <b>${escapeHtml(v.category_ru || 'нарушение')}</b> (${v.severity || '?'}/5)\n   ${escapeHtml(v.reason)}\n\n`; });
    for (let i = 0; i < linksText.length; i += 3500) await bot.sendMessage(chatId, linksText.slice(i, i + 3500), { parse_mode: 'HTML' });

    const reportText = await buildReport(channelLink, mainLink, main);
    try { await bot.deleteMessage(chatId, genMsg.message_id); } catch (e) {}
    await bot.sendMessage(chatId, `📋 <b>Репорт</b> по самому серьёзному нарушению (${escapeHtml(main.category_ru || '—')}, ${main.severity || '?'}/5) — нажми на текст, чтобы скопировать:`, { parse_mode: 'HTML' });
    await bot.sendMessage(chatId, `<pre>${escapeHtml(reportText)}</pre>`, { parse_mode: 'HTML' });

    const lawLinks = getLawLinks(main.law_type);
    const lawsText = lawLinks.map((l, i) => `${i + 1}. ${l}`).join('\n');
    await bot.sendMessage(chatId, '⚖️ <b>Законы EU</b> по типу нарушения — отдельно, тоже копируется нажатием:', { parse_mode: 'HTML' });
    await bot.sendMessage(chatId, `<pre>${escapeHtml(lawsText)}</pre>`, { parse_mode: 'HTML' });

    let report = `${isGroupChat ? 'Группа' : 'Канал'}: ${channelLink}\nПроверено сообщений: ${textMessages.length}\nНайдено нарушений: ${violations.length}\nВремя: ${formatElapsed(Date.now() - scanStartedAt)}\n\n`;
    report += '=== Нарушения ===\n';
    violations.forEach((v) => { report += `${channelLink}/${v.id} — [${v.category_ru}, ${v.severity}/5] ${v.reason}\n`; });
    report += '\n=== Репорт ===\n\n' + reportText + '\n\n=== Законы ===\n\n' + lawsText;
    const filePath = path.join('/tmp', `report_${username}_${Date.now()}.txt`);
    fs.writeFileSync(filePath, report, 'utf-8');
    await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
    await bot.sendMessage(chatId, 'Готово ✅', { reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] } });
}

// ====== КУЛДАУН НА ПОЛЬЗОВАТЕЛЯ ======
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
        `Что получишь:\n🔗 все нарушения со ссылками\n📋 готовый репорт (нажми, чтобы скопировать)\n⚖️ ссылки на законы EU\n📄 полный отчёт файлом\n\n` +
        `📡 Поддерживаются и приватные каналы/группы по инвайт-ссылке (<code>t.me/+xxxx</code>) — если канал требует заявку на вступление, бот отправит её автоматически.\n\n` +
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
        await bot.sendMessage(chatId,
            'Публичный канал/группа:\n<code>https://t.me/channelname</code>\n<code>t.me/channelname</code>\n\n' +
            'Приватный канал/группа по инвайту:\n<code>https://t.me/+xxxxxxxxxxx</code>\n<code>https://t.me/joinchat/xxxxxxxxxxx</code>\n\n' +
            '❌ Просто @юзернейм или имя человека не подойдёт — так реже путают канал с профилем человека.',
            { parse_mode: 'HTML' });
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
            `📎 Пришли ссылку на ${label}, например <code>https://t.me/name</code> или приватную <code>https://t.me/+xxxx</code>`,
            { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ Назад', callback_data: 'back_to_start' }]] } }
        );
        return;
    }
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;

    const link = parseLink(msg.text);
    if (!link) {
        await bot.sendMessage(chatId,
            '❌ Нужна полная ссылка формата <code>https://t.me/name</code> (или приватная <code>https://t.me/+xxxx</code>) — просто @юзернейм или имя не подойдёт.',
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ text: '◀️ В меню', callback_data: 'back_to_start' }]] } });
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
        await scanChannel(chatId, link, wait.message_id, chosenMode);
    } catch (e) {
        console.error('scanChannel error:', e.message);
        await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
    }
});
