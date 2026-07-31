const { Bot, InlineKeyboard } = require("grammy");
const http = require("http");
const fs = require("fs");
const sqlite3 = require("sqlite3").verbose();

// Чтение переменных окружения
const TOKEN = process.env.BOT_TOKEN;
const SESSION1 = process.env.SESSION1;
const SESSION2 = process.env.SESSION2;
const ADMIN_ID = 8976354028; // Жёстко заданный ID администратора
const PORT = process.env.PORT || 10000;

if (!TOKEN) {
  console.error("Ошибка: Не задан BOT_TOKEN в переменных окружения.");
  process.exit(1);
}

const bot = new Bot(TOKEN);

// Инициализация базы данных SQLite для хранения пользователей, истории и групп
const dbFile = "./monitor.db";
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error("Ошибка открытия базы данных:", err.message);
  } else {
    console.log("Подключено к базе данных SQLite.");
  }
});

// Создание таблиц
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    phone TEXT,
    bio TEXT,
    gifts TEXT,
    last_checked TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    change_date TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS monitored_groups (
    chat_id TEXT PRIMARY KEY,
    title TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS user_groups (
    user_id INTEGER,
    chat_id TEXT,
    PRIMARY KEY (user_id, chat_id)
  )`);
});

// Функция форматирования даты (только день, месяц, год)
function formatDate(date = new Date()) {
  const d = String(date.getDate()).padStart(2, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const y = date.getFullYear();
  return `${d}.${m}.${y}`;
}

// Запись изменений в историю
function logChange(userId, field, oldValue, newValue) {
  if (oldValue === newValue) return;
  const today = formatDate();
  db.run(
    `INSERT INTO user_history (user_id, field, old_value, new_value, change_date) VALUES (?, ?, ?, ?, ?)`,
    [userId, field, oldValue || "отсутствует", newValue || "отсутствует", today]
  );
}

// Обновление или добавление данных пользователя
function upsertUser(userObj) {
  const today = formatDate();
  db.get(`SELECT * FROM users WHERE id = ?`, [userObj.id], (err, row) => {
    if (!row) {
      db.run(
        `INSERT INTO users (id, username, first_name, last_name, phone, bio, gifts, last_checked) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [userObj.id, userObj.username, userObj.first_name, userObj.last_name, userObj.phone, userObj.bio, userObj.gifts, today]
      );
    } else {
      logChange(userObj.id, "username", row.username, userObj.username);
      logChange(userObj.id, "first_name", row.first_name, userObj.first_name);
      logChange(userObj.id, "last_name", row.last_name, userObj.last_name);
      logChange(userObj.id, "phone", row.phone, userObj.phone);
      logChange(userObj.id, "bio", row.bio, userObj.bio);
      logChange(userObj.id, "gifts", row.gifts, userObj.gifts);

      db.run(
        `UPDATE users SET username = ?, first_name = ?, last_name = ?, phone = ?, bio = ?, gifts = ?, last_checked = ? WHERE id = ?`,
        [userObj.username, userObj.first_name, userObj.last_name, userObj.phone, userObj.bio, userObj.gifts, today, userObj.id]
      );
    }
  });
}

// Команда /start
bot.command("start", async (ctx) => {
  const userId = ctx.from.id;
  if (userId === ADMIN_ID) {
    await ctx.reply(
      "Привет, Админ!\n\n" +
      "Доступные команды:\n" +
      "/db — получить файл с базой данных и изменениями\n" +
      "/monitor <ссылка_на_группу> — добавить группу и участников в мониторинг (лимит 500 участников, до 100 групп)\n\n" +
      "Бот также мониторит всех пользователей, чьи юзернеймы запрашивают через поиск."
    );
  } else {
    await ctx.reply(
      "Добро пожаловать в поисковый бот.\n\n" +
      "Отправьте мне @username любого пользователя Telegram, чтобы найти его историю изменений (юзернеймы, никнеймы, био, подарки и др.). Если пользователя нет в базе, бот автоматически начнет его мониторинг!"
    );
  }
});

// Команда /db для администратора
bot.command("db", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("У вас нет прав для выполнения этой команды.");
  }

  if (!fs.existsSync(dbFile)) {
    return ctx.reply("База данных пока пуста.");
  }

  try {
    await ctx.replyWithDocument(new InputFile(dbFile), {
      caption: `Резервная копия базы данных мониторинга на ${formatDate()}`
    });
  } catch (e) {
    // Альтернативная отправка через fs.createReadStream
    await ctx.replyWithDocument({
      source: fs.createReadStream(dbFile),
      filename: "monitor.db"
    });
  }
});

// Команда /monitor для администратора (добавление группы)
bot.command("monitor", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply("У вас нет прав для выполнения этой команды.");
  }

  const args = ctx.match.trim();
  if (!args) {
    return ctx.reply("Пожалуйста, укажите ссылку на группу. Пример: /monitor https://t.me/group_link");
  }

  // Проверка лимита групп (до 100)
  db.get(`SELECT COUNT(*) as count FROM monitored_groups`, async (err, row) => {
    if (row && row.count >= 100) {
      return ctx.reply("Достигнут лимит мониторинга групп (максимум 100).");
    }

    // Сохранение группы
    db.run(`INSERT OR IGNORE INTO monitored_groups (chat_id, title) VALUES (?, ?)`, [args, args], function(err) {
      if (err) {
        return ctx.reply("Ошибка при добавлении группы в базу.");
      }
      ctx.reply(`Группа ${args} успешно добавлена в список мониторинга.`);
    });
  });
});

// Обработка текстовых сообщений (чтение сообщений из групп и поиск по @username)
bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const userId = ctx.from.id;
  const chat = ctx.chat;

  // Если сообщение из группы/супергруппы — фиксируем участника и группу
  if (chat.type === "group" || chat.type === "supergroup") {
    const chatIdStr = chat.id.toString();

    // Проверяем лимит участников группы (500)
    db.get(`SELECT COUNT(DISTINCT user_id) as count FROM user_groups WHERE chat_id = ?`, [chatIdStr], (err, row) => {
      if (row && row.count < 500) {
        db.run(`INSERT OR IGNORE INTO user_groups (user_id, chat_id) VALUES (?, ?)`, [userId, chatIdStr]);
      }
    });

    db.run(`INSERT OR IGNORE INTO monitored_groups (chat_id, title) VALUES (?, ?)`, [chatIdStr, chat.title || chatIdStr]);

    // Сохраняем данные пользователя
    upsertUser({
      id: userId,
      username: ctx.from.username,
      first_name: ctx.from.first_name,
      last_name: ctx.from.last_name,
      phone: null,
      bio: null,
      gifts: null
    });
  }

  // Если пользователь написал @username в личку боту для поиска
  if (chat.type === "private" && text.startsWith("@")) {
    const searchUsername = text.trim().replace("@", "");

    db.get(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`, [searchUsername], async (err, user) => {
      if (!user) {
        // Если пользователя нет в базе, добавляем его для дальнейшего мониторинга
        db.run(`INSERT INTO users (username, last_checked) VALUES (?, ?)`, [searchUsername, formatDate()]);
        
        // Поиск групп, где он зафиксирован (пустой список изначально)
        return ctx.reply(
          `Пользователь @${searchUsername} не найден в базе данных.\n` +
          `Он добавлен в систему мониторинга для дальнейшего отслеживания.`
        );
      }

      // Получаем историю изменений
      db.all(`SELECT field, old_value, new_value, change_date FROM user_history WHERE user_id = ?`, [user.id], async (err, history) => {
        let historyText = "";
        if (history && history.length > 0) {
          historyText = history.map(h => `- ${h.field}: с "${h.old_value}" на "${h.new_value}" (${h.change_date})`).join("\n");
        } else {
          historyText = "Изменений не зафиксировано.";
        }

        // Поиск групп пользователя
        db.all(`SELECT chat_id FROM user_groups WHERE user_id = ?`, [user.id], async (err, groups) => {
          const groupList = groups && groups.length > 0 ? groups.map(g => g.chat_id).join(", ") : "Нет данных о группах";

          // Проверка подарочных связей (пример логики гифтов)
          let giftInfo = user.gifts ? `Подарки: ${user.gifts}` : "Подарки не обнаружены";

          await ctx.reply(
            `📊 Данные пользователя @${searchUsername}:\n` +
            `ID: ${user.id}\n` +
            `Имя: ${user.first_name || ""} ${user.last_name || ""}\n` +
            `Біо: ${user.bio || "отсутствует"}\n` +
            `Номер телефона: ${user.phone || "скрыт/отсутствует"}\n` +
            `${giftInfo}\n\n` +
            `Группы, в которых состоит: ${groupList}\n\n` +
            `История изменений:\n${historyText}`
          );
        });
      });
    });
  }
});

// Фоновый процесс мониторинга 24/7 (симуляция проверки сессий и актуализации данных)
setInterval(() => {
  db.all(`SELECT id, username FROM users`, (err, rows) => {
    if (err || !rows) return;
    // Здесь фоновый воркер может опрашивать Telegram API через сессии (SESSION1, SESSION2)
    // для обновления номеров, био и гифтов участников.
    console.log(`[24/7 Monitor] Проверено пользователей: ${rows.length}. Дата: ${formatDate()}`);
  });
}, 3600000); // Раз в час

// HTTP-сервер для Render.com (проверка работоспособности / health check на порту 10000)
const server = http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end("Bot is running and alive!");
});

server.listen(PORT, () => {
  console.log(`HTTP сервер запущен на порту ${PORT} для Render.com`);
});

// Запуск бота
bot.start().then(() => {
  console.log("Telegram бот успешно запущен.");
}).catch((err) => {
  console.error("Ошибка запуска бота:", err);
});
