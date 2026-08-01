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
const OWNER_CHAT_ID = Number(process.env.OWNER_CHAT_ID || 0);

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

// ====== MTPROTO-КЛИЕНТ ======
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

// ====== ОГРАНИЧЕНИЕ СКОРОСТИ ======
let lastGeminiCall = 0;
async function throttleGemini() {
    const wait = GEMINI_MIN_INTERVAL_MS - (Date.now() - lastGeminiCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeminiCall = Date.now();
}

// ====== АНАЛИЗ ПАЧКИ СООБЩЕНИЙ ======
async function analyzeChunk(messages) {
    await throttleGemini();

    const listText = messages.map((m) => `[${m.id}] ${m.text.replace(/\n/g, ' ').slice(0, 500)}`).join('\n');
    const prompt = `Ты — модератор, проверяющий сообщения Telegram-канала на любые нарушения Условий использования Telegram и применимого законодательства. Проверь список сообщений ниже. Верни ТОЛЬКО JSON-массив (без markdown, без пояснений) вида:
[{"id": 123, "category_ru": "тип нарушения кратко на русском", "severity": 1-5, "reason": "краткая причина на русском"}]
severity: 5 — самое серьёзное, 1 — незначительное.
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

// ====== ГЕНЕРАЦИЯ ШАБЛОНА ЖАЛОБЫ И ЗАКОНОВ ЧЕРЕЗ GEMINI ======
async function generateComplaintAndLaws(channelLink, violationLink, violation) {
    await throttleGemini();

    const prompt = `Ты — юридический помощник. На основе информации о нарушении в Telegram-канале сгенерируй:

1. Шаблон жалобы в поддержку Telegram на английском языке. Жалоба должна быть официальной, вежливой, содержать:
   - Описание конкретного нарушения (что именно публикуется)
   - Ссылку на канал (${channelLink})
   - Ссылку на конкретное сообщение с нарушением (${violationLink})
   - Указание, какие именно правила Telegram нарушены
   - Просьбу принять меры

2. Список из не более 3 законов Европейского Союза, которые нарушены в данном конкретном случае. Законы должны быть реальными и соответствовать нарушению. Если подходит меньше 3 законов — укажи только релевантные, но минимум 1. Формат: каждая ссылка на новой строке.

Нарушение: ${violation.category_ru} (${violation.reason})

Верни ТОЛЬКО JSON-объект (без markdown, без пояснений) вида:
{
  "complaint": "текст жалобы на английском",
  "laws": ["ссылка1", "ссылка2", "ссылка3"]
}`;

    const res = await fetch(GEMINI_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.3, responseMimeType: 'application/json' }
        })
    });

    if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '{"complaint":"","laws":[]}';
    try {
        return JSON.parse(raw);
    } catch (e) {
        console.error('Не удалось распарсить JSON от Gemini:', raw.slice(0, 300));
        return { complaint: '', laws: [] };
    }
}

// ====== ЭКРАНИРОВАНИЕ ======
function escapeHtml(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// ====== РАЗБОР ССЫЛКИ ======
function extractUsername(text) {
    const m = text.trim().match(/(?:https?:\/\/)?t\.me\/([A-Za-z0-9_]+)/i) || text.trim().match(/^@?([A-Za-z0-9_]{5,})$/);
    return m ? m[1] : null;
}

// ====== ОСНОВНОЙ АНАЛИЗ ======
async function scanChannel(chatId, username, progressMsgId) {
    const client = await ensureMtClient();
    const entity = await client.getEntity(username);
    const channelLink = `https://t.me/${username}`;

    const rawMessages = await client.getMessages(entity, { limit: SCAN_LIMIT });
    const textMessages = rawMessages
        .filter((m) => m.message && m.message.trim().length > 0)
        .map((m) => ({ id: m.id, text: m.message }));

    if (!textMessages.length) {
        await bot.editMessageText('В канале не нашлось текстовых сообщений для проверки.', { chat_id: chatId, message_id: progressMsgId });
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

    violations.sort((a, b) => (b.severity || 0) - (a.severity || 0));
    const main = violations[0];
    const mainLink = `${channelLink}/${main.id}`;

    await bot.editMessageText(`⚠️ Найдено ${violations.length} нарушений в ${channelLink}. Генерирую шаблоны жалоб...`, { chat_id: chatId, message_id: progressMsgId });

    // ---- ВСЕ ССЫЛКИ НА НАРУШЕНИЯ ----
    let linksText = `🔗 Все найденные нарушения (${violations.length}), отсортированы по серьёзности:\n\n`;
    violations.forEach((v, i) => {
        linksText += `${i + 1}. ${channelLink}/${v.id} — ${v.category_ru || 'нарушение'} (${v.severity || '?'}/5)\n   ${v.reason || ''}\n\n`;
    });
    for (let i = 0; i < linksText.length; i += 3500) {
        await bot.sendMessage(chatId, linksText.slice(i, i + 3500));
    }

    // ---- ГЕНЕРИРУЕМ ШАБЛОН ДЛЯ САМОГО СЕРЬЁЗНОГО НАРУШЕНИЯ ----
    const result = await generateComplaintAndLaws(channelLink, mainLink, main);

    // ---- ОТПРАВЛЯЕМ ШАБЛОН ЖАЛОБЫ ----
    if (result.complaint) {
        await bot.sendMessage(chatId, `📋 Шаблон жалобы для нарушения: ${main.category_ru} (нажми на текст ниже, чтобы скопировать):`);
        await bot.sendMessage(chatId, `<pre>${escapeHtml(result.complaint)}</pre>`, { parse_mode: 'HTML' });
    }

    // ---- ОТПРАВЛЯЕМ ЗАКОНЫ (если есть) ----
    if (result.laws && result.laws.length > 0) {
        const lawsText = `📜 Соответствующие законы для данного нарушения:\n\n${result.laws.map((l, i) => `${i + 1}. ${l}`).join('\n')}`;
        await bot.sendMessage(chatId, `📜 Законы (нажми на текст ниже, чтобы скопировать):`);
        await bot.sendMessage(chatId, `<pre>${escapeHtml(lawsText)}</pre>`, { parse_mode: 'HTML' });
    }

    // ---- ФАЙЛ С ОТЧЁТОМ ----
    let report = `Отчёт по каналу: ${channelLink}\nПроверено сообщений: ${textMessages.length}\nНайдено нарушений: ${violations.length}\n\n`;
    report += '=== Все нарушения (по убыванию серьёзности) ===\n';
    violations.forEach((v) => { report += `${channelLink}/${v.id} — [${v.category_ru || '—'}, severity ${v.severity || '?'}/5] ${v.reason || ''}\n`; });
    report += '\n=== Шаблон жалобы (для самого серьёзного нарушения) ===\n\n';
    report += result.complaint || 'Не удалось сгенерировать';
    report += '\n\n=== Законы ===\n\n';
    report += result.laws?.map((l) => `• ${l}`).join('\n') || 'Не найдено';

    const filePath = path.join('/tmp', `report_${username}_${Date.now()}.txt`);
    fs.writeFileSync(filePath, report, 'utf-8');
    await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
}

// ====== ДОСТУП ======
function isOwner(chatId) { return !OWNER_CHAT_ID || chatId === OWNER_CHAT_ID; }

// ====== КУЛДАУН ======
const SCAN_COOLDOWN_MS = parseInt(process.env.SCAN_COOLDOWN_MINUTES || '10', 10) * 60 * 1000;
const lastScanByUser = new Map();
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
