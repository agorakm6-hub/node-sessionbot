// ============================================================
//  bot.js — анализ Telegram-каналов на утечки персональных данных
//  (личный инструмент: своя сессия + Gemini + отчёт с шаблоном жалобы)
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { TelegramClient } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const SESSION_STRING = process.env.SESSION_STRING || '';
const TG_API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const TG_API_HASH = process.env.TG_API_HASH || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
// Необязательно: если задать свой chat_id — бот будет отвечать только тебе.
// Если оставить пустым — бот открыт для всех (общая квота Gemini делится
// между всеми, кто им пользуется).
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID || 0);

if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }
if (!SESSION_STRING) { console.error('❌ Не задан SESSION_STRING.'); process.exit(1); }
if (!TG_API_ID || !TG_API_HASH) { console.error('❌ Не заданы TG_API_ID / TG_API_HASH.'); process.exit(1); }
if (!GEMINI_API_KEY) { console.error('❌ Не задан GEMINI_API_KEY.'); process.exit(1); }

const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
if (!EXTERNAL_URL) { console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.'); process.exit(1); }

// Модель зашита прямо в коде — чтобы поменять версию, правь только эту строку,
// без добавления отдельной env-переменной в Render.
const GEMINI_MODEL = 'gemini-1.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '300', 10); // сколько последних сообщений канала проверять
const CHUNK_SIZE = 40; // сколько сообщений за один запрос к Gemini
const GEMINI_MIN_INTERVAL_MS = 4200; // держим RPM в пределах бесплатного лимита (15/мин ≈ раз в 4с)

// Законы подобраны под конкретный law_type — присылаются отдельным
// сообщением, а не одним и тем же списком под любое нарушение.
const LAW_LINKS_BY_TYPE = {
    personal_data: [
        'https://gdpr-info.eu/art-6-gdpr/',
        'https://gdpr-info.eu/art-9-gdpr/'
    ],
    illegal_goods: [
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32021R0784'
    ],
    csam: [
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0093'
    ],
    terrorism_violence: [
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32021R0784'
    ],
    hate_speech: [
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2065'
    ],
    copyright: [
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32019L0790'
    ],
    malware_fraud: [
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32013L0040'
    ],
    other: [
        'https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:12012P/TXT#P8'
    ]
};
function lawsForType(lawType) {
    return LAW_LINKS_BY_TYPE[lawType] || LAW_LINKS_BY_TYPE.other;
}

// ====== БОТ / СЕРВЕР ======
const bot = new TelegramBot(BOT_TOKEN, { webHook: false });
console.log('🚀 Бот-анализатор каналов запущен (webhook)');

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

// ====== MTPROTO-КЛИЕНТ (одна сессия — твой аккаунт) ======
let mtClient = null;
let mtReady = false;
async function ensureMtClient() {
    if (mtReady && mtClient) return mtClient;
    mtClient = new TelegramClient(new StringSession(SESSION_STRING), TG_API_ID, TG_API_HASH, { connectionRetries: 3 });
    await mtClient.connect();
    mtReady = true;
    console.log('✅ MTProto-сессия подключена');
    return mtClient;
}

// ====== ОГРАНИЧЕНИЕ СКОРОСТИ ЗАПРОСОВ К GEMINI ======
let lastGeminiCall = 0;
async function throttleGemini() {
    const wait = GEMINI_MIN_INTERVAL_MS - (Date.now() - lastGeminiCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeminiCall = Date.now();
}

// ====== АНАЛИЗ ПАЧКИ СООБЩЕНИЙ ЧЕРЕЗ GEMINI ======
async function analyzeChunk(messages) {
    await throttleGemini();

    const listText = messages.map((m) => `[${m.id}] ${m.text.replace(/\n/g, ' ').slice(0, 500)}`).join('\n');
    const prompt = `Ты — модератор, проверяющий сообщения Telegram-канала на любые нарушения Условий использования Telegram и применимого законодательства (не только один тип нарушения, а все возможные), включая:
- публикацию личных данных людей без согласия ("пробив", доксинг): ФИО + телефон/паспорт/СНИЛС/ИНН/адрес/номер авто;
- продажу оружия, наркотиков, поддельных документов, other illegal goods;
- мошенничество и финансовые схемы обмана (скам);
- контент с сексуализацией несовершеннолетних;
- пропаганду терроризма или насилия;
- разжигание ненависти по признаку расы/религии/национальности и т.п.;
- массовое нарушение авторских прав (пиратский контент);
- вредоносное ПО/фишинговые ссылки;
- любые другие явные нарушения правил Telegram.

Проверь список сообщений ниже. Верни ТОЛЬКО JSON-массив (без markdown, без пояснений) вида:
[{"id": 123, "category_ru": "тип нарушения кратко на русском", "category_en": "короткая фраза ТОЛЬКО на английском языке (ни одного русского слова), описывающая суть нарушения в стиле юридической жалобы, например 'the publication of leaked personal data without consent'. СТРОГО запрещено упоминать в этой фразе название канала, юзернейм (@...) или ссылку t.me — только суть нарушения", "law_type": "personal_data|illegal_goods|csam|terrorism_violence|hate_speech|copyright|malware_fraud|other", "severity": 1-5, "reason": "краткая причина на русском"}]
severity: 5 — самое серьёзное (гарантированно ведёт к блокировке канала), 1 — незначительное.
Включай в массив только сообщения, которые ДЕЙСТВИТЕЛЬНО являются нарушением. Если нарушений нет — верни пустой массив [].

Сообщения:
${listText}`;

    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, responseMimeType: 'application/json' }
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '[]';
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error('Не удалось распарсить JSON от Gemini:', raw.slice(0, 300));
        return [];
    }
}

// ====== ЭКРАНИРОВАНИЕ ДЛЯ HTML (parse_mode: 'HTML') ======
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ====== ШАБЛОН ЖАЛОБЫ (только английский, без ссылок на законы внутри) ======

// На случай если Gemini всё же вставит юзернейм/ссылку канала в описание —
// вырезаем это перед подстановкой в шаблон.
function sanitizeDesc(text, username) {
    if (!text) return 'a serious violation of Telegram\'s Terms of Service';
    let clean = text
        .replace(/@[A-Za-z0-9_]{4,}/g, '')
        .replace(/t\.me\/[A-Za-z0-9_]+/gi, '')
        .replace(new RegExp(username, 'ig'), '')
        .replace(/\s{2,}/g, ' ')
        .trim();
    return clean || 'a serious violation of Telegram\'s Terms of Service';
}

// Несколько разных формулировок — при каждом отчёте выбирается случайная,
// чтобы жалобы не выглядели как одна и та же копипаста.
const COMPLAINT_TEMPLATES = [
    ({ channelLink, violationLink, desc }) => `Dear Telegram Support Team,

I am writing to report a violation of Telegram's Terms of Service found in the channel ${channelLink}. Specifically, the post ${violationLink} involves ${desc}.

I would appreciate it if your team could review this content and take appropriate action, up to and including removal of the offending post or the channel itself.

Thank you for your attention to this matter.`,

    ({ channelLink, violationLink, desc }) => `Hello Telegram Support,

I would like to report the channel ${channelLink} for content that appears to involve ${desc}. The specific post in question can be found here: ${violationLink}.

I believe this violates Telegram's Terms of Service and would ask that it be reviewed as soon as possible.

Thank you.`,

    ({ channelLink, violationLink, desc }) => `To the Telegram Support Team,

This is a report regarding a violation of Telegram's Terms of Service. The channel ${channelLink} has published content involving ${desc}, visible in this post: ${violationLink}.

I request that your team investigate this and take the necessary action.

Best regards.`,

    ({ channelLink, violationLink, desc }) => `Dear Telegram Support,

I'm reporting content that violates Telegram's Terms of Service. In the channel ${channelLink}, the post at ${violationLink} involves ${desc}. I'd like to bring this to your attention for review and appropriate action.

Thanks for looking into this.`
];

function buildComplaint(channelLink, violationLink, categoryEn, username) {
    const desc = sanitizeDesc(categoryEn, username).toLowerCase();
    const template = COMPLAINT_TEMPLATES[Math.floor(Math.random() * COMPLAINT_TEMPLATES.length)];
    return template({ channelLink, violationLink, desc });
}

// ====== ОТДЕЛЬНОЕ СООБЩЕНИЕ СО ССЫЛКАМИ НА ЗАКОНЫ ======
function buildLawsMessage(lawType) {
    const links = lawsForType(lawType);
    return links.map((l, i) => `${i + 1}. ${l}`).join('\n');
}

// ====== РАЗБОР ССЫЛКИ НА КАНАЛ ======
function extractUsername(text) {
    const m = text.trim().match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/i) || text.trim().match(/^@?([A-Za-z0-9_]{5,})$/);
    return m ? m[1] : null;
}

// ====== ОСНОВНОЙ АНАЛИЗ КАНАЛА ======
async function scanChannel(chatId, username, progressMsgId) {
    const client = await ensureMtClient();
    const entity = await client.getEntity(username);
    const channelLink = `https://t.me/${username}`;

    const rawMessages = await client.getMessages(entity, { limit: SCAN_LIMIT });
    const textMessages = rawMessages
        .filter((m) => m.message && m.message.trim().length > 0)
        .map((m) => ({ id: m.id, text: m.message }));

    if (!textMessages.length) {
        await bot.editMessageText('В канале не нашлось текстовых сообщений для проверки (возможно, только медиа без подписей).', { chat_id: chatId, message_id: progressMsgId });
        return;
    }

    const chunks = [];
    for (let i = 0; i < textMessages.length; i += CHUNK_SIZE) chunks.push(textMessages.slice(i, i + CHUNK_SIZE));

    const violations = [];
    for (let i = 0; i < chunks.length; i++) {
        try {
            const found = await analyzeChunk(chunks[i]);
            found.forEach((f) => violations.push(f));
        } catch (e) {
            console.error('analyzeChunk error:', e.message);
        }
        try {
            await bot.editMessageText(`⏳ Проверяю канал... ${Math.min((i + 1) * CHUNK_SIZE, textMessages.length)}/${textMessages.length} сообщений`, { chat_id: chatId, message_id: progressMsgId });
        } catch (e) {}
    }

    if (!violations.length) {
        await bot.editMessageText(`✅ Проверено ${textMessages.length} сообщений в ${channelLink} — явных нарушений не найдено.`, { chat_id: chatId, message_id: progressMsgId });
        return;
    }

    // самое серьёзное нарушение — первое в списке (для шаблона жалобы)
    violations.sort((a, b) => (b.severity || 0) - (a.severity || 0));
    const main = violations[0];
    const mainLink = `${channelLink}/${main.id}`;

    await bot.editMessageText(`⚠️ Найдено ${violations.length} нарушений в ${channelLink}. Присылаю ссылки и шаблон жалобы.`, { chat_id: chatId, message_id: progressMsgId });

    // ---- все ссылки на нарушения прямо в чат ----
    let linksText = `🔗 Все найденные нарушения (${violations.length}), отсортированы по серьёзности:\n\n`;
    violations.forEach((v, i) => {
        linksText += `${i + 1}. ${channelLink}/${v.id} — ${v.category_ru || 'нарушение'} (${v.severity || '?'}/5)\n   ${v.reason}\n\n`;
    });
    for (let i = 0; i < linksText.length; i += 3500) {
        await bot.sendMessage(chatId, linksText.slice(i, i + 3500));
    }

    // ---- шаблон жалобы: моноширинный блок Telegram — тап копирует целиком ----
    const complaintText = buildComplaint(channelLink, mainLink, main.category_en, username);
    await bot.sendMessage(chatId, `📋 Шаблон жалобы по самому серьёзному нарушению (${main.category_ru || '—'}, ${main.severity || '?'}/5) — нажми на текст ниже, чтобы скопировать:`);
    await bot.sendMessage(chatId, `<pre>${escapeHtml(complaintText)}</pre>`, { parse_mode: 'HTML' });

    // ---- законы: отдельным сообщением, отдельный моноширинный блок ----
    const lawsText = buildLawsMessage(main.law_type);
    await bot.sendMessage(chatId, '⚖️ Применимые нормы права (отдельно от шаблона, тоже можно скопировать):');
    await bot.sendMessage(chatId, `<pre>${escapeHtml(lawsText)}</pre>`, { parse_mode: 'HTML' });

    // ---- файл на память со всем отчётом целиком ----
    let report = `Отчёт по каналу: ${channelLink}\nПроверено сообщений: ${textMessages.length}\nНайдено нарушений: ${violations.length}\n\n`;
    report += '=== Все нарушения (по убыванию серьёзности) ===\n';
    violations.forEach((v) => { report += `${channelLink}/${v.id} — [${v.category_ru || '—'}, severity ${v.severity || '?'}/5] ${v.reason}\n`; });
    report += '\n=== Шаблон жалобы (по самому серьёзному нарушению) ===\n\n';
    report += complaintText;
    report += '\n\n=== Применимые законы ===\n\n';
    report += lawsText;

    const filePath = path.join('/tmp', `report_${username}_${Date.now()}.txt`);
    fs.writeFileSync(filePath, report, 'utf-8');
    await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
}

// ====== ДОСТУП: открыт для всех, если OWNER_CHAT_ID не задан ======
function isOwner(chatId) { return !OWNER_CHAT_ID || chatId === OWNER_CHAT_ID; }

// ====== КУЛДАУН НА ПОЛЬЗОВАТЕЛЯ (бот публичный, квота Gemini общая на всех) ======
const SCAN_COOLDOWN_MS = parseInt(process.env.SCAN_COOLDOWN_MINUTES || '10', 10) * 60 * 1000;
const lastScanByUser = new Map(); // chatId -> timestamp последнего запуска
function checkCooldown(chatId) {
    const last = lastScanByUser.get(chatId) || 0;
    const remaining = SCAN_COOLDOWN_MS - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
}

// ====== ХЕНДЛЕРЫ ======
bot.onText(/^\/start$/, (msg) => {
    if (!isOwner(msg.chat.id)) return;
    bot.sendMessage(msg.chat.id,
        `👋 Привет! Я анализирую Telegram-каналы на нарушения правил Telegram и законодательства.\n\n` +
        `📖 Как пользоваться:\n` +
        `Просто пришли ссылку на канал (например https://t.me/somechannel) — я проверю последние ${SCAN_LIMIT} сообщений через нейросеть и, если найдутся нарушения, пришлю все ссылки и готовый шаблон жалобы.\n\n` +
        `⏳ Проверка занимает время (от минуты до нескольких) — нейросеть проверяет сообщения пачками, с паузами под бесплатный лимит запросов.\n` +
        `🔁 Одна проверка на пользователя раз в ${Math.round(SCAN_COOLDOWN_MS / 60000)} мин — бот общий, квота нейросети одна на всех.`
    );
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    if (!isOwner(chatId)) return;

    const username = extractUsername(msg.text);
    if (!username) {
        await bot.sendMessage(chatId, '❌ Не понял ссылку. Пришли в формате https://t.me/channelname или @channelname');
        return;
    }

    const remaining = checkCooldown(chatId);
    if (remaining > 0) {
        const mins = Math.ceil(remaining / 60000);
        await bot.sendMessage(chatId, `⏳ Подожди ещё ~${mins} мин перед следующей проверкой — бот общий, квота нейросети одна на всех пользователей.`);
        return;
    }
    lastScanByUser.set(chatId, Date.now());

    const wait = await bot.sendMessage(chatId, '⏳ Подключаюсь и загружаю сообщения канала...');
    try {
        await scanChannel(chatId, username, wait.message_id);
    } catch (e) {
        console.error('scanChannel error:', e.message);
        await bot.editMessageText(`❌ Ошибка: ${e.message}`, { chat_id: chatId, message_id: wait.message_id });
    }
});
