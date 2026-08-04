const { Telegraf } = require('telegraf');

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.start((ctx) => {
    ctx.reply(
        `🚧 Бот временно не работает!\n` +
        `🛠️ Ведутся технические работы\n` +
        `👨‍💻 Наши инженеры уже всё чинят\n\n` +
        `⏰ Попробуйте запустить бота завтра\n` +
        `🙏 Спасибо за понимание!\n\n` +
        `⭐ Мы скоро вернёмся ещё круче!`
    );
});

bot.launch()
    .then(() => console.log('🤖 Бот запущен...'))
    .catch((err) => console.error('❌ Ошибка:', err));

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
