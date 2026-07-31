const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');

// Получаем конфигурацию из переменных окружения
const token = process.env.BOT_TOKEN;
const session1Str = process.env.SESSION1 || '';
const ADMIN_ID = 8976354028;

if (!token) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: BOT_TOKEN не задан в переменной окружения!");
  process.exit(1);
}

// Инициализация Telegram бота для общения с пользователями
const bot = new TelegramBot(token, { polling: true });

// Файл локальной базы данных для сохранения историй профилей и мониторинга
const DB_FILE = 'database.json';
let db = {
  users: {}, // ключ - id или username: { usernames: [], names: [], bios: [], phones: [], lastSeen: ... }
  monitoredChats: [] // массив ссылок на чаты/группы
};

// Загрузка базы данных, если она существует
if (fs.existsSync(DB_FILE)) {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(data);
  } catch (err) {
    console.error("Ошибка при чтении базы данных, создаем новую:", err.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error("Ошибка при сохранении базы данных:", err.message);
  }
}

// Инициализация MTProto клиента (Userbot) для мониторинга чатов и сбора расширенных данных
let mtClient = null;
async function initUserBot() {
  if (!session1Str) {
    console.log("SESSION1 не найдена в переменных окружения. Функции мониторинга чатов через Userbot будут ограничены.");
    return;
  }
  try {
    const stringSession = new StringSession(session1Str);
    // Для работы используем заглушки api_id/api_hash (либо стандартные десктопные Telegram API ID/Hash для работы с сессиями)
    const apiId = 2040; 
    const apiHash = 'b18441a1ff607e10a989891a5462e627';
    
    mtClient = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });
    
    await mtClient.start({
      onError: (err) => console.log("Ошибка Userbot:", err),
    });
    console.log("Userbot успешно запущен и авторизован.");
  } catch (e) {
    console.error("Не удалось запустить Userbot с SESSION1:", e.message);
  }
}

initUserBot();

// Функция сохранения информации о пользователе в локальную базу
function updateUserInfo(userId, username, firstName, lastName, bio, phone) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {
      id: userId,
      usernames: [],
      names: [],
      bios: [],
      phones: [],
      firstSeen: new Date().toISOString()
    };
  }
  
  const userData = db.users[key];
  
  const currentUsername = username ? (username.startsWith('@') ? username : '@' + username) : null;
  if (currentUsername && !userData.usernames.includes(currentUsername)) {
    userData.usernames.push({ value: currentUsername, date: new Date().toISOString() });
  }
  
  const fullName = `${firstName || ''} ${lastName || ''}`.trim();
  if (fullName && (!userData.names.length || userData.names[userData.names.length - 1].value !== fullName)) {
    userData.names.push({ value: fullName, date: new Date().toISOString() });
  }
  
  if (bio && (!userData.bios.length || userData.bios[userData.bios.length - 1].value !== bio)) {
    userData.bios.push({ value: bio, date: new Date().toISOString() });
  }

  if (phone && (!userData.phones.length || userData.phones[userData.phones.length - 1].value !== phone)) {
    userData.phones.push({ value: phone, date: new Date().toISOString() });
  }
  
  saveDb();
}

// Обработчик команды /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId === ADMIN_ID) {
    bot.sendMessage(chatId, 
      `👨‍💻 Приветствую, Администратор!\n\n` +
      `Вам доступны специальные команды:\n` +
      `• Отправьте ссылку на группу (например, https://t.me/group_link или t.me/joinchat...), чтобы начать круглосуточный мониторинг участников (лимит до 100 групп, до 500 участников в каждой).\n` +
      `• /db — выгрузить файл со всеми собранными данными пользователей и историей изменений.`
    );
  } else {
    bot.sendMessage(chatId, 
      `🤖 Добро пожаловать в поисковый бот!\n\n` +
      `Этот бот позволяет производить поиск информации о пользователях Telegram по их @username.\n` +
      `Просто отправьте @username нужного пользователя, и бот покажет его ID, историю смены никнеймов, имён, био и другую доступную информацию.`
    );
  }
});

// Обработчик команды /db (доступен ТОЛЬКО админу)
bot.onText(/\/db/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "⛔ У вас нет прав для выполнения этой команды.");
  }

  try {
    const jsonString = JSON.stringify(db, null, 2);
    const buffer = Buffer.from(jsonString, 'utf8');
    
    await bot.sendDocument(chatId, buffer, {
      caption: `📊 Актуальная база данных мониторинга. Всего пользователей: ${Object.keys(db.users).length}, чатов под наблюдением: ${db.monitoredChats.length}`
    }, {
      filename: `database_${Date.now()}.json`,
      contentType: 'application/json'
    });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Ошибка при формировании файла базы данных: ${e.message}`);
  }
});

// Обработка сообщений и ссылок на чаты
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text ? msg.text.trim() : '';

  if (!text || text.startsWith('/')) return;

  // Если сообщение прислал администратор и это ссылка на чат/группу
  if (userId === ADMIN_ID && (text.includes('t.me/') || text.includes('telegram.me/'))) {
    if (db.monitoredChats.length >= 100) {
      return bot.sendMessage(chatId, "⚠️ Достигнут лимит мониторинга групп (максимум 100 групп).");
    }

    if (db.monitoredChats.includes(text)) {
      return bot.sendMessage(chatId, "ℹ️ Этот чат уже находится в списке мониторинга.");
    }

    db.monitoredChats.push(text);
    saveDb();

    bot.sendMessage(chatId, `✅ Чат успешно добавлен в список мониторинга!\n🔗 ${text}\n\nБот начал сбор информации об участниках.`);

    // Фоновый процесс сбора участников через Userbot
    if (mtClient) {
      setTimeout(async () => {
        try {
          const entity = await mtClient.getEntity(text);
          const participants = await mtClient.getParticipants(entity, { limit: 500 });
          
          for (const p of participants) {
            updateUserInfo(
              p.id.toString(),
              p.username,
              p.firstName,
              p.lastName,
              p.about || null,
              p.phone || null
            );
          }
          console.log(`Мониторинг: собрано ${participants.length} участников из чата ${text}`);
        } catch (err) {
          console.error(`Ошибка сбора участников из чата ${text}:`, err.message);
        }
      }, 1000);
    }
    return;
  }

  // Если пользователь ищет по @username
  if (text.startsWith('@') || !text.includes(' ')) {
    const searchUsername = text.startsWith('@') ? text : '@' + text;
    
    // Сначала ищем в локальной базе
    let foundUser = null;
    for (const key of Object.keys(db.users)) {
      const u = db.users[key];
      const match = u.usernames.some(item => item.value.toLowerCase() === searchUsername.toLowerCase());
      if (match) {
        foundUser = u;
        break;
      }
    }

    // Если нет в базе, но подключен Userbot - попробуем получить актуальные данные из Telegram
    if (!foundUser && mtClient) {
      try {
        const resolved = await mtClient.getEntity(searchUsername);
        if (resolved) {
          updateUserInfo(
            resolved.id.toString(),
            resolved.username,
            resolved.firstName,
            resolved.lastName,
            resolved.about || null,
            resolved.phone || null
          );
          // Повторный поиск после обновления
          for (const key of Object.keys(db.users)) {
            const u = db.users[key];
            if (u.id.toString() === resolved.id.toString()) {
              foundUser = u;
              break;
            }
          }
        }
      } catch (e) {
        console.error(`Не удалось разрешить юзернейм ${searchUsername} через Userbot:`, e.message);
      }
    }

    if (!foundUser) {
      return bot.sendMessage(chatId, `❌ Пользователь ${searchUsername} не найден в базе данных или в системе.`);
    }

    // Формируем подробный отчет
    let report = `👤 Информация о пользователе:\n`;
    report += `🆔 ID: \`${foundUser.id}\`\n`;
    report += `📅 Впервые замечен: ${new Date(foundUser.firstSeen).toLocaleString()}\n\n`;

    report += `🔤 История Usernames:\n`;
    if (foundUser.usernames.length > 0) {
      foundUser.usernames.forEach(u => {
        report += `• ${u.value} (изменено: ${new Date(u.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    report += `\n🏷 История имён:\n`;
    if (foundUser.names.length > 0) {
      foundUser.names.forEach(n => {
        report += `• ${n.value} (изменено: ${new Date(n.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    report += `\n📝 История Bio:\n`;
    if (foundUser.bios.length > 0) {
      foundUser.bios.forEach(b => {
        report += `• ${b.value} (изменено: ${new Date(b.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    report += `\n📞 Номера телефонов:\n`;
    if (foundUser.phones.length > 0) {
      foundUser.phones.forEach(ph => {
        report += `• ${ph.value} (обновлено: ${new Date(ph.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Скрыты / Нет данных\n`;
    }

    return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
  }
});

// Фоновый непрерывный мониторинг входящих сообщений во всех отслеживаемых группах через Userbot
async function startContinuousMonitoring() {
  if (!mtClient) return;
  
  try {
    mtClient.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || !message.senderId) return;
        
        const sender = await message.getSender();
        if (sender && sender.id) {
          updateUserInfo(
            sender.id.toString(),
            sender.username,
            sender.firstName,
            sender.lastName,
            sender.about || null,
            sender.phone || null
          );
        }
      } catch (err) {
        // Тихо игнорируем ошибки обработки отдельных служебных событий
      }
    });
    console.log("Непрерывный мониторинг сообщений участников запущен (24/7).");
  } catch (e) {
    console.error("Ошибка запуска непрерывного мониторинга:", e.message);
  }
}

// Запуск фонового мониторинга после старта клиента
setTimeout(() => {
  startContinuousMonitoring();
}, 5000);

console.log("Бот успешно инициализирован и ожидает запросы...");
