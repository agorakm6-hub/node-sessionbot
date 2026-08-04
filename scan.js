const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

const BOT_TOKEN = process.env.BOT_TOKEN || '';
const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;

if (!BOT_TOKEN) {
    console.error('❌ Не задан BOT_TOKEN');
    process.exit(1);
}
if (!EXTERNAL_URL) {
    console.error('❌ Не задан RENDER_EXTERNAL_URL или WEBHOOK_URL');
    console.log('📌 В Render добавьте переменную: RENDER_EXTERNAL_URL = https://ваш-сервис.onrender.com');
    process.exit(1);
}

const WEBHOOK_PATH = `/webhook/${BOT_TOKEN}`;
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

// ====== ОБРАБОТЧИК /start ======
bot.onText(/\/start/, (msg) => {
    const chatId = msg.chat.id;
    bot.sendMessage(chatId, 
        `🚧🔧⚠️ Бот временно не работает! ⚠️🔧🚧\n\n` +
        `🛠️ Ведутся технические работы\n` +
        `🧑‍💻 Наши инженеры уже всё чинят\n\n` +
        `⏰ Попробуйте запустить бота завтра\n` +
        `🙏 Спасибо за понимание!\n\n` +
        `Мы скоро вернёмся ещё круче!`
    );
});

// ====== HTTP СЕРВЕР ДЛЯ WEBHOOK ======
const server = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === WEBHOOK_PATH) {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            try {
                bot.processUpdate(JSON.parse(body));
            } catch (e) {
                console.error('❌ Ошибка парсинга:', e);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true }));
        });
        return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
});

server.listen(PORT, async () => {
    console.log(`✅ Сервер запущен на порту ${PORT}`);
    try {
        await bot.setWebHook(`${EXTERNAL_URL}${WEBHOOK_PATH}`);
        console.log(`✅ Webhook установлен: ${EXTERNAL_URL}${WEBHOOK_PATH}`);
        console.log('🤖 Бот готов к работе!');
    } catch (e) {
        console.error('❌ Ошибка установки webhook:', e);
    }
});

// ====== ОБРАБОТКА ОСТАНОВКИ ======
process.once('SIGINT', () => {
    bot.stopPolling();
    server.close();
    console.log('🛑 Бот остановлен');
});
process.once('SIGTERM', () => {
    bot.stopPolling();
    server.close();
    console.log('🛑 Бот остановлен');
});
