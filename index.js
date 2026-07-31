const TelegramBot = require('node-telegram-bot-api');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const fs = require('fs');
const http = require('http');

// ===== КОНФИГУРАЦИЯ =====
const token = process.env.BOT_TOKEN;
const session1Str = process.env.SESSION1 || '';
const ADMIN_ID = 8976354028;
const PORT = process.env.PORT || 10000;

if (!token) {
  console.error("КРИТИЧЕСКАЯ ОШИБКА: BOT_TOKEN не задан!");
  process.exit(1);
}

// ===== HTTP-СЕРВЕР ДЛЯ RENDER (HEALTH CHECK) =====
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'online', 
      version: '1.0.0',
      users: Object.keys(db?.users || {}).length,
      chats: db?.monitoredChats?.length || 0,
      uptime: process.uptime()
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`✅ Health check server running on port ${PORT}`);
});

// ===== БОТ И БАЗА ДАННЫХ =====
const bot = new TelegramBot(token, { polling: true });
const DB_FILE = 'database.json';

let db = {
  users: {},
  monitoredChats: [],
  giftConnections: [] // [{ from: id, to: id, giftId, date, type: 'nft'|'regular' }]
};

if (fs.existsSync(DB_FILE)) {
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    db = JSON.parse(data);
  } catch (err) {
    console.error("Ошибка при чтении БД:", err.message);
  }
}

function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2), 'utf8');
  } catch (err) {
    console.error("Ошибка при сохранении БД:", err.message);
  }
}

// ===== USERBOT =====
let mtClient = null;
async function initUserBot() {
  if (!session1Str) {
    console.log("SESSION1 не найдена. Мониторинг через Userbot ограничен.");
    return;
  }
  try {
    const stringSession = new StringSession(session1Str);
    const apiId = 2040;
    const apiHash = 'b18441a1ff607e10a989891a5462e627';
    
    mtClient = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });
    
    await mtClient.start({
      onError: (err) => console.log("Ошибка Userbot:", err),
    });
    console.log("✅ Userbot успешно авторизован.");
  } catch (e) {
    console.error("Не удалось запустить Userbot:", e.message);
  }
}

initUserBot();

// ===== ФУНКЦИЯ ОБНОВЛЕНИЯ ПОЛЬЗОВАТЕЛЯ =====
function updateUserInfo(userId, username, firstName, lastName, bio, phone) {
  const key = String(userId);
  if (!db.users[key]) {
    db.users[key] = {
      id: userId,
      usernames: [],
      names: [],
      bios: [],
      phones: [],
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString()
    };
  }
  
  const userData = db.users[key];
  userData.lastSeen = new Date().toISOString();
  
  const currentUsername = username ? (username.startsWith('@') ? username : '@' + username) : null;
  if (currentUsername && !userData.usernames.some(u => u.value === currentUsername)) {
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

// ===== ОТСЛЕЖИВАНИЕ ПОДАРКОВ (GIFTS) =====
async function checkGifts(entity) {
  try {
    // Получаем подарки пользователя (через MTProto)
    const gifts = await mtClient.invoke({
      _: 'users.getGifts',
      user_id: entity.id,
      limit: 50
    });

    if (gifts && gifts.gifts) {
      for (const gift of gifts.gifts) {
        const isNFT = gift.flags & 1 << 0; // флаг NFT
        const fromId = gift.from_id?.user_id?.toString();
        const toId = entity.id.toString();
        const giftId = gift.id;

        // Проверяем, не зарегистрирована ли уже эта связь
        const exists = db.giftConnections.some(g => g.giftId === giftId);
        if (!exists && fromId) {
          db.giftConnections.push({
            from: fromId,
            to: toId,
            giftId: giftId,
            date: new Date().toISOString(),
            type: isNFT ? 'nft' : 'regular'
          });
          saveDb();

          // Если есть взаимная связь (оба дарили друг другу)
          const mutual = db.giftConnections.some(g => 
            g.from === toId && g.to === fromId
          );
          
          if (mutual) {
            const fromUser = db.users[fromId];
            const toUser = db.users[toId];
            const fromName = fromUser?.usernames?.[0]?.value || fromId;
            const toName = toUser?.usernames?.[0]?.value || toId;
            
            // Уведомляем админа о подарочной связи
            bot.sendMessage(ADMIN_ID, 
              `🎁 **Обнаружена подарочная связь!**\n\n` +
              `🔄 Взаимный обмен подарками:\n` +
              `• ${fromName} (ID: ${fromId}) → ${toName} (ID: ${toId})\n` +
              `• ${toName} (ID: ${toId}) → ${fromName} (ID: ${fromId})\n\n` +
              `📅 Дата: ${new Date().toLocaleString()}\n` +
              `🏷 Тип: ${isNFT ? 'NFT' : 'Обычный'}`
            , { parse_mode: 'Markdown' });
          }
        }
      }
    }
  } catch (e) {
    console.error(`Ошибка при проверке подарков для ${entity.id}:`, e.message);
  }
}

// ===== КОМАНДА /START =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId === ADMIN_ID) {
    bot.sendMessage(chatId, 
      `👨‍💻 **Администратор Ryzen Monitor**\n\n` +
      `Доступные команды:\n` +
      `• Отправьте ссылку на группу (t.me/...) → добавить в мониторинг (до 100 групп, до 500 участников)\n` +
      `• /db — выгрузить полную базу данных\n` +
      `• /gifts — проверить последние подарки у всех отслеживаемых\n\n` +
      `🔄 Система работает 24/7, анализирует участников и подарочные связи.`
    , { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, 
      `🤖 **Поисковый бот Ryzen**\n\n` +
      `Отправьте @username для поиска информации.\n` +
      `Если пользователь не найден — бот начнёт его мониторить.`
    , { parse_mode: 'Markdown' });
  }
});

// ===== КОМАНДА /DB =====
bot.onText(/\/db/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "⛔ Нет прав.");
  }

  try {
    const jsonString = JSON.stringify(db, null, 2);
    const buffer = Buffer.from(jsonString, 'utf8');
    
    await bot.sendDocument(chatId, buffer, {
      caption: `📊 База данных. Пользователей: ${Object.keys(db.users).length}, чатов: ${db.monitoredChats.length}, связей: ${db.giftConnections.length}`
    }, {
      filename: `database_${Date.now()}.json`,
      contentType: 'application/json'
    });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
  }
});

// ===== КОМАНДА /GIFTS =====
bot.onText(/\/gifts/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) return;

  if (!mtClient) {
    return bot.sendMessage(chatId, "❌ Userbot не активен, проверьте SESSION1.");
  }

  bot.sendMessage(chatId, "⏳ Проверяю подарки у всех отслеживаемых пользователей...");

  let checked = 0;
  for (const key of Object.keys(db.users)) {
    const user = db.users[key];
    try {
      const entity = await mtClient.getEntity(Number(user.id));
      await checkGifts(entity);
      checked++;
      if (checked % 10 === 0) {
        bot.sendMessage(chatId, `✅ Проверено ${checked} пользователей...`);
      }
    } catch (e) {
      // Пропускаем пользователей, которых нельзя получить
    }
  }

  bot.sendMessage(chatId, 
    `✅ **Проверка завершена!**\n` +
    `📊 Проверено: ${checked} пользователей\n` +
    `🎁 Найдено связей: ${db.giftConnections.length}`
  , { parse_mode: 'Markdown' });
});

// ===== ОБРАБОТКА СООБЩЕНИЙ =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text ? msg.text.trim() : '';

  if (!text || text.startsWith('/')) return;

  // === ДОБАВЛЕНИЕ ГРУППЫ В МОНИТОРИНГ ===
  if (userId === ADMIN_ID && (text.includes('t.me/') || text.includes('telegram.me/'))) {
    if (db.monitoredChats.length >= 100) {
      return bot.sendMessage(chatId, "⚠️ Лимит 100 групп.");
    }

    if (db.monitoredChats.includes(text)) {
      return bot.sendMessage(chatId, "ℹ️ Уже в мониторинге.");
    }

    db.monitoredChats.push(text);
    saveDb();

    bot.sendMessage(chatId, `✅ Чат добавлен в мониторинг: ${text}`);

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
            // Проверяем подарки у каждого участника
            await checkGifts(p);
          }
          console.log(`✅ Собрано ${participants.length} участников из ${text}`);
          bot.sendMessage(chatId, `✅ Собрано ${participants.length} участников. Проверены подарки.`);
        } catch (err) {
          console.error(`Ошибка сбора из ${text}:`, err.message);
        }
      }, 1000);
    }
    return;
  }

  // === ПОИСК ПО @USERNAME ===
  if (text.startsWith('@') || !text.includes(' ')) {
    const searchUsername = text.startsWith('@') ? text : '@' + text;
    
    let foundUser = null;
    for (const key of Object.keys(db.users)) {
      const u = db.users[key];
      if (u.usernames.some(item => item.value.toLowerCase() === searchUsername.toLowerCase())) {
        foundUser = u;
        break;
      }
    }

    // Если не найден — пытаемся через Userbot и начинаем мониторинг
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
          await checkGifts(resolved); // Проверяем подарки
          
          // Повторный поиск
          for (const key of Object.keys(db.users)) {
            const u = db.users[key];
            if (u.id.toString() === resolved.id.toString()) {
              foundUser = u;
              break;
            }
          }
          
          bot.sendMessage(chatId, `🔍 Пользователь ${searchUsername} найден и добавлен в мониторинг.`);
        }
      } catch (e) {
        console.error(`Не удалось найти ${searchUsername}:`, e.message);
      }
    }

    if (!foundUser) {
      return bot.sendMessage(chatId, `❌ Пользователь ${searchUsername} не найден.`);
    }

    // Формируем отчёт
    let report = `👤 **Информация о пользователе**\n`;
    report += `🆔 ID: \`${foundUser.id}\`\n`;
    report += `📅 Впервые: ${new Date(foundUser.firstSeen).toLocaleString()}\n`;
    report += `🕒 Последний раз: ${new Date(foundUser.lastSeen).toLocaleString()}\n\n`;

    report += `🔤 **Usernames:**\n`;
    if (foundUser.usernames.length) {
      foundUser.usernames.forEach(u => {
        report += `• ${u.value} (${new Date(u.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    report += `\n🏷 **Имена:**\n`;
    if (foundUser.names.length) {
      foundUser.names.forEach(n => {
        report += `• ${n.value} (${new Date(n.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    report += `\n📝 **Bio:**\n`;
    if (foundUser.bios.length) {
      foundUser.bios.slice(-3).forEach(b => {
        report += `• ${b.value} (${new Date(b.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    report += `\n📞 **Телефоны:**\n`;
    if (foundUser.phones.length) {
      foundUser.phones.slice(-2).forEach(ph => {
        report += `• ${ph.value} (${new Date(ph.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Скрыты\n`;
    }

    // Проверяем подарочные связи для этого пользователя
    const userGifts = db.giftConnections.filter(g => g.from === foundUser.id || g.to === foundUser.id);
    if (userGifts.length) {
      report += `\n🎁 **Подарки (${userGifts.length}):**\n`;
      userGifts.slice(-3).forEach(g => {
        const partnerId = g.from === foundUser.id ? g.to : g.from;
        const partner = db.users[partnerId];
        const partnerName = partner?.usernames?.[0]?.value || partnerId;
        report += `• ${g.from === foundUser.id ? 'Отправил' : 'Получил'} ${g.type === 'nft' ? 'NFT' : 'обычный'} подарок ${g.from === foundUser.id ? '→' : '←'} ${partnerName} (${new Date(g.date).toLocaleString()})\n`;
      });
    }

    return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
  }
});

// ===== НЕПРЕРЫВНЫЙ МОНИТОРИНГ 24/7 =====
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
          
          // Периодическая проверка подарков (раз в час для активных)
          if (Math.random() < 0.01) { // 1% шанс при каждом сообщении
            await checkGifts(sender);
          }
        }
      } catch (err) {
        // Игнорируем
      }
    });
    console.log("✅ Непрерывный мониторинг 24/7 запущен.");
  } catch (e) {
    console.error("Ошибка запуска мониторинга:", e.message);
  }
}

setTimeout(() => {
  startContinuousMonitoring();
}, 5000);

console.log("🚀 Ryzen Monitor успешно инициализирован!");
console.log(`📊 Порт: ${PORT}, пользователей в БД: ${Object.keys(db.users).length}`);
