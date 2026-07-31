const { Bot, GrammyError, HttpError } = require("grammy");
const { Database } = require("sqlite3").verbose();
const express = require("express");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

// Конфигурация
const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_ID = 8976354028; // Хардкод ID админа
const PORT = process.env.PORT || 10000;

if (!BOT_TOKEN) {
    console.error("Критическая ошибка: BOT_TOKEN не задан в переменных окружения!");
    process.exit(1);
}

// Инициализация базы данных SQLite
const dbFile = path.join(__dirname, "monitor.db");
const db = new Database(dbFile, (err) => {
    if (err) {
        console.error("Ошибка открытия базы данных", err.message);
    } else {
        console.log("Подключено к базе данных SQLite.");
    }
});

// Создание таблиц
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        user_id INTEGER UNIQUE,
        username TEXT,
        first_name TEXT,
        last_name TEXT,
        phone TEXT,
        bio TEXT,
        last_seen_date TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        field_changed TEXT,
        old_value TEXT,
        new_value TEXT,
        change_date TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS monitored_groups (
        id INTEGER PRIMARY KEY,
        group_link TEXT UNIQUE,
        group_title TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_groups (
        user_id INTEGER,
        group_link TEXT,
        PRIMARY KEY (user_id, group_link)
    )`);
});

// Форматирование даты (только день, месяц, год)
function formatDate(date = new Date()) {
    const d = new Date(date);
    const day = String(d.getDate()).padStart(2, '0');
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const year = d.getFullYear();
    return `${day}.${month}.${year}`;
}

// Инициализация бота
const bot = new Bot(BOT_TOKEN);

// Обработка команды /start
bot.command("start", async (ctx) => {
    const userId = ctx.from.id;
    if (userId === ADMIN_ID) {
        await ctx.reply(
            "👑 Меню Администратора:\n\n" +
            "• Отправьте ссылку на чат/группу (например, https://t.me/group_name или @group), чтобы начать мониторинг.\n" +
            "• Команда /db — выгрузить полную базу данных пользователей и изменений в файле.\n" +
            "• Бот автоматически мониторит участников (до 500 в группе, до 100 групп)."
        );
    } else {
        await ctx.reply(
            "👋 Добро пожаловать!\n\n" +
            "Этот бот позволяет производить поиск пользователей Telegram по @username.\n" +
            "Просто отправьте @username, чтобы получить доступные данные, историю смены никнеймов и список групп, где пользователь был замечен."
        );
    }
});

// Команда /db для админа
bot.command("db", async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) {
        return ctx.reply("У вас нет прав для выполнения этой команды.");
    }

    const exportPath = path.join(__dirname, "export_db.txt");
    
    db.all("SELECT * FROM users", [], (err, users) => {
        if (err) {
            return ctx.reply("Ошибка при чтении базы данных.");
        }

        db.all("SELECT * FROM user_history", [], (err, history) => {
            if (err) {
                return ctx.reply("Ошибка при чтении истории.");
            }

            db.all("SELECT * FROM monitored_groups", [], (err, groups) => {
                let content = "=== ПОЛЬЗОВАТЕЛИ ===\n" + JSON.stringify(users, null, 2) + "\n\n";
                content += "=== ИСТОРИЯ ИЗМЕНЕНИЙ ===\n" + JSON.stringify(history, null, 2) + "\n\n";
                content += "=== МОНИТОРИРУЕМЫЕ ГРУППЫ ===\n" + JSON.stringify(groups, null, 2) + "\n";

                fs.writeFileSync(exportPath, content, "utf8");
                ctx.replyWithDocument(new InputFile(exportPath)).then(() => {
                    fs.unlinkSync(exportPath);
                }).catch(e => console.error("Ошибка отправки файла базы:", e));
            });
        });
    });
});

// Функция обновления или добавления пользователя и фиксация изменений
function trackUser(userObj, groupLink = null) {
    if (!userObj || !userObj.id) return;
    const userId = userObj.id;
    const username = userObj.username || "";
    const firstName = userObj.first_name || "";
    const lastName = userObj.last_name || "";
    const phone = userObj.phone_number || "";
    const bio = userObj.bio || "";
    const currentDate = formatDate();

    db.get("SELECT * FROM users WHERE user_id = ?", [userId], (err, row) => {
        if (err) return;

        if (!row) {
            // Новый пользователь
            db.run(
                `INSERT INTO users (user_id, username, first_name, last_name, phone, bio, last_seen_date) VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [userId, username, firstName, lastName, phone, bio, currentDate]
            );
            if (username) {
                db.run(`INSERT INTO user_history (user_id, field_changed, old_value, new_value, change_date) VALUES (?, ?, ?, ?, ?)`,
                    [userId, "username", "", username, currentDate]);
            }
        } else {
            // Существующий — проверяем изменения
            const changes = [];
            if (row.username !== username) {
                changes.push({ field: "username", old: row.username, new: username });
            }
            if (row.first_name !== firstName || row.last_name !== lastName) {
                changes.push({ field: "name", old: `${row.first_name} ${row.last_name}`, new: `${firstName} ${lastName}` });
            }
            if (phone && row.phone !== phone) {
                changes.push({ field: "phone", old: row.phone, new: phone });
            }
            if (bio && row.bio !== bio) {
                changes.push({ field: "bio", old: row.bio, new: bio });
            }

            changes.forEach(ch => {
                db.run(`INSERT INTO user_history (user_id, field_changed, old_value, new_value, change_date) VALUES (?, ?, ?, ?, ?)`,
                    [userId, ch.field, ch.old, ch.new, currentDate]);
            });

            db.run(
                `UPDATE users SET username = ?, first_name = ?, last_name = ?, phone = ?, bio = ?, last_seen_date = ? WHERE user_id = ?`,
                [username, firstName, lastName, phone || row.phone, bio || row.bio, currentDate, userId]
            );
        }

        if (groupLink) {
            db.run(`INSERT OR IGNORE INTO user_groups (user_id, group_link) VALUES (?, ?)`, [userId, groupLink]);
        }
    });
}

// Обработка текстовых сообщений (мониторинг групп от админа и поиск для обычных юзеров)
bot.on("message", async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text ? ctx.message.text.trim() : "";

    // Мониторинг входящих сообщений в группах, где бот состоит
    if (ctx.chat.type === "group" || ctx.chat.type === "supergroup") {
        trackUser(ctx.from, `https://t.me/${ctx.chat.username || ctx.chat.id}`);
        return;
    }

    // Личные сообщения
    if (userId === ADMIN_ID) {
        // Админ отправляет ссылку на группу для мониторинга
        if (text.startsWith("http://") || text.startsWith("https://") || text.startsWith("@")) {
            db.get("SELECT COUNT(*) as count FROM monitored_groups", [], (err, row) => {
                if (row && row.count >= 100) {
                    return ctx.reply("Достигнут лимит мониторинга групп (максимум 100).");
                }

                db.run(`INSERT OR IGNORE INTO monitored_groups (group_link, group_title) VALUES (?, ?)`, [text, text], (err) => {
                    if (err) {
                        return ctx.reply("Ошибка при добавлении группы в мониторинг.");
                    }
                    ctx.reply(`Группа/ссылка ${text} успешно добавлена в список мониторинга 24/7!`);
                });
            });
            return;
        }
    }

    // Поиск пользователя по @username для всех
    if (text.startsWith("@")) {
        const cleanUsername = text.replace("@", "");
        db.get("SELECT * FROM users WHERE username = ?", [cleanUsername], (err, user) => {
            if (err || !user) {
                return ctx.reply(`Пользователь @${cleanUsername} не найден в базе данных мониторинга. Бот продолжит отслеживать его при появлении в чатах.`);
            }

            db.all("SELECT * FROM user_history WHERE user_id = ?", [user.user_id], (err, history) => {
                db.all("SELECT group_link FROM user_groups WHERE user_id = ?", [user.user_id], (err, groups) => {
                    let response = `👤 Информация о пользователе: @${user.username || "нет"}\n`;
                    response += `🆔 ID: ${user.user_id}\n`;
                    response += `Имя: ${user.first_name} ${user.last_name || ""}\n`;
                    response += `Телефон: ${user.phone || "Не зафиксирован"}\n`;
                    response += `Био: ${user.bio || "Нет"}\n`;
                    response += `Последняя активность: ${user.last_seen_date}\n\n`;

                    response += `📜 История изменений:\n`;
                    if (history && history.length > 0) {
                        history.forEach(h => {
                            response += `- [${h.change_date}] Поле "${h.field_changed}": "${h.old_value}" ➡️ "${h.new_value}"\n`;
                        });
                    } else {
                        response += `Изменений не зафиксировано.\n`;
                    }

                    response += `\n🌐 Обнаружен в группах:\n`;
                    if (groups && groups.length > 0) {
                        groups.forEach(g => {
                            response += `- ${g.group_link}\n`;
                        });
                    } else {
                        response += `Нет данных о группах.\n`;
                    }

                    ctx.reply(response);
                });
            });
        });
        return;
    }

    if (userId === ADMIN_ID) {
        ctx.reply("Отправьте ссылку на группу для добавления в мониторинг.");
    } else {
        ctx.reply("Введите @username пользователя для поиска в базе данных.");
    }
});

// Создаем HTTP-сервер для Render.com (порт 10000)
const app = express();
app.get("/", (req, res) => {
    res.status(200).send("Telegram Monitor Bot is running and alive!");
});

app.listen(PORT, () => {
    console.log(`HTTP сервер запущен на порту ${PORT} для проверки работоспособности Render.`);
});

// Запуск бота с обработкой ошибок
bot.start({
    onStart: (botInfo) => {
        console.log(`Бот @${botInfo.username} успешно запущен и работает!`);
    }
}).catch((err) => {
    console.error("Ошибка при запуске бота:", err);
});
