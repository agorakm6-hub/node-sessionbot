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

// ===== HTTP-СЕРВЕР ДЛЯ RENDER =====
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'online', 
      version: '2.0.0',
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
  giftConnections: []
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

// ===== USERBOT С БЫСТРЫМ ЗАПУСКОМ =====
let mtClient = null;
let isReady = false;

async function initUserBot() {
  if (!session1Str) {
    console.log("SESSION1 не найдена. Мониторинг ограничен.");
    return;
  }
  try {
    const stringSession = new StringSession(session1Str);
    const apiId = 2040;
    const apiHash = 'b18441a1ff607e10a989891a5462e627';
    
    mtClient = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
      floodSleepThreshold: 5
    });
    
    await mtClient.start({
      onError: (err) => console.log("Ошибка Userbot:", err),
    });
    isReady = true;
    console.log("✅ Userbot успешно авторизован.");
    
    // Запускаем мониторинг сразу
    startContinuousMonitoring();
    
  } catch (e) {
    console.error("Не удалось запустить Userbot:", e.message);
  }
}

initUserBot();

// ===== БЫСТРОЕ ОБНОВЛЕНИЕ ПОЛЬЗОВАТЕЛЯ =====
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
      lastSeen: new Date().toISOString(),
      gifts: [] // Добавляем массив подарков прямо в профиль
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

// ===== БЫСТРАЯ ПРОВЕРКА ПОДАРКОВ (КЭШИРОВАНИЕ) =====
const giftCache = new Map();

async function checkGiftsFast(userId) {
  try {
    // Проверяем кэш (не чаще раза в час)
    const cacheKey = String(userId);
    const lastCheck = giftCache.get(cacheKey);
    if (lastCheck && (Date.now() - lastCheck) < 3600000) {
      return;
    }
    giftCache.set(cacheKey, Date.now());

    const entity = await mtClient.getEntity(Number(userId));
    const gifts = await mtClient.invoke({
      _: 'users.getGifts',
      user_id: entity.id,
      limit: 50
    });

    if (gifts && gifts.gifts) {
      const userData = db.users[String(userId)];
      if (!userData) return;
      
      if (!userData.gifts) {
        userData.gifts = [];
      }

      for (const gift of gifts.gifts) {
        const isNFT = gift.flags & 1 << 0;
        const fromId = gift.from_id?.user_id?.toString();
        const giftId = gift.id;
        
        // Проверяем, не записан ли уже этот подарок
        const exists = userData.gifts.some(g => g.giftId === giftId);
        if (!exists && fromId) {
          userData.gifts.push({
            from: fromId,
            giftId: giftId,
            date: new Date().toISOString(),
            type: isNFT ? 'nft' : 'regular'
          });
          
          // Проверяем на взаимную связь
          const fromUser = db.users[fromId];
          if (fromUser && fromUser.gifts) {
            const mutual = fromUser.gifts.some(g => g.from === String(userId));
            if (mutual) {
              // Взаимная подарочная связь!
              const fromName = fromUser.usernames?.[0]?.value || fromId;
              const toName = userData.usernames?.[0]?.value || userId;
              
              db.giftConnections.push({
                from: fromId,
                to: String(userId),
                date: new Date().toISOString(),
                mutual: true
              });
              
              // Уведомление админу
              bot.sendMessage(ADMIN_ID, 
                `🎁 **ВЗАИМНАЯ ПОДАРОЧНАЯ СВЯЗЬ!**\n\n` +
                `🔄 ${fromName} (${fromId}) ⇄ ${toName} (${userId})\n` +
                `📅 Обнаружено: ${new Date().toLocaleString()}\n` +
                `📊 Тип: ${isNFT ? 'NFT' : 'Обычный'}`
              , { parse_mode: 'Markdown' });
            }
          }
        }
      }
      saveDb();
    }
  } catch (e) {
    // Тихо пропускаем ошибки
  }
}

// ===== СУПЕР-БЫСТРЫЙ СБОР ВСЕХ УЧАСТНИКОВ =====
async function fastCollectAllParticipants(chatLink) {
  if (!mtClient || !isReady) return;
  
  try {
    const entity = await mtClient.getEntity(chatLink);
    const participants = await mtClient.getParticipants(entity, { 
      limit: 1000,
      aggressive: true // Максимальная скорость
    });
    
    console.log(`📊 Собираю ${participants.length} участников из ${chatLink}`);
    
    // Параллельная обработка
    const promises = participants.map(async (p) => {
      try {
        const userId = p.id.toString();
        updateUserInfo(
          userId,
          p.username,
          p.firstName,
          p.lastName,
          p.about || null,
          p.phone || null
        );
        
        // Быстрая проверка подарков (асинхронно, не блокирует)
        if (Math.random() < 0.05) { // 5% шанс проверить подарки
          await checkGiftsFast(userId);
        }
      } catch (e) {
        // Игнорируем ошибки отдельных пользователей
      }
    });
    
    // Запускаем все параллельно
    await Promise.all(promises);
    console.log(`✅ Быстрый сбор завершен: ${participants.length} участников`);
    
  } catch (e) {
    console.error(`Ошибка быстрого сбора:`, e.message);
  }
}

// ===== /START =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId === ADMIN_ID) {
    bot.sendMessage(chatId, 
      `👨‍💻 **Ryzen Monitor v2.0**\n\n` +
      `🚀 **Супер-быстрый мониторинг**\n` +
      `• Отправьте ссылку на группу → моментальный сбор всех участников\n` +
      `• Автоматическая проверка подарков у всех\n` +
      `• Обнаружение взаимных подарочных связей\n\n` +
      `📊 Команды:\n` +
      `• /db — выгрузить БД\n` +
      `• /stats — статистика системы\n\n` +
      `🔍 Для поиска просто отправьте @username`
    , { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, 
      `🤖 **Ryzen Search Bot**\n\n` +
      `🔍 Отправьте @username для поиска\n` +
      `📊 Показывает: ID, историю смены данных, подарки и связи`
    , { parse_mode: 'Markdown' });
  }
});

// ===== /STATS =====
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) return;

  const totalUsers = Object.keys(db.users).length;
  const totalGifts = db.giftConnections.length;
  const totalChats = db.monitoredChats.length;
  
  let usersWithGifts = 0;
  for (const key of Object.keys(db.users)) {
    if (db.users[key].gifts && db.users[key].gifts.length > 0) {
      usersWithGifts++;
    }
  }

  bot.sendMessage(chatId,
    `📊 **Статистика Ryzen Monitor**\n\n` +
    `👤 Всего пользователей: ${totalUsers}\n` +
    `🎁 Пользователей с подарками: ${usersWithGifts}\n` +
    `🔄 Взаимных связей: ${totalGifts}\n` +
    `💬 Чатов в мониторинге: ${totalChats}\n` +
    `⏱ Аптайм: ${Math.round(process.uptime() / 60)} минут\n\n` +
    `⚡️ Система работает на максимальной скорости`
  , { parse_mode: 'Markdown' });
});

// ===== /DB =====
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
      caption: `📊 База данных Ryzen\nПользователей: ${Object.keys(db.users).length}\nСвязей: ${db.giftConnections.length}`
    }, {
      filename: `database_${Date.now()}.json`,
      contentType: 'application/json'
    });
  } catch (e) {
    bot.sendMessage(chatId, `❌ Ошибка: ${e.message}`);
  }
});

// ===== ОБРАБОТКА СООБЩЕНИЙ =====
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text ? msg.text.trim() : '';

  if (!text || text.startsWith('/')) return;

  // === ДОБАВЛЕНИЕ ГРУППЫ (МГНОВЕННЫЙ СБОР) ===
  if (userId === ADMIN_ID && (text.includes('t.me/') || text.includes('telegram.me/'))) {
    if (db.monitoredChats.length >= 100) {
      return bot.sendMessage(chatId, "⚠️ Лимит 100 групп.");
    }

    if (db.monitoredChats.includes(text)) {
      return bot.sendMessage(chatId, "ℹ️ Уже в мониторинге.");
    }

    db.monitoredChats.push(text);
    saveDb();

    bot.sendMessage(chatId, `✅ Чат добавлен. Начинаю МГНОВЕННЫЙ сбор всех участников...`);
    
    // Запускаем супер-быстрый сбор
    await fastCollectAllParticipants(text);
    
    bot.sendMessage(chatId, `✅ Сбор завершен! Все участники в БД.`);
    return;
  }

  // === ПОИСК ПО @USERNAME С ПОДАРКАМИ ===
  if (text.startsWith('@') || !text.includes(' ')) {
    const searchUsername = text.startsWith('@') ? text : '@' + text;
    
    // Сначала ищем в БД
    let foundUser = null;
    let foundKey = null;
    for (const key of Object.keys(db.users)) {
      const u = db.users[key];
      if (u.usernames.some(item => item.value.toLowerCase() === searchUsername.toLowerCase())) {
        foundUser = u;
        foundKey = key;
        break;
      }
    }

    // Если нет в БД — пытаемся найти через Userbot
    if (!foundUser && mtClient && isReady) {
      try {
        const resolved = await mtClient.getEntity(searchUsername);
        if (resolved) {
          const userIdStr = resolved.id.toString();
          updateUserInfo(
            userIdStr,
            resolved.username,
            resolved.firstName,
            resolved.lastName,
            resolved.about || null,
            resolved.phone || null
          );
          
          // Быстрая проверка подарков
          await checkGiftsFast(userIdStr);
          
          // Находим в БД
          foundUser = db.users[userIdStr];
          foundKey = userIdStr;
        }
      } catch (e) {
        console.error(`Ошибка поиска ${searchUsername}:`, e.message);
      }
    }

    if (!foundUser) {
      return bot.sendMessage(chatId, `❌ Пользователь ${searchUsername} не найден.`);
    }

    // ===== ФОРМИРУЕМ ОТЧЁТ С ПОДАРКАМИ =====
    let report = `👤 **${searchUsername}**\n`;
    report += `🆔 ID: \`${foundUser.id}\`\n`;
    report += `📅 Впервые: ${new Date(foundUser.firstSeen).toLocaleString()}\n\n`;

    // Usernames
    report += `🔤 **История Usernames:**\n`;
    if (foundUser.usernames.length) {
      foundUser.usernames.slice(-5).forEach(u => {
        report += `• ${u.value} (${new Date(u.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    // Имена
    report += `\n🏷 **История имён:**\n`;
    if (foundUser.names.length) {
      foundUser.names.slice(-5).forEach(n => {
        report += `• ${n.value} (${new Date(n.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    // Bio
    report += `\n📝 **Bio:**\n`;
    if (foundUser.bios.length) {
      foundUser.bios.slice(-3).forEach(b => {
        report += `• ${b.value} (${new Date(b.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Нет данных\n`;
    }

    // ===== ПОДАРКИ (ИНТЕГРИРОВАНЫ В ОСНОВНОЙ ОТЧЁТ) =====
    if (foundUser.gifts && foundUser.gifts.length > 0) {
      report += `\n🎁 **Подарки (${foundUser.gifts.length}):**\n`;
      
      // Показываем последние 5 подарков
      const sortedGifts = [...foundUser.gifts].sort((a, b) => 
        new Date(b.date) - new Date(a.date)
      ).slice(0, 5);
      
      for (const gift of sortedGifts) {
        const fromUser = db.users[gift.from];
        const fromName = fromUser?.usernames?.[0]?.value || gift.from;
        
        // Проверяем, есть ли взаимная связь
        const isMutual = db.giftConnections.some(g => 
          (g.from === gift.from && g.to === foundUser.id)
        );
        
        report += `• ${gift.type === 'nft' ? '💎 NFT' : '🎁 Обычный'} подарок от ${fromName}`;
        if (isMutual) {
          report += ` 🔄 **ВЗАИМНАЯ СВЯЗЬ!**`;
        }
        report += ` (${new Date(gift.date).toLocaleString()})\n`;
      }
      
      if (foundUser.gifts.length > 5) {
        report += `• ... и ещё ${foundUser.gifts.length - 5} подарков\n`;
      }
    } else {
      report += `\n🎁 **Подарки:** Нет данных\n`;
    }

    // Телефоны
    report += `\n📞 **Телефоны:**\n`;
    if (foundUser.phones.length) {
      foundUser.phones.slice(-2).forEach(ph => {
        report += `• ${ph.value} (${new Date(ph.date).toLocaleString()})\n`;
      });
    } else {
      report += `• Скрыты\n`;
    }

    // Статистика
    report += `\n📊 **Статистика:**\n`;
    report += `• Всего подарков: ${foundUser.gifts?.length || 0}\n`;
    const mutualCount = db.giftConnections.filter(g => 
      g.from === foundUser.id || g.to === foundUser.id
    ).length;
    report += `• Взаимных связей: ${mutualCount}`;

    return bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
  }
});

// ===== КРУГЛОСУТОЧНЫЙ МОНИТОРИНГ (МАКСИМАЛЬНАЯ СКОРОСТЬ) =====
async function startContinuousMonitoring() {
  if (!mtClient || !isReady) {
    setTimeout(startContinuousMonitoring, 5000);
    return;
  }
  
  try {
    // Мониторинг всех сообщений
    mtClient.addEventHandler(async (event) => {
      try {
        const message = event.message;
        if (!message || !message.senderId) return;
        
        const sender = await message.getSender();
        if (sender && sender.id) {
          const userId = sender.id.toString();
          
          // Быстрое обновление
          updateUserInfo(
            userId,
            sender.username,
            sender.firstName,
            sender.lastName,
            sender.about || null,
            sender.phone || null
          );
          
          // Проверка подарков (редко, чтобы не флудить)
          if (Math.random() < 0.02) { // 2% шанс
            await checkGiftsFast(userId);
          }
        }
      } catch (err) {
        // Игнорируем
      }
    });
    
    // Периодический пересбор всех участников из групп (каждые 30 минут)
    setInterval(async () => {
      console.log("🔄 Пересбор всех участников...");
      for (const chatLink of db.monitoredChats) {
        await fastCollectAllParticipants(chatLink);
      }
    }, 1800000); // 30 минут
    
    console.log("✅ Супер-быстрый мониторинг 24/7 запущен!");
  } catch (e) {
    console.error("Ошибка мониторинга:", e.message);
  }
}

// Запускаем через 2 секунды
setTimeout(startContinuousMonitoring, 2000);

console.log("🚀 Ryzen Monitor v2.0 (Super Fast) запущен!");
console.log(`📊 Порт: ${PORT}, пользователей: ${Object.keys(db.users).length}`);
