// ============================================================
//  scan.js — анализ Telegram-каналов и групп на нарушения ToS/EU
// ============================================================
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');

// ====== КОНФИГ ======
const BOT_TOKEN = process.env.BOT_TOKEN || '';
if (!BOT_TOKEN) { console.error('❌ Не задан BOT_TOKEN.'); process.exit(1); }

const PORT = process.env.PORT || 10000;
const EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL || process.env.WEBHOOK_URL;
const WEBHOOK_PATH = `/bot${BOT_TOKEN}`;
if (!EXTERNAL_URL) { console.error('❌ Не найден RENDER_EXTERNAL_URL или WEBHOOK_URL.'); process.exit(1); }

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

// ====== СООБЩЕНИЕ О ТЕХНИЧЕСКИХ РАБОТАХ ======
function maintenanceMessage() {
    return `🔧 <b>ТЕХНИЧЕСКИЕ РАБОТЫ</b> 🔧

━━━━━━━━━━━━━━━━━━━━━━

<b>Уважаемые пользователи!</b>

😔 К сожалению, бот временно <b>недоступен</b>.

⚙️ Ведутся <b>технические работы</b> по улучшению и оптимизации работы сервиса.

🛠️ Мы стараемся исправить <b>все баги и ошибки</b> как можно быстрее.

━━━━━━━━━━━━━━━━━━━━━━

⏳ <b>Ориентировочное время завершения работ:</b>

🕐 <i>В течение нескольких дней</i>

━━━━━━━━━━━━━━━━━━━━━━

🙏 Приносим искренние извинения за доставленные неудобства.

💪 Мы делаем всё возможное, чтобы вернуть бота в строй как можно скорее.

🌟 Спасибо за ваше <b>терпение</b> и <b>понимание</b>!

━━━━━━━━━━━━━━━━━━━━━━

📢 <b>Следите за обновлениями!</b>

<i>Команда разработчиков</i>`;
}

// ====== ХЕНДЛЕРЫ ======
bot.onText(/^\/start$/, (msg) => {
    bot.sendMessage(msg.chat.id, maintenanceMessage(), { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
});

bot.on('message', async (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    bot.sendMessage(msg.chat.id, maintenanceMessage(), { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
});

bot.on('callback_query', async (query) => {
    await bot.answerCallbackQuery(query.id);
    bot.sendMessage(query.message.chat.id, maintenanceMessage(), { 
        parse_mode: 'HTML',
        disable_web_page_preview: true
    });
});
