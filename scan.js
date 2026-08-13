// ============================================================
//  bot.js — анализ Telegram-каналов и групп на нарушения ToS/EU
//  v5: цветные кнопки (Bot API 9.4 style), стоп-кнопка на скане,
//      авто-очистка сообщений при "Назад", кулдаун алертом,
//      честный скан админов группы, промпт про "снос"
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { TelegramClient, Api } = require('teleproto');
const { StringSession } = require('teleproto/sessions');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
const TG_API_ID = parseInt(process.env.TG_API_ID || '0', 10);
const TG_API_HASH = process.env.TG_API_HASH || '';

// ID админа — захардкожен по запросу, чтобы не добавлять новую env-переменную на Render.
const ADMIN_ID = 6811074441;

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

// ====== MINI APP ======
const MINI_APP_URL = `${EXTERNAL_URL}/app`;
const MINI_APP_PATH = fs.existsSync(path.join(__dirname, 'miniapp.html')) ? path.join(__dirname, 'miniapp.html') : null;
let miniAppHtmlCache = null;
function getMiniAppHtml() {
    if (!MINI_APP_PATH) return '<h1>miniapp.html не найден рядом со скриптом бота</h1>';
    if (!miniAppHtmlCache) miniAppHtmlCache = fs.readFileSync(MINI_APP_PATH, 'utf-8');
    return miniAppHtmlCache;
}

// Проверка initData от Telegram Mini App — HMAC-подпись по алгоритму из
// официальной документации. Без этого шага любой мог бы прислать чужой user id.
function validateInitData(initData) {
    try {
        if (!initData || typeof initData !== 'string') return null;
        const params = new URLSearchParams(initData);
        const hash = params.get('hash');
        if (!hash) return null;
        params.delete('hash');
        const pairs = [];
        for (const [k, v] of params.entries()) pairs.push(`${k}=${v}`);
        pairs.sort();
        const dataCheckString = pairs.join('\n');
        const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
        const computedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
        if (computedHash !== hash) return null;
        const authDate = Number(params.get('auth_date') || '0');
        if (Date.now() / 1000 - authDate > 86400) return null; // старше суток — просрочено, перезайди в апп
        const userJson = params.get('user');
        return userJson ? JSON.parse(userJson) : null;
    } catch (e) {
        console.error('validateInitData error:', e.message);
        return null;
    }
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => { try { resolve(body ? JSON.parse(body) : {}); } catch (e) { reject(e); } });
        req.on('error', reject);
    });
}

// jobId -> { status, done, total, violCount, userId, abortFlag, result, message, createdAt }
const jobs = new Map();
setInterval(() => { // подчищаем задачи старше часа, чтобы не текла память
    const cutoff = Date.now() - 3600000;
    for (const [id, job] of jobs.entries()) if (job.createdAt < cutoff) jobs.delete(id);
}, 600000);

async function handleApiRequest(req, res, pathname, parsedUrl) {
    function sendJson(status, obj) {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(obj));
    }
    try {
        if (pathname === '/api/me' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            touchUser(user, user.id);
            const u = ensureDailyReset(user.id);
            return sendJson(200, {
                id: user.id, username: user.username || null, firstName: user.first_name || null,
                banned: isBanned(user.id), isOwner: isOwner(user.id), isSubAdmin: isSubAdmin(user.id),
                premium: isPremium(user.id),
                cooldownMs: checkCooldown(user.id), scanLimit: SCAN_LIMIT,
                cooldownMinutes: Math.round(getCooldownMs(user.id) / 60000),
                dailyLimit: getDailyLimit(user.id) === Infinity ? null : getDailyLimit(user.id),
                scansToday: u.scansToday || 0,
                dailyLimitReached: dailyLimitReached(user.id),
                msUntilDailyReset: msUntilDailyReset(user.id),
                premiumPriceStars: PREMIUM_PRICE_STARS,
                limitStatusText: limitStatusText(user.id)
            });
        }

        if (pathname === '/api/premium/invoice' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            try {
                const link = await createStarsInvoiceLink(`premium_${user.id}_${Date.now()}`);
                return sendJson(200, { link });
            } catch (e) {
                console.error('createStarsInvoiceLink error:', e.message);
                return sendJson(500, { error: 'invoice_failed' });
            }
        }

        if (pathname === '/api/admin/users' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            if (!canUseAdminPanel(user.id)) return sendJson(403, { error: 'not_admin' });
            const list = [...usersMap.entries()]
                .filter(([id]) => id !== ADMIN_ID)
                .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
                .slice(0, 50)
                .map(([id, u]) => ({ id, username: u.username || null, firstName: u.firstName || null, banned: !!u.banned, isSubAdmin: !!u.isSubAdmin, premium: !!u.premium }));
            return sendJson(200, { users: list, isOwner: isOwner(user.id), pendingRequests: isOwner(user.id) ? pendingBanRequests.size : 0 });
        }

        if (pathname === '/api/admin/ban' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            if (!canUseAdminPanel(user.id)) return sendJson(403, { error: 'not_admin' });
            const targetId = Number(body.targetId);
            const reason = (body.reason || '').trim();
            if (!targetId || !reason) return sendJson(400, { error: 'bad_request' });
            const action = isBanned(targetId) ? 'unban' : 'ban';

            if (isOwner(user.id)) {
                applyBanAction(targetId, action, reason);
                await notifyUserOfBanAction(targetId, action, reason);
                return sendJson(200, { ok: true, applied: true });
            }
            const reqId = `${Date.now()}_${targetId}`;
            pendingBanRequests.set(reqId, { requesterId: user.id, targetId, action, reason });
            const targetUser = usersMap.get(targetId);
            const label = targetUser?.username ? `@${targetUser.username}` : `id${targetId}`;
            try {
                await bot.sendMessage(ADMIN_ID,
                    `🔔 <b>Запрос от админа</b> (id${user.id})\n\nДействие: <b>${action === 'ban' ? 'ЗАБАНИТЬ' : 'РАЗБАНИТЬ'}</b> ${label} (${targetId})\nПричина: ${escapeHtml(reason)}`,
                    { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[btn('✅ Принять', `banreq_accept_${reqId}`, 'success'), btn('❌ Отклонить', `banreq_decline_${reqId}`, 'danger')]] } });
            } catch (e) { console.error('Не удалось отправить заявку владельцу:', e.message); }
            return sendJson(200, { ok: true, applied: false, pending: true });
        }

        if (pathname === '/api/admin/premium' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            if (!isOwner(user.id)) return sendJson(403, { error: 'owner_only' });
            const targetId = Number(body.targetId);
            if (!targetId) return sendJson(400, { error: 'bad_request' });
            const wasPremium = isPremium(targetId);
            if (wasPremium) revokePremium(targetId); else grantPremium(targetId);
            try {
                await bot.sendMessage(targetId, !wasPremium
                    ? `🌟 <b>Тебе выдан Premium!</b>\n\nКулдаун между сканами теперь ${Math.round(PREMIUM_COOLDOWN_MS / 60000)} мин, дневного лимита нет.`
                    : '🌟 Premium снят.', { parse_mode: 'HTML' });
            } catch (e) {}
            return sendJson(200, { ok: true, premium: !wasPremium });
        }

        if (pathname === '/api/scan/start' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            if (isBanned(user.id)) return sendJson(403, { error: 'banned' });
            const remaining = checkCooldown(user.id);
            if (remaining > 0) return sendJson(429, { error: 'cooldown', remainingMs: remaining });
            if (dailyLimitReached(user.id)) return sendJson(429, { error: 'daily_limit', msUntilDailyReset: msUntilDailyReset(user.id) });
            const link = parseLink(body.link || '');
            if (!link) return sendJson(400, { error: 'bad_link' });

            const jobId = `${user.id}_${Date.now()}`;
            const abortFlag = { aborted: false };
            const job = { status: 'running', done: 0, total: 0, violCount: 0, userId: user.id, abortFlag, createdAt: Date.now() };
            jobs.set(jobId, job);
            lastScanByUser.set(user.id, Date.now());
            incrementDailyScans(user.id);

            runScan(link, body.mode === 'group' ? 'group' : (body.mode === 'channel' ? 'channel' : null), {
                onStatus: (status, payload) => { job.statusNote = status; if (payload?.isGroupChat != null) job.isGroupChat = payload.isGroupChat; },
                onProgress: async ({ done, total, violCount }) => { job.done = done; job.total = total; job.violCount = violCount; },
                abortFlag
            }).then((result) => {
                if (result.pending) { job.status = 'pending'; lastScanByUser.delete(user.id); job.message = 'Заявка на вступление отправлена — жди одобрения администратора канала и попробуй снова.'; return; }
                if (result.notAChannel) { job.status = 'error'; lastScanByUser.delete(user.id); job.message = 'Это ссылка на профиль пользователя, а не на канал/группу.'; return; }
                if (result.empty) { job.status = 'done'; job.result = { ...result, violations: [], failedChunks: [] }; job.message = null; return; }
                job.status = 'done';
                job.result = result;
            }).catch((e) => {
                console.error('API scan error:', e.message);
                job.status = 'error';
                job.message = e.message;
                lastScanByUser.delete(user.id);
            });

            return sendJson(200, { jobId });
        }

        if (pathname === '/api/scan/status' && req.method === 'GET') {
            const jobId = parsedUrl.searchParams.get('jobId');
            const job = jobs.get(jobId);
            if (!job) return sendJson(404, { error: 'not_found' });
            const violations = job.result?.violations || [];
            const top = violations.slice(0, TOP_VIOLATIONS_SHOWN);
            return sendJson(200, {
                status: job.status,
                done: job.done, total: job.total, violCount: job.violCount,
                isGroupChat: job.isGroupChat || false,
                message: job.message || null,
                aborted: job.result?.aborted || false,
                channelLink: job.result?.channelLink || null,
                textMessagesCount: job.result?.textMessagesCount || 0,
                failedChunks: job.result?.failedChunks?.length || 0,
                totalViolations: violations.length,
                top: top.map((v, i) => ({ index: i + 1, category: v.category_ru, severity: v.severity, reason: v.reason, id: v.id }))
            });
        }

        if (pathname === '/api/scan/stop' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            const job = jobs.get(body.jobId);
            if (job && job.userId === user.id) job.abortFlag.aborted = true;
            return sendJson(200, { ok: true });
        }

        if (pathname === '/api/scan/full' && req.method === 'GET') {
            const jobId = parsedUrl.searchParams.get('jobId');
            const job = jobs.get(jobId);
            if (!job || !job.result) return sendJson(404, { error: 'not_found' });
            const r = job.result;
            const lines = r.violations.map((v, i) => `${i + 1}. ${r.channelLink}/${v.id} — [${v.category_ru}, ${v.severity}/5] ${v.reason}`);
            const text = `${r.isGroupChat ? 'Группа' : 'Канал'}: ${r.channelLink}\nПроверено сообщений: ${r.textMessagesCount}\nНайдено нарушений: ${r.violations.length}\n\n${lines.join('\n')}`;
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="violations.txt"' });
            return res.end(text);
        }

        if (pathname === '/api/report' && req.method === 'POST') {
            const body = await readJsonBody(req);
            const user = validateInitData(body.initData);
            if (!user) return sendJson(401, { error: 'invalid_init_data' });
            const job = jobs.get(body.jobId);
            if (!job || !job.result || job.userId !== user.id) return sendJson(404, { error: 'not_found' });
            const indices = Array.isArray(body.indices) ? body.indices.slice(0, 15) : []; // разумный потолок за один запрос
            const out = [];
            for (const idx of indices) {
                const v = job.result.violations[idx - 1];
                if (!v) continue;
                const vLink = `${job.result.channelLink}/${v.id}`;
                const reportText = await buildReport(job.result.channelLink, vLink, v);
                const lawLinks = await getLawLinksForViolation(v);
                out.push({ index: idx, link: vLink, category: v.category_ru, severity: v.severity, reportText, lawLinks });
            }
            return sendJson(200, { reports: out });
        }

        return sendJson(404, { error: 'not_found' });
    } catch (e) {
        console.error('API error:', e.message);
        return sendJson(500, { error: 'internal_error' });
    }
}

const SCAN_LIMIT = parseInt(process.env.SCAN_LIMIT || '1000', 10);
const TOP_VIOLATIONS_SHOWN = 10; // в сообщении — только топ по серьёзности, остальное в файле по кнопке
const CHUNK_SIZE = parseInt(process.env.SCAN_CHUNK_SIZE || '100', 10);
const GEMINI_MIN_INTERVAL_MS = 4200;
const SCAN_CONCURRENCY = Math.max(1, GEMINI_API_KEYS.length);

// ====== ЛИМИТЫ / PREMIUM ======
// Бесплатно: 2 скана в день (сброс в полночь UTC) + кулдаун 10 мин между сканами.
// Premium: без дневного лимита + кулдаун сокращён до 5 мин.
// Владелец/под-админы: без ограничений вообще.
const FREE_DAILY_SCANS = parseInt(process.env.FREE_DAILY_SCANS || '2', 10);
const FREE_COOLDOWN_MS = parseInt(process.env.FREE_COOLDOWN_MINUTES || '10', 10) * 60 * 1000;
const PREMIUM_COOLDOWN_MS = parseInt(process.env.PREMIUM_COOLDOWN_MINUTES || '5', 10) * 60 * 1000;
const PREMIUM_PRICE_STARS = parseInt(process.env.PREMIUM_PRICE_STARS || '50', 10);

const FALLBACK_LAW_MAP = {
    personal_data: ['https://gdpr-info.eu/art-6-gdpr/', 'https://gdpr-info.eu/art-9-gdpr/'],
    illegal_goods: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2065'],
    csam: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32011L0093'],
    terrorism_violence: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32021R0784'],
    hate_speech: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32008F0913'],
    copyright: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32019L0790'],
    malware_fraud: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2065'],
    other: ['https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32022R2065']
};

// ====== БОТ / СЕРВЕР ======
const bot = new TelegramBot(BOT_TOKEN, { webHook: false });
console.log('🚀 Бот-анализатор запущен (webhook)');

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

const server = http.createServer(async (req, res) => {
    const parsedUrl = new URL(req.url, 'http://localhost');
    const pathname = parsedUrl.pathname;

    if (req.method === 'POST' && pathname === WEBHOOK_PATH) {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            try { bot.processUpdate(JSON.parse(body)); } catch (e) { console.error('parse error:', e); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
        });
        return;
    }
    if (req.method === 'GET' && pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', bot: 'running' }));
        return;
    }
    if (req.method === 'GET' && pathname === '/app') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(getMiniAppHtml());
        return;
    }
    if (pathname.startsWith('/api/')) {
        await handleApiRequest(req, res, pathname, parsedUrl);
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

// ====== АНТИ-СЛИП ======
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
        await new Promise((r) => setTimeout(r, 150000));
    }
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
        tosCache = { text: text.slice(0, 3000), fetchedAt: Date.now() };
    } catch (e) {
        console.error('getTelegramTos error:', e.message);
    }
    return tosCache.text;
}

// ====== РОТАЦИЯ КЛЮЧЕЙ GEMINI ======
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

// ====== РОТАЦИЯ СЕССИЙ ======
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

// ====== АНАЛИЗ ОДНОЙ ПАЧКИ СООБЩЕНИЙ ======
async function analyzeChunk(messages, tosText, attempt = 1, triedKeysThisRound = new Set()) {
    // Очень высокий потолок попыток — пачка не должна остаться непроверенной
    // просто потому что один ключ на минуту исчерпал квоту. Сдаёмся только
    // если реально ничего не помогло за много попыток подряд.
    const MAX_ATTEMPTS = 25;
    const key = pickGeminiKey();
    triedKeysThisRound.add(key);
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

ОСОБЫЙ СЛУЧАЙ — "снос" (организация массовых жалоб для блокировки чужого канала/аккаунта):
- Реклама/продажа УСЛУГИ по организации сноса/блокировки/удаления чужого канала или аккаунта ("снос", "снести акк/канал на заказ", "закажи снос", "слив на бан", массфолловинг жалоб) — это нарушение ПРАВИЛ Telegram (злоупотребление системой жалоб), а НЕ законодательства EU. Отмечай такие сообщения как нарушение, ставь "law_type":"other" и явно пиши в reason, что это нарушение именно ToS Telegram, а не закона.
- Обычное упоминание в разговоре, что чей-то канал/аккаунт снесли/забанили/удалили (без предложения услуги, без организации кампании) — это НЕ нарушение, пропускай.

=== Официальные условия использования Telegram (для сверки) ===
${tosText || '(не удалось загрузить, полагайся на список выше)'}
=== конец условий ===

ВАЖНО: сообщения [ПЕРЕСЛАНО] — репост из другого источника. Переслан от Telegram/поддержки официальный текст — это НЕ фишинг, канал просто переслал пост. Оценивай нейтрально, если сам канал не добавил обманный контент.

КРИТИЧЕСКИ ВАЖНО — не делай поспешных выводов по внешнему виду:
- Эмодзи (❄️🌨💊🔫 и т.п.) САМИ ПО СЕБЕ не являются доказательством наркотиков/оружия — нужен явный текст-предложение, цена, контакт для заказа и т.п. Одна снежинка в тексте о погоде, красоте или ёлке — это НЕ наркотики.
- Слово или часть URL/домена, которые ВЫГЛЯДЯТ похожими на что-то запрещённое — НЕ являются доказательством сами по себе. Нужен реальный контент.
- Оценивай смысл всего сообщения целиком, а не отдельные "подозрительные" слова/символы в отрыве от контекста.
- Если сомневаешься и явного прямого доказательства в тексте нет — НЕ включай сообщение в список нарушений.

Верни ТОЛЬКО JSON-массив по одному объекту на КАЖДОЕ сообщение с нарушением (без markdown, без объектов для чистых сообщений):
[{"id":123,"category_ru":"тип на русском","category_en":"короткая EN-фраза для репорта, без имени канала","law_type":"personal_data|illegal_goods|csam|terrorism_violence|hate_speech|copyright|malware_fraud|other","severity":1-5,"reason":"причина на русском"}]
severity 5 = гарантированный бан. Если нарушений нет ни в одном сообщении пачки — верни [].

Сообщения (${messages.length} шт., проверь каждое):
${listText}`;

    let res;
    try {
        res = await fetch(geminiUrlFor(key), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.2, responseMimeType: 'application/json', maxOutputTokens: 8192 },
                safetySettings: [
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' }
                ]
            })
        });
    } catch (networkErr) {
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Сетевая ошибка после ${MAX_ATTEMPTS} попыток: ${networkErr.message}`);
        const waitMs = Math.min(3000 * attempt, 15000);
        console.error(`Сетевая ошибка (попытка ${attempt}/${MAX_ATTEMPTS}), жду ${waitMs}мс: ${networkErr.message}`);
        await new Promise((r) => setTimeout(r, waitMs));
        return analyzeChunk(messages, tosText, attempt + 1, triedKeysThisRound);
    }

    if (!res.ok) {
        const errText = await res.text();
        const isQuota = res.status === 429;
        const isServerError = res.status === 503 || res.status === 500;

        if (attempt >= MAX_ATTEMPTS) throw new Error(`Gemini ${res.status} после ${MAX_ATTEMPTS} попыток: ${errText.slice(0, 300)}`);

        if (isQuota) {
            if (triedKeysThisRound.size >= GEMINI_API_KEYS.length) {
                // Все ключи в этом круге на 429 — не сдаёмся, а ждём и начинаем новый круг заново.
                console.error(`Все ${GEMINI_API_KEYS.length} ключей отдают 429, жду перед новым кругом (попытка ${attempt}/${MAX_ATTEMPTS})`);
                await new Promise((r) => setTimeout(r, 8000));
                return analyzeChunk(messages, tosText, attempt + 1, new Set());
            }
            console.error(`Gemini 429 у ключа ...${key.slice(-6)} (попытка ${attempt}/${MAX_ATTEMPTS}), переключаюсь на другой ключ`);
            return analyzeChunk(messages, tosText, attempt + 1, triedKeysThisRound);
        }
        if (isServerError) {
            const waitMs = Math.min(3000 * attempt, 15000);
            console.error(`Gemini ${res.status} (попытка ${attempt}/${MAX_ATTEMPTS}), жду ${waitMs}мс`);
            await new Promise((r) => setTimeout(r, waitMs));
            return analyzeChunk(messages, tosText, attempt + 1, triedKeysThisRound);
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

    // Ответ обрезан по лимиту токенов — JSON почти наверняка неполный, парсить его
    // как "нарушений нет" нельзя. Делим пачку пополам и повторяем — на пачке
    // поменьше модели проще уложиться в лимит без обрезки.
    if (finishReason === 'MAX_TOKENS' && messages.length > 1) {
        console.error(`Ответ обрезан по MAX_TOKENS на пачке из ${messages.length} сообщений — делю пополам и повторяю`);
        const mid = Math.ceil(messages.length / 2);
        const [left, right] = await Promise.all([
            analyzeChunk(messages.slice(0, mid), tosText, 1),
            analyzeChunk(messages.slice(mid), tosText, 1)
        ]);
        return [...left, ...right];
    }

    const raw = candidate?.content?.parts?.map((p) => p.text).join('') || '[]';
    try {
        return JSON.parse(raw);
    } catch (e) {
        // Раньше это молча считалось "нарушений нет" — опасно, реальные нарушения
        // могли теряться из-за банального обрезанного/битого JSON. Теперь — повтор.
        if (attempt >= MAX_ATTEMPTS) throw new Error(`Не удалось распарсить ответ нейросети после ${MAX_ATTEMPTS} попыток`);
        console.error(`JSON parse error (попытка ${attempt}/${MAX_ATTEMPTS}), повторяю пачку: ${raw.slice(0, 200)}`);
        return analyzeChunk(messages, tosText, attempt + 1, triedKeysThisRound);
    }
}

// ====== ПАРАЛЛЕЛЬНАЯ ОБРАБОТКА ПАЧЕК (с поддержкой остановки по кнопке) ======
async function processChunksInParallel(chunks, tosText, onProgress, abortFlag) {
    const violations = [];
    const failedChunks = [];
    let nextIndex = 0;
    let completed = 0;
    let lastEditAt = 0;

    async function reportProgress(force = false) {
        const now = Date.now();
        if (!force && now - lastEditAt < 1200) return;
        lastEditAt = now;
        await onProgress(completed, violations.length);
    }

    async function worker() {
        while (true) {
            if (abortFlag && abortFlag.aborted) return;
            const i = nextIndex++;
            if (i >= chunks.length) return;
            try {
                (await analyzeChunk(chunks[i], tosText)).forEach((f) => violations.push(f));
            } catch (e) {
                console.error('analyzeChunk error:', e.message);
                failedChunks.push({ chunk: i + 1, error: e.message });
            }
            completed += chunks[i].length;
            await reportProgress();
        }
    }

    const workerCount = Math.min(SCAN_CONCURRENCY, chunks.length) || 1;
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    await reportProgress(true);
    return { violations, failedChunks, aborted: !!(abortFlag && abortFlag.aborted) };
}

// ====== ПРОГРЕСС-БАР ======
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

// ====== КНОПКИ (Bot API 9.4: style — danger/success/primary) ======
function btn(text, callback_data, style) {
    const b = { text, callback_data };
    if (style) b.style = style;
    return b;
}
function backButton() { return btn('◀️ Назад', 'back_to_start', 'primary'); }
function menuButton() { return btn('◀️ В меню', 'back_to_start', 'primary'); }

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
    const prompt = `Напиши короткий официальный репорт-письмо на английском в поддержку Telegram ("Dear Telegram Support Team") про нарушение конкретным каналом одновременно и Условий использования Telegram, и применимого законодательства EU — явно укажи в тексте оба этих основания (Telegram ToS И EU law), а не только одно. Если тип нарушения связан с "услугой сноса/блокировки чужого аккаунта" — упомяни, что это злоупотребление системой жалоб Telegram, а не ссылайся на конкретный закон EU для этого пункта.

Канал: ${channelLink}
Пост-доказательство: ${violationLink}
Тип нарушения: ${violation.category_en}
Детали: ${violation.reason}

Требования:
- 3 коротких абзаца, формальный тон, без markdown.
- Упомяни ссылку на канал и ссылку на пост-доказательство.
- Не упоминай ссылки на конкретные статьи законов — они уходят отдельным сообщением.
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

// ====== ЗАКОНЫ ЧЕРЕЗ AI-ПОИСК (google_search grounding) ======
async function generateLawLinksViaAI(violation) {
    const key = pickGeminiKey();
    await throttleGemini(key);
    const prompt = `Найди 2-4 актуальные, реально существующие и рабочие ссылки на официальные источники права (регламенты/директивы EU, официальные юридические порталы вроде eur-lex.europa.eu, gdpr-info.eu и подобные), применимые к этому нарушению в Telegram-канале:

Тип нарушения: ${violation.category_ru} (${violation.law_type})
Детали: ${violation.reason}

Если это по сути злоупотребление внутренней системой жалоб Telegram (организация "сноса"/массовых жалоб), а не нарушение конкретного закона — так и напиши, ссылок на законы не выдумывай, дай только ссылку на официальные правила Telegram (telegram.org/tos).

Требования:
- Только реальные, существующие, рабочие URL — ничего не выдумывай.
- Каждая ссылка на отдельной строке в формате: "Название — URL".
- Без пояснений и вступлений, только список.`;

    const res = await fetch(geminiUrlFor(key), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ google_search: {} }],
            generationConfig: { temperature: 0.1 }
        })
    });
    if (!res.ok) { const t = await res.text(); throw new Error(`Gemini ${res.status}: ${t.slice(0, 300)}`); }
    const data = await res.json();
    const candidate = data.candidates?.[0];

    const groundedUrls = (candidate?.groundingMetadata?.groundingChunks || [])
        .map((c) => c.web?.uri)
        .filter(Boolean);
    if (groundedUrls.length) return [...new Set(groundedUrls)].slice(0, 5);

    const text = candidate?.content?.parts?.map((p) => p.text).join('') || '';
    const urls = [...text.matchAll(/https?:\/\/[^\s"')]+/g)].map((m) => m[0].replace(/[.,)]+$/, ''));
    if (urls.length) return [...new Set(urls)].slice(0, 5);

    throw new Error('Нейросеть не вернула ни одной ссылки на закон.');
}
async function getLawLinksForViolation(violation) {
    try {
        return await generateLawLinksViaAI(violation);
    } catch (e) {
        console.error('generateLawLinksViaAI error, использую запасной список:', e.message);
        return FALLBACK_LAW_MAP[violation.law_type] || FALLBACK_LAW_MAP.other;
    }
}

// ====== РАЗБОР ССЫЛКИ ======
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

// ====== ПРИВАТНЫЕ КАНАЛЫ ПО ИНВАЙТ-ССЫЛКЕ ======
async function resolveInviteEntity(client, hash) {
    let invite;
    try {
        invite = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
    } catch (e) {
        throw new Error(`Ссылка недействительна или устарела (${e.message})`);
    }
    if (invite.className === 'ChatInviteAlready' || invite.className === 'ChatInvitePeek') {
        return { entity: invite.chat, pending: false };
    }
    try {
        const result = await client.invoke(new Api.messages.ImportChatInvite({ hash }));
        const chat = result.chats?.[0];
        return { entity: chat, pending: false };
    } catch (e) {
        const msg = String(e.message || e);
        if (msg.includes('INVITE_REQUEST_SENT')) return { entity: null, pending: true };
        if (msg.includes('USER_ALREADY_PARTICIPANT')) {
            const invite2 = await client.invoke(new Api.messages.CheckChatInvite({ hash }));
            if (invite2.chat) return { entity: invite2.chat, pending: false };
        }
        throw new Error(`Не удалось вступить по инвайт-ссылке (${msg})`);
    }
}

// ====== ССЫЛКА НА КАНАЛ/ГРУППУ (правильный формат для приватных — /c/<id>) ======
function baseChannelLink(entity, link) {
    if (entity?.username) return `https://t.me/${entity.username}`;
    if (entity?.id != null) {
        const rawId = entity.id.toString().replace(/^-100/, '').replace(/^-/, '');
        return `https://t.me/c/${rawId}`;
    }
    return link.type === 'invite' ? `https://t.me/+${link.hash}` : `https://t.me/${link.username}`;
}

// ====== АДМИНЫ ГРУППЫ ======
// Основной способ — фильтр ChannelParticipantsAdmins. Если он не сработал
// (бывает по правам/капризам библиотеки) — фолбэк на список Recent-участников
// с проверкой роли у каждого (там роль видна независимо от фильтра admins).
async function getGroupAdminIds(client, entity) {
    const adminIds = new Set();
    try {
        if (entity.className === 'Channel') {
            try {
                const result = await client.invoke(new Api.channels.GetParticipants({
                    channel: entity,
                    filter: new Api.ChannelParticipantsAdmins(),
                    offset: 0,
                    limit: 200,
                    hash: BigInt(0)
                }));
                (result.users || []).forEach((u) => adminIds.add(Number(u.id)));
            } catch (e) {
                console.error('GetParticipants(Admins) не сработал, пробую фолбэк Recent:', e.message);
            }
            if (!adminIds.size) {
                try {
                    const result = await client.invoke(new Api.channels.GetParticipants({
                        channel: entity,
                        filter: new Api.ChannelParticipantsRecent(),
                        offset: 0,
                        limit: 200,
                        hash: BigInt(0)
                    }));
                    (result.participants || []).forEach((p) => {
                        if ((p.className === 'ChannelParticipantAdmin' || p.className === 'ChannelParticipantCreator') && p.userId != null) {
                            adminIds.add(Number(p.userId));
                        }
                    });
                } catch (e2) {
                    console.error('Фолбэк GetParticipants(Recent) тоже не сработал:', e2.message);
                }
            }
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

// ====== СООБЩЕНИЯ ГРУППЫ ОТ АДМИНОВ ======
// Тянем историю ПО КАЖДОМУ админу отдельно (client.getMessages(..., {fromUser}))
// — так проверяются реально последние сообщения именно админов, а не что попало
// в последнюю тысячу сообщений группы. Если персональный запрос для конкретного
// админа не сработал — не теряем его молча, а добираем его сообщения из уже
// полученной общей истории. Плюс отдельно учитываем анонимные посты "от имени
// группы" (их может делать только админ).
// Возвращает null, если ничего вообще не удалось выделить — тогда вызывающий
// код явно предупредит пользователя, а не тихо проверит всех подряд.
async function getAdminAuthoredMessages(client, entity, adminIds, generalMessages) {
    if (!adminIds.size) return null;

    const perAdminLimit = Math.max(20, Math.ceil(SCAN_LIMIT / adminIds.size));
    const collected = new Map();
    const failedAdmins = new Set();

    for (const adminId of adminIds) {
        try {
            const msgs = await client.getMessages(entity, { limit: perAdminLimit, fromUser: adminId });
            msgs.forEach((m) => { if (m.message && m.message.trim()) collected.set(m.id, m); });
        } catch (e) {
            failedAdmins.add(adminId);
            console.error(`getMessages fromUser=${adminId} не сработал:`, e.message);
        }
    }

    // Для админов, у которых персональный запрос не прошёл, и для анонимных
    // постов "от имени группы" — добираем из уже полученной общей истории.
    generalMessages.forEach((m) => {
        if (m.senderId !== null && (failedAdmins.has(m.senderId) || m.senderId === Number(entity.id))) {
            collected.set(m.id, { id: m.id, message: m.text, fwdFrom: m.isForwarded, senderId: m.senderId });
        }
    });

    if (!collected.size) return null;

    return [...collected.values()].map((m) => ({
        id: m.id,
        text: m.message,
        isForwarded: !!m.fwdFrom,
        senderId: m.senderId != null ? Number(m.senderId) : null
    }));
}

// ====== СОСТОЯНИЯ ДИАЛОГА ======
const awaitingLink = new Map();
const awaitingSelection = new Map();
const mainMsgId = new Map();       // chatId -> id единственного "экранного" сообщения (меню/прогресс/выбор)
const resultMsgIds = new Map();    // chatId -> [] id вспомогательных сообщений (список нарушений, репорты, файл) — чистятся при "Назад"
const lastScanByUser = new Map();
const usersMap = new Map();          // chatId -> { username, firstName, banned, lastSeen, isSubAdmin }

// Сохранение банов/под-админов в файл, чтобы переживало обычный рестарт процесса.
// ⚠️ На бесплатном Render диск эфемерный: при полном пересоздании контейнера
// (не просто рестарт, а холодная "просыпа" после долгого простоя/новый деплой)
// файл всё равно может обнулиться — для гарантии нужен внешний DB/сторедж.
const USERS_DATA_FILE = path.join('/tmp', 'bot_users_data.json');
function loadUsersData() {
    try {
        const obj = JSON.parse(fs.readFileSync(USERS_DATA_FILE, 'utf-8'));
        Object.entries(obj).forEach(([id, u]) => usersMap.set(Number(id), u));
        console.log(`✅ Загружено пользователей из файла: ${usersMap.size}`);
    } catch (e) { /* файла нет или битый — начинаем с пустого, это нормально */ }
}
function saveUsersData() {
    try {
        const obj = {};
        usersMap.forEach((u, id) => { obj[id] = u; });
        fs.writeFileSync(USERS_DATA_FILE, JSON.stringify(obj), 'utf-8');
    } catch (e) { console.error('saveUsersData error:', e.message); }
}
loadUsersData();
const activeScanAbort = new Map();   // chatId -> { aborted: boolean }
const awaitingBanReason = new Map(); // chatId (админа) -> { targetId, action: 'ban'|'unban' }
const pendingBanRequests = new Map(); // reqId -> { requesterId, targetId, action, reason }

function trackResult(chatId, messageId) {
    const arr = resultMsgIds.get(chatId) || [];
    arr.push(messageId);
    resultMsgIds.set(chatId, arr);
}
async function clearResults(chatId) {
    const arr = resultMsgIds.get(chatId) || [];
    for (const id of arr) { try { await bot.deleteMessage(chatId, id); } catch (e) {} }
    resultMsgIds.set(chatId, []);
}

// ====== ЭКРАН: редактируем ОДНО и то же сообщение ======
async function showScreen(chatId, text, keyboard) {
    const existing = mainMsgId.get(chatId);
    if (existing) {
        try {
            await bot.editMessageText(text, { chat_id: chatId, message_id: existing, parse_mode: 'HTML', reply_markup: keyboard });
            return;
        } catch (e) {}
    }
    const sent = await bot.sendMessage(chatId, text, { parse_mode: 'HTML', reply_markup: keyboard });
    mainMsgId.set(chatId, sent.message_id);
}
async function goToStartScreen(chatId) {
    awaitingLink.delete(chatId);
    awaitingSelection.delete(chatId);
    awaitingBanReason.delete(chatId);
    const abortState = activeScanAbort.get(chatId);
    if (abortState) abortState.aborted = true;
    await clearResults(chatId);
    await showScreen(chatId, startMenuText(chatId), startMenuKeyboard());
}

function isPremium(chatId) { return usersMap.get(chatId)?.premium === true; }
function getCooldownMs(chatId) {
    if (isOwner(chatId) || isSubAdmin(chatId)) return 0;
    return isPremium(chatId) ? PREMIUM_COOLDOWN_MS : FREE_COOLDOWN_MS;
}
function checkCooldown(chatId) {
    const last = lastScanByUser.get(chatId) || 0;
    const remaining = getCooldownMs(chatId) - (Date.now() - last);
    return remaining > 0 ? remaining : 0;
}
function ensureDailyReset(chatId) {
    const u = usersMap.get(chatId) || { banned: false };
    const now = Date.now();
    if (!u.dayResetAt || now >= u.dayResetAt) {
        u.scansToday = 0;
        const d = new Date(now);
        d.setUTCHours(24, 0, 0, 0);
        u.dayResetAt = d.getTime();
        usersMap.set(chatId, u);
    }
    return u;
}
function getDailyLimit(chatId) {
    if (isOwner(chatId) || isSubAdmin(chatId) || isPremium(chatId)) return Infinity;
    return FREE_DAILY_SCANS;
}
function dailyLimitReached(chatId) {
    const limit = getDailyLimit(chatId);
    if (limit === Infinity) return false;
    const u = ensureDailyReset(chatId);
    return (u.scansToday || 0) >= limit;
}
function incrementDailyScans(chatId) {
    const u = ensureDailyReset(chatId);
    u.scansToday = (u.scansToday || 0) + 1;
    usersMap.set(chatId, u);
}
function msUntilDailyReset(chatId) {
    const u = ensureDailyReset(chatId);
    return Math.max(0, u.dayResetAt - Date.now());
}
function limitStatusText(chatId) {
    if (isOwner(chatId) || isSubAdmin(chatId)) return '👑 Без ограничений — у тебя права админа.';
    if (isPremium(chatId)) return `🌟 Premium: сканы без дневного лимита, кулдаун между сканами — ${Math.round(PREMIUM_COOLDOWN_MS / 60000)} мин.`;
    const u = ensureDailyReset(chatId);
    const left = Math.max(0, FREE_DAILY_SCANS - (u.scansToday || 0));
    return `🆓 Бесплатно: ${left}/${FREE_DAILY_SCANS} сканов осталось сегодня (сброс в 00:00 UTC), кулдаун между сканами — ${Math.round(FREE_COOLDOWN_MS / 60000)} мин.\n🌟 Premium снимает дневной лимит и сокращает кулдаун до ${Math.round(PREMIUM_COOLDOWN_MS / 60000)} мин — за ${PREMIUM_PRICE_STARS} ⭐.`;
}
function cooldownText(remainingMs, chatId) {
    const mins = Math.ceil(remainingMs / 60000);
    return `⏳ Кулдаун ещё ${mins} мин.\n\n${limitStatusText(chatId)}`;
}
function dailyLimitText(chatId) {
    const mins = Math.ceil(msUntilDailyReset(chatId) / 60000);
    const h = Math.floor(mins / 60), m = mins % 60;
    return `🚫 Дневной лимит сканов исчерпан (${FREE_DAILY_SCANS}/${FREE_DAILY_SCANS}).\nСброс через ${h}ч ${m}м (00:00 UTC).\n\n🌟 Premium снимает этот лимит — за ${PREMIUM_PRICE_STARS} ⭐ в разделе Premium.`;
}

// ====== PREMIUM / ОПЛАТА ЗВЁЗДАМИ ======
async function createStarsInvoiceLink(payload) {
    const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: 'Channel Guard Premium',
            description: `Кулдаун ${Math.round(PREMIUM_COOLDOWN_MS / 60000)} мин вместо ${Math.round(FREE_COOLDOWN_MS / 60000)} и сканы без дневного лимита`,
            payload,
            currency: 'XTR',
            prices: [{ label: 'Channel Guard Premium', amount: PREMIUM_PRICE_STARS }]
        })
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.description || 'createInvoiceLink failed');
    return data.result;
}
function grantPremium(chatId) {
    const u = usersMap.get(chatId) || { banned: false };
    u.premium = true;
    usersMap.set(chatId, u);
    saveUsersData();
}
function revokePremium(chatId) {
    const u = usersMap.get(chatId) || { banned: false };
    u.premium = false;
    usersMap.set(chatId, u);
    saveUsersData();
}

// ====== ПОЛЬЗОВАТЕЛИ / БАН (для /admin) ======
function touchUser(from, chatId) {
    if (chatId == null || !from) return;
    const existing = usersMap.get(chatId) || { banned: false };
    existing.username = from.username || existing.username;
    existing.firstName = from.first_name || existing.firstName;
    existing.lastSeen = Date.now();
    usersMap.set(chatId, existing);
}
function isBanned(chatId) { return usersMap.get(chatId)?.banned === true; }

function isOwner(chatId) { return chatId === ADMIN_ID; }
function isSubAdmin(chatId) { return usersMap.get(chatId)?.isSubAdmin === true; }
function canUseAdminPanel(chatId) { return isOwner(chatId) || isSubAdmin(chatId); }

// viewerChatId — от чьего лица показываем панель: владельцу видна кнопка назначения
// админов, Premium-тумблер и счётчик заявок на подтверждение, под-админу — только бан/разбан.
function renderAdminMenu(viewerChatId) {
    const ownerView = isOwner(viewerChatId);
    const list = [...usersMap.entries()]
        .filter(([id]) => id !== ADMIN_ID)
        .sort((a, b) => (b[1].lastSeen || 0) - (a[1].lastSeen || 0))
        .slice(0, 30);

    let text = `👑 <b>Админ-панель</b>${ownerView ? '' : ' (доступ админа)'}\n\nПользователей: ${usersMap.size}`;
    text += list.length < usersMap.size ? ' (показаны последние 30)' : '';
    text += list.length ? '\n\nВыбери действие рядом с пользователем:' : '\n\nПока никто не писал боту.';
    if (ownerView && pendingBanRequests.size) text += `\n\n🔔 Заявок на подтверждение: <b>${pendingBanRequests.size}</b>`;
    if (!ownerView) text += `\n\nℹ️ Бан/разбан уходит владельцу бота на подтверждение.`;

    const rows = list.map(([id, u]) => {
        const label = u.username ? `@${u.username}` : (u.firstName || `id${id}`);
        const banBtn = btn(`${u.banned ? '✅ Разбанить' : '🚫 Забанить'} ${label}`, `banstart_${id}`, u.banned ? 'success' : 'danger');
        if (ownerView) {
            const adminBtn = btn(u.isSubAdmin ? '👑 Снять админку' : '👑 Сделать админом', `admintoggle_${id}`, 'primary');
            const premBtn = btn(u.premium ? '🌟 Убрать Premium' : '🌟 Выдать Premium', `premtoggle_${id}`, 'primary');
            return [banBtn, adminBtn, premBtn];
        }
        return [banBtn];
    });
    rows.push([backButton()]);
    return { text, keyboard: { inline_keyboard: rows } };
}

function applyBanAction(targetId, action, reason) {
    const u = usersMap.get(targetId) || { banned: false };
    u.banned = action === 'ban';
    u.lastBanReason = reason;
    usersMap.set(targetId, u);
    saveUsersData();
}
async function notifyUserOfBanAction(targetId, action, reason) {
    try {
        const text = action === 'ban'
            ? `🚫 <b>Ты заблокирован в этом боте.</b>\n\nПричина: ${escapeHtml(reason)}`
            : `✅ <b>Ты разблокирован в этом боте.</b>\n\nПричина: ${escapeHtml(reason)}`;
        await bot.sendMessage(targetId, text, { parse_mode: 'HTML' });
    } catch (e) { console.error('notifyUserOfBanAction error:', e.message); }
}

async function handleBanReasonReply(chatId, text) {
    const state = awaitingBanReason.get(chatId);
    if (!state) return;
    const reason = text.trim();
    if (!reason) {
        const m = await bot.sendMessage(chatId, '❌ Причина не может быть пустой. Напиши причину ещё раз.');
        trackResult(chatId, m.message_id);
        return; // остаёмся в режиме ожидания причины
    }
    awaitingBanReason.delete(chatId);

    if (isOwner(chatId)) {
        applyBanAction(state.targetId, state.action, reason);
        await notifyUserOfBanAction(state.targetId, state.action, reason);
        const { text: menuText, keyboard } = renderAdminMenu(chatId);
        await showScreen(chatId, `✅ Готово.\n\n${menuText}`, keyboard);
        return;
    }

    // под-админ — заявка уходит владельцу на подтверждение
    const reqId = `${Date.now()}_${state.targetId}`;
    pendingBanRequests.set(reqId, { requesterId: chatId, targetId: state.targetId, action: state.action, reason });
    const targetUser = usersMap.get(state.targetId);
    const label = targetUser?.username ? `@${targetUser.username}` : `id${state.targetId}`;
    try {
        await bot.sendMessage(ADMIN_ID,
            `🔔 <b>Запрос от админа</b> (id${chatId})\n\n` +
            `Действие: <b>${state.action === 'ban' ? 'ЗАБАНИТЬ' : 'РАЗБАНИТЬ'}</b> ${label} (${state.targetId})\n` +
            `Причина: ${escapeHtml(reason)}`,
            { parse_mode: 'HTML', reply_markup: { inline_keyboard: [[btn('✅ Принять', `banreq_accept_${reqId}`, 'success'), btn('❌ Отклонить', `banreq_decline_${reqId}`, 'danger')]] } });
    } catch (e) { console.error('Не удалось отправить заявку владельцу:', e.message); }
    const { text: menuText, keyboard } = renderAdminMenu(chatId);
    await showScreen(chatId, `📨 Заявка отправлена владельцу бота на подтверждение.\n\n${menuText}`, keyboard);
}

// ====== ВЫБОР НАРУШЕНИЙ ДЛЯ РЕПОРТА ======
function parseSelection(text, max) {
    const raw = text.trim().toLowerCase();
    if (raw === 'все' || raw === 'всё' || raw === 'all') return Array.from({ length: max }, (_, i) => i + 1);
    const parts = raw.split(/[,\s]+/).filter(Boolean);
    const nums = new Set();
    for (const p of parts) {
        const n = parseInt(p, 10);
        if (!Number.isInteger(n) || n < 1 || n > max) return null;
        nums.add(n);
    }
    return nums.size ? [...nums].sort((a, b) => a - b) : null;
}

async function handleSelectionReply(chatId, text) {
    const state = awaitingSelection.get(chatId);
    if (!state) return;

    const indices = parseSelection(text, state.violations.length);
    if (!indices) {
        const msg = await bot.sendMessage(chatId, `❌ Не понял номера. Напиши числа через запятую в диапазоне 1-${state.violations.length} (например: 1,3,5) или слово "все".`);
        trackResult(chatId, msg.message_id);
        return;
    }
    awaitingSelection.delete(chatId);

    await showScreen(chatId, `🤖 <b>Готовлю ${indices.length > 1 ? 'репорты' : 'репорт'}</b> по нарушениям (${indices.join(', ')})...`, { inline_keyboard: [[backButton()]] });

    let combinedFileText = `${state.isGroupChat ? 'Группа' : 'Канал'}: ${state.channelLink}\nПроверено сообщений: ${state.textMessagesCount}\nНайдено нарушений: ${state.violations.length}\n\n=== Все нарушения ===\n`;
    state.violations.forEach((v, i) => { combinedFileText += `${i + 1}. ${state.channelLink}/${v.id} — [${v.category_ru}, ${v.severity}/5] ${v.reason}\n`; });

    for (const idx of indices) {
        const v = state.violations[idx - 1];
        const vLink = `${state.channelLink}/${v.id}`;
        const reportText = await buildReport(state.channelLink, vLink, v);
        const lawLinks = await getLawLinksForViolation(v);
        const lawsText = lawLinks.map((l, i) => `${i + 1}. ${l}`).join('\n');

        const m1 = await bot.sendMessage(chatId, `📋 <b>Репорт #${idx}</b> — ${escapeHtml(v.category_ru || '—')} (${v.severity || '?'}/5)\nПост: ${vLink}`, { parse_mode: 'HTML' });
        trackResult(chatId, m1.message_id);
        const m2 = await bot.sendMessage(chatId, `<pre>${escapeHtml(reportText)}</pre>`, { parse_mode: 'HTML' });
        trackResult(chatId, m2.message_id);
        const m3 = await bot.sendMessage(chatId, `⚖️ <b>Законы к нарушению #${idx}</b>:`, { parse_mode: 'HTML' });
        trackResult(chatId, m3.message_id);
        const m4 = await bot.sendMessage(chatId, `<pre>${escapeHtml(lawsText)}</pre>`, { parse_mode: 'HTML' });
        trackResult(chatId, m4.message_id);

        combinedFileText += `\n=== Репорт #${idx} (${vLink}) ===\n\n${reportText}\n\n--- Законы ---\n${lawsText}\n`;
    }

    const filePath = path.join('/tmp', `report_${state.username}_${Date.now()}.txt`);
    fs.writeFileSync(filePath, combinedFileText, 'utf-8');
    const fileMsg = await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
    trackResult(chatId, fileMsg.message_id);

    await showScreen(chatId, 'Готово ✅', { inline_keyboard: [[menuButton()]] });
}

// ====== ОСНОВНОЙ АНАЛИЗ ======
// ====== ДВИЖОК СКАНА (переиспользуется и ботом, и Mini App API) ======
// Чистая логика без завязки на способ показа прогресса — onStatus/onProgress
// это колбэки, которые дергает и Telegram-бот (редактируя сообщение), и веб-апп
// (записывая прогресс в jobs-объект, который потом отдаётся по HTTP).
async function runScan(link, mode, { onStatus, onProgress, abortFlag } = {}) {
    const client = await pickMtClient();
    let entity;

    if (link.type === 'invite') {
        if (onStatus) await onStatus('resolving_invite');
        const { entity: e, pending } = await resolveInviteEntity(client, link.hash);
        if (pending) return { pending: true };
        entity = e;
    } else {
        entity = await client.getEntity(link.username);
    }

    if (entity.className === 'User') return { notAChannel: true };

    const channelLink = baseChannelLink(entity, link);
    const username = entity?.username || `id${entity?.id ?? 'unknown'}`;
    const detectedGroup = entity.className === 'Chat' || (entity.className === 'Channel' && entity.megagroup);
    const isGroupChat = mode ? mode === 'group' : detectedGroup;
    if (onStatus) await onStatus('entity_resolved', { isGroupChat, channelLink });

    const rawMessages = await client.getMessages(entity, { limit: SCAN_LIMIT });
    let textMessages = rawMessages
        .filter((m) => m.message && m.message.trim().length > 0)
        .map((m) => ({ id: m.id, text: m.message, isForwarded: !!m.fwdFrom, senderId: m.senderId != null ? Number(m.senderId) : null }));

    let adminFallbackNote = null;
    if (isGroupChat) {
        if (onStatus) await onStatus('finding_admins');
        const adminIds = await getGroupAdminIds(client, entity);
        if (adminIds.size) {
            const adminMessages = await getAdminAuthoredMessages(client, entity, adminIds, textMessages);
            if (adminMessages) textMessages = adminMessages;
            else adminFallbackNote = 'Не удалось выделить именно сообщения админов — проверены все участники группы.';
        } else {
            adminFallbackNote = 'Не удалось определить список админов группы — проверены все участники.';
        }
        if (adminFallbackNote && onStatus) await onStatus('admin_fallback', { note: adminFallbackNote });
    }

    if (!textMessages.length) return { empty: true, isGroupChat, channelLink };

    const tosText = await getTelegramTos();
    const chunks = [];
    for (let i = 0; i < textMessages.length; i += CHUNK_SIZE) chunks.push(textMessages.slice(i, i + CHUNK_SIZE));

    const { violations, failedChunks, aborted } = await processChunksInParallel(chunks, tosText, async (done, violCount) => {
        if (onProgress) await onProgress({ done, total: textMessages.length, violCount });
    }, abortFlag);

    violations.sort((a, b) => (b.severity || 0) - (a.severity || 0) || (a.id || 0) - (b.id || 0));

    return { channelLink, isGroupChat, username, textMessagesCount: textMessages.length, violations, failedChunks, aborted, adminFallbackNote, chunksCount: chunks.length };
}

async function scanChannel(chatId, link, mode) {
    const scanStartedAt = Date.now();
    const abortFlag = { aborted: false };
    activeScanAbort.set(chatId, abortFlag);
    const stopKeyboard = { inline_keyboard: [[btn('⏹ Остановить', 'stop_scan', 'danger')]] };
    let currentIsGroupChat = mode === 'group';

    const result = await runScan(link, mode, {
        onStatus: async (status, payload) => {
            if (status === 'resolving_invite') await showScreen(chatId, '🔐 Приватная ссылка — пытаюсь получить доступ к каналу/группе...', stopKeyboard);
            if (status === 'entity_resolved') currentIsGroupChat = payload.isGroupChat;
            if (status === 'finding_admins') await showScreen(chatId, '👥 Это группа — собираю сообщения админов и создателя (проверяем только их — за обычных участников группу не банят)...', stopKeyboard);
            if (status === 'admin_fallback') await showScreen(chatId, `⚠️ ${payload.note}`, stopKeyboard);
        },
        onProgress: async ({ done, total, violCount }) => {
            await showScreen(chatId,
                `🔍 <b>Сканирую ${currentIsGroupChat ? 'группу' : 'канал'}</b>\n\n` +
                `<b>${renderProgressBar(done, total)}</b>\n\n` +
                `📨 Проверено: <b>${done}/${total}</b>\n⚠️ Найдено нарушений: <b>${violCount}</b>\n⏱ Время: <b>${formatElapsed(Date.now() - scanStartedAt)}</b>`,
                stopKeyboard);
        },
        abortFlag
    });
    activeScanAbort.delete(chatId);

    if (result.pending) {
        await showScreen(chatId,
            '📨 Это канал с заявками на вступление — заявка отправлена автоматически.\nКак только администратор её одобрит, пришли ссылку ещё раз.',
            { inline_keyboard: [[menuButton()]] });
        return { pending: true };
    }
    if (result.notAChannel) {
        await showScreen(chatId, '❌ Это ссылка на профиль пользователя, а не на канал или группу.', { inline_keyboard: [[menuButton()]] });
        return;
    }
    if (result.empty) {
        await showScreen(chatId,
            result.isGroupChat ? 'Не нашлось текстовых сообщений от админов/создателя группы для проверки.' : 'В канале не нашлось текстовых сообщений для проверки.',
            { inline_keyboard: [[menuButton()]] });
        return;
    }

    const { violations, failedChunks, aborted, channelLink, isGroupChat, username, textMessagesCount, chunksCount } = result;
    const abortedNote = aborted ? '⏹ Скан остановлен вручную — ниже результат по тому, что успело проверитьcя.\n\n' : '';

    if (!violations.length) {
        let text = `${abortedNote}✅ Проверено ${textMessagesCount} сообщений в ${channelLink} — явных нарушений не найдено.\n⏱ Заняло: ${formatElapsed(Date.now() - scanStartedAt)}`;
        if (failedChunks.length) text += `\n\n⚠️ ${failedChunks.length} из ${chunksCount} пачек не проверились. Причина: ${failedChunks[0].error}`;
        await showScreen(chatId, text, { inline_keyboard: [[menuButton()]] });
        return;
    }

    const top = violations.slice(0, TOP_VIOLATIONS_SHOWN);
    let linksText = `${abortedNote}🔗 <b>Топ ${top.length} из ${violations.length} нарушений</b> (по убыванию серьёзности)\n\n`;
    if (failedChunks.length) linksText = `⚠️ <b>${failedChunks.length}/${chunksCount} пачек не проверились</b> — список может быть неполным.\n\n` + linksText;
    top.forEach((v, i) => { linksText += `${i + 1}. ${channelLink}/${v.id} — <b>${escapeHtml(v.category_ru || 'нарушение')}</b> (${v.severity || '?'}/5)\n   ${escapeHtml(v.reason)}\n\n`; });
    if (violations.length > top.length) linksText += `... и ещё ${violations.length - top.length} — полный список кнопкой ниже.`;

    const listKeyboard = { inline_keyboard: [[btn('📄 Получить весь список', 'get_full_list', 'success')], [backButton()]] };
    for (let i = 0; i < linksText.length; i += 3500) {
        const isLast = i + 3500 >= linksText.length;
        const m = await bot.sendMessage(chatId, linksText.slice(i, i + 3500), { parse_mode: 'HTML', reply_markup: isLast ? listKeyboard : undefined });
        trackResult(chatId, m.message_id);
    }

    awaitingSelection.set(chatId, { channelLink, violations, isGroupChat, username, textMessagesCount });
    await showScreen(chatId,
        `✏️ Для каких нарушений сделать репорт и список законов?\n\n` +
        `Напиши номера через запятую, например <code>1,3,5</code>, или слово <code>все</code> — можно выбрать любой номер из всех ${violations.length} (не только из топ-${top.length} выше).`,
        { inline_keyboard: [[backButton()]] });
}

// ====== СТАРТ-МЕНЮ ======
function startMenuText(chatId) {
    return `🛡 <b>Channel Guard</b> — проверка каналов и групп Telegram на нарушения.\n\n` +
        `📡 <b>Канал</b> — публичный или приватный (по инвайт-ссылке)\n` +
        `👥 <b>Группа</b> — проверяются только сообщения админов и создателя\n\n` +
        `Формат ссылки: <code>https://t.me/name</code> или <code>https://t.me/+xxxx</code>\n\n` +
        `⏳ Проверка занимает от минуты до нескольких.\n` +
        `${limitStatusText(chatId)}`;
}
function startMenuKeyboard() {
    return { inline_keyboard: [
        [btn('📡 Канал', 'mode_channel', 'primary'), btn('👥 Группа', 'mode_group', 'primary')],
        [{ text: '🖥 Открыть Mini App', web_app: { url: MINI_APP_URL }, style: 'success' }]
    ] };
}

// ====== ХЕНДЛЕРЫ ======
bot.onText(/^\/start\b/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        touchUser(msg.from, chatId);
        if (isBanned(chatId)) { await bot.sendMessage(chatId, '🚫 Ты заблокирован в этом боте.'); return; }
        await goToStartScreen(chatId);
    } catch (e) {
        console.error('/start handler error:', e.message);
    }
});

bot.onText(/^\/admin\b/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        if (!canUseAdminPanel(chatId)) return; // тихо игнорируем не-админов
        const { text, keyboard } = renderAdminMenu(chatId);
        await showScreen(chatId, text, keyboard);
    } catch (e) {
        console.error('/admin handler error:', e.message);
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    touchUser(query.from, chatId);

    if (isBanned(chatId) && !data.startsWith('admin_')) {
        await bot.answerCallbackQuery(query.id, { text: '🚫 Ты заблокирован в этом боте.', show_alert: true });
        return;
    }

    if (data.startsWith('admintoggle_')) {
        if (!isOwner(query.from.id)) { await bot.answerCallbackQuery(query.id); return; }
        const targetId = Number(data.slice('admintoggle_'.length));
        const u = usersMap.get(targetId) || { banned: false };
        u.isSubAdmin = !u.isSubAdmin;
        usersMap.set(targetId, u);
        saveUsersData();
        await bot.answerCallbackQuery(query.id, { text: u.isSubAdmin ? '👑 Назначен админом' : '👑 Админка снята' });
        try {
            if (u.isSubAdmin) {
                await bot.sendMessage(targetId,
                    `👑 <b>Создатель бота сделал тебя админом!</b>\n\n` +
                    `Как пользоваться:\n` +
                    `— Команда /admin открывает список пользователей.\n` +
                    `— Можешь банить и разбанивать — для этого нужно указать причину.\n` +
                    `— Решения по бану/разбану уходят владельцу бота на подтверждение и применяются только после его согласия.`,
                    { parse_mode: 'HTML' });
            } else {
                await bot.sendMessage(targetId, '👑 Твои права админа в этом боте отозваны.');
            }
        } catch (e) {}
        const { text, keyboard } = renderAdminMenu(chatId);
        await showScreen(chatId, text, keyboard);
        return;
    }

    if (data.startsWith('premtoggle_')) {
        if (!isOwner(query.from.id)) { await bot.answerCallbackQuery(query.id); return; }
        const targetId = Number(data.slice('premtoggle_'.length));
        const wasPremium = isPremium(targetId);
        if (wasPremium) { revokePremium(targetId); } else { grantPremium(targetId); }
        const nowPremium = !wasPremium;
        await bot.answerCallbackQuery(query.id, { text: nowPremium ? '🌟 Premium выдан' : '🌟 Premium снят' });
        try {
            await bot.sendMessage(targetId, nowPremium
                ? `🌟 <b>Тебе выдан Premium!</b>\n\nКулдаун между сканами теперь ${Math.round(PREMIUM_COOLDOWN_MS / 60000)} мин, дневного лимита нет.`
                : '🌟 Premium снят.', { parse_mode: 'HTML' });
        } catch (e) {}
        const { text: text2, keyboard: keyboard2 } = renderAdminMenu(chatId);
        await showScreen(chatId, text2, keyboard2);
        return;
    }

    if (data.startsWith('banstart_')) {
        if (!canUseAdminPanel(chatId)) { await bot.answerCallbackQuery(query.id); return; }
        const targetId = Number(data.slice('banstart_'.length));
        const u = usersMap.get(targetId);
        const action = u?.banned ? 'unban' : 'ban';
        awaitingBanReason.set(chatId, { targetId, action });
        await bot.answerCallbackQuery(query.id);
        const label = u?.username ? `@${u.username}` : `id${targetId}`;
        await showScreen(chatId,
            `✏️ Напиши причину: <b>${action === 'ban' ? 'бан' : 'разбан'}</b> пользователя ${label}.\n\n` +
            `Причина обязательна${isOwner(chatId) ? '' : ' — вместе с ней заявка уйдёт владельцу бота на подтверждение'}.`,
            { inline_keyboard: [[backButton()]] });
        return;
    }

    if (data.startsWith('banreq_accept_') || data.startsWith('banreq_decline_')) {
        if (!isOwner(query.from.id)) { await bot.answerCallbackQuery(query.id); return; }
        const accept = data.startsWith('banreq_accept_');
        const reqId = data.slice(accept ? 'banreq_accept_'.length : 'banreq_decline_'.length);
        const req = pendingBanRequests.get(reqId);
        if (!req) { await bot.answerCallbackQuery(query.id, { text: 'Заявка уже обработана или устарела.', show_alert: true }); return; }
        pendingBanRequests.delete(reqId);
        await bot.answerCallbackQuery(query.id);
        if (accept) {
            applyBanAction(req.targetId, req.action, req.reason);
            await notifyUserOfBanAction(req.targetId, req.action, req.reason);
            try { await bot.sendMessage(req.requesterId, `✅ Владелец подтвердил: пользователь ${req.action === 'ban' ? 'забанен' : 'разбанен'}.`); } catch (e) {}
        } else {
            try { await bot.sendMessage(req.requesterId, `❌ Владелец отклонил заявку на ${req.action === 'ban' ? 'бан' : 'разбан'}.`); } catch (e) {}
        }
        try { await bot.editMessageReplyMarkup({ inline_keyboard: [] }, { chat_id: ADMIN_ID, message_id: query.message.message_id }); } catch (e) {}
        return;
    }

    if (data === 'get_full_list') {
        const state = awaitingSelection.get(chatId);
        if (!state) { await bot.answerCallbackQuery(query.id, { text: 'Список уже неактуален — начни новый скан.', show_alert: true }); return; }
        await bot.answerCallbackQuery(query.id);
        let fullText = `${state.isGroupChat ? 'Группа' : 'Канал'}: ${state.channelLink}\nПроверено сообщений: ${state.textMessagesCount}\nНайдено нарушений: ${state.violations.length}\n\n`;
        state.violations.forEach((v, i) => { fullText += `${i + 1}. ${state.channelLink}/${v.id} — [${v.category_ru}, ${v.severity}/5] ${v.reason}\n`; });
        const filePath = path.join('/tmp', `violations_${state.username}_${Date.now()}.txt`);
        fs.writeFileSync(filePath, fullText, 'utf-8');
        const fileMsg = await bot.sendDocument(chatId, filePath, {}, { filename: path.basename(filePath) });
        trackResult(chatId, fileMsg.message_id);
        return;
    }

    if (data === 'stop_scan') {
        const flag = activeScanAbort.get(chatId);
        if (flag) flag.aborted = true;
        await bot.answerCallbackQuery(query.id, { text: '⏹ Останавливаю после текущей пачки...' });
        return;
    }

    if (data === 'back_to_start') {
        await bot.answerCallbackQuery(query.id);
        await goToStartScreen(chatId);
        return;
    }

    if (data === 'mode_channel' || data === 'mode_group') {
        const remaining = checkCooldown(chatId);
        if (remaining > 0) {
            await bot.answerCallbackQuery(query.id, { text: cooldownText(remaining, chatId), show_alert: true });
            return;
        }
        if (dailyLimitReached(chatId)) {
            await bot.answerCallbackQuery(query.id, { text: dailyLimitText(chatId), show_alert: true });
            return;
        }
        await bot.answerCallbackQuery(query.id);
        const mode = data === 'mode_channel' ? 'channel' : 'group';
        awaitingLink.set(chatId, { mode });
        const label = mode === 'channel' ? 'канал' : 'группу';
        await showScreen(chatId,
            `📎 Пришли ссылку на ${label}:\n\n<code>https://t.me/name</code> — публичный\n<code>https://t.me/+xxxx</code> — приватный (по инвайту)`,
            { inline_keyboard: [[backButton()]] });
        return;
    }

    await bot.answerCallbackQuery(query.id);
});

bot.on('pre_checkout_query', async (query) => {
    try { await bot.answerPreCheckoutQuery(query.id, true); }
    catch (e) { console.error('answerPreCheckoutQuery error:', e.message); }
});

bot.on('message', async (msg) => {
    if (msg.successful_payment) {
        const chatId = msg.chat.id;
        grantPremium(chatId);
        await bot.sendMessage(chatId,
            `🌟 <b>Premium активирован!</b>\n\nКулдаун между сканами теперь ${Math.round(PREMIUM_COOLDOWN_MS / 60000)} мин, дневного лимита сканов больше нет.`,
            { parse_mode: 'HTML' });
        return;
    }
    if (!msg.text) return;
    const chatId = msg.chat.id;
    touchUser(msg.from, chatId);

    if (isBanned(chatId)) { await bot.sendMessage(chatId, '🚫 Ты заблокирован в этом боте.'); return; }
    if (msg.text.startsWith('/')) return;

    if (awaitingBanReason.has(chatId)) {
        await handleBanReasonReply(chatId, msg.text);
        return;
    }

    if (awaitingSelection.has(chatId)) {
        await handleSelectionReply(chatId, msg.text);
        return;
    }

    const link = parseLink(msg.text);
    if (!link) {
        await showScreen(chatId,
            '❌ Нужна полная ссылка вида <code>https://t.me/name</code> (или приватная <code>https://t.me/+xxxx</code>).',
            { inline_keyboard: [[menuButton()]] });
        return; // формат неверный — кулдаун не трогаем
    }

    const remaining = checkCooldown(chatId);
    if (remaining > 0) {
        await showScreen(chatId, `⏳ <b>Кулдаун ещё активен</b>\n\n${cooldownText(remaining, chatId)}`, { inline_keyboard: [[menuButton()]] });
        return;
    }
    if (dailyLimitReached(chatId)) {
        await showScreen(chatId, dailyLimitText(chatId), { inline_keyboard: [[menuButton()]] });
        return;
    }

    const chosenMode = awaitingLink.get(chatId)?.mode || null;
    awaitingLink.delete(chatId);
    await clearResults(chatId);

    lastScanByUser.set(chatId, Date.now());
    incrementDailyScans(chatId);
    try {
        const result = await scanChannel(chatId, link, chosenMode);
        if (result && result.pending) lastScanByUser.delete(chatId);
    } catch (e) {
        console.error('scanChannel error:', e.message);
        lastScanByUser.delete(chatId);
        await showScreen(chatId, `❌ Ошибка: ${escapeHtml(e.message)}`, { inline_keyboard: [[menuButton()]] });
    }
});
