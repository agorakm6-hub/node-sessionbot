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
      version: '3.0.0',
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
  giftConnections: [],
  lastActivity: Date.now()
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
    
    startContinuousMonitoring();
    startAntiSleep();
    startActiveParking();
    
  } catch (e) {
    console.error("Не удалось запустить Userbot:", e.message);
  }
}

initUserBot();

// ===== ОБНОВЛЕНИЕ ПОЛЬЗОВАТЕЛЯ =====
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
      gifts: []
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

// ===== ПРАВИЛЬНАЯ ПРОВЕРКА ПОДАРКОВ =====
async function checkGiftsCorrect(userId) {
  try {
    const entity = await mtClient.getEntity(Number(userId));
    
    // Пытаемся получить информацию о подарках через разные методы
    let gifts = null;
    
    // Метод 1: Прямой запрос к API
    try {
      const result = await mtClient.invoke({
        _: 'users.getGifts',
        user_id: entity.id,
        limit: 100
      });
      gifts = result;
    } catch (e) {
      // Метод 2: Через getFullUser
      try {
        const fullUser = await mtClient.invoke({
          _: 'users.getFullUser',
          id: entity.id
        });
        if (fullUser && fullUser.gifts) {
          gifts = { gifts: fullUser.gifts };
        }
      } catch (e2) {
        // Метод 3: Через getGifts (альтернативный)
        try {
          const result = await mtClient.invoke({
            _: 'payments.getGifts',
            user_id: entity.id
          });
          gifts = result;
        } catch (e3) {
          // Игнорируем
        }
      }
    }

    if (gifts && gifts.gifts && gifts.gifts.length > 0) {
      const userData = db.users[String(userId)];
      if (!userData) return;
      
      if (!userData.gifts) {
        userData.gifts = [];
      }

      for (const gift of gifts.gifts) {
        const isNFT = gift.flags & 1 << 0;
        const fromId = gift.from_id?.user_id?.toString() || gift.from_id?.toString();
        const giftId = gift.id || gift.gift_id || Date.now() + Math.random();
        
        // Проверяем, не записан ли уже этот подарок
        const exists = userData.gifts.some(g => g.giftId === giftId);
        if (!exists && fromId && fromId !== String(userId)) {
          userData.gifts.push({
            from: fromId,
            giftId: giftId,
            date: new Date().toISOString(),
            type: isNFT ? 'nft' : 'regular',
            giftData: gift
          });
          
          // Проверяем на взаимную связь
          const fromUser = db.users[fromId];
          if (fromUser && fromUser.gifts) {
            const mutual = fromUser.gifts.some(g => g.from === String(userId));
            if (mutual) {
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
      console.log(`✅ Найдено ${userData.gifts.length} подарков для ${userId}`);
    }
  } catch (e) {
    console.error(`Ошибка проверки подарков для ${userId}:`, e.message);
  }
}

// ===== АКТИВНЫЙ ПАРКИНГ (БЫСТРЫЙ СБОР ВСЕХ УЧАСТНИКОВ) =====
async function activeParking() {
  if (!mtClient || !isReady) return;
  
  console.log("🚗 Начинаю активный паркинг участников...");
  
  for (const chatLink of db.monitoredChats) {
    try {
      const entity = await mtClient.getEntity(chatLink);
      
      // Получаем участников с максимальной скоростью
      const participants = await mtClient.getParticipants(entity, { 
        limit: 2000,
        aggressive: true
      });
      
      console.log(`📊 Собираю ${participants.length} участников из ${chatLink}`);
      
      // Параллельная обработка
      const batchSize = 50;
      for (let i = 0; i < participants.length; i += batchSize) {
        const batch = participants.slice(i, i + batchSize);
        await Promise.all(batch.map(async (p) => {
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
            
            // Проверяем подарки у каждого (но не чаще раза в день)
            const userData = db.users[userId];
            if (userData && (!userData._lastGiftCheck || 
                (Date.now() - new Date(userData._lastGiftCheck).getTime()) > 86400000)) {
              await checkGiftsCorrect(userId);
              userData._lastGiftCheck = new Date().toISOString();
              saveDb();
            }
          } catch (e) {
            // Игнорируем
          }
        }));
        
        // Небольшая пауза между батчами чтобы не флудить
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      
      console.log(`✅ Паркинг завершен: ${participants.length} участников из ${chatLink}`);
      
    } catch (e) {
      console.error(`Ошибка паркинга ${chatLink}:`, e.message);
    }
  }
  
  console.log("✅ Активный паркинг завершен!");
}

// ===== ФУНКЦИЯ АНТИ-СОН (каждые 30 секунд) =====
async function antiSleep() {
  try {
    const now = Date.now();
    const elapsed = (now - db.lastActivity) / 1000;
    
    console.log(`💤 Anti-sleep: активен, бездействие ${Math.round(elapsed)}с`);
    
    // Обновляем время активности
    db.lastActivity = now;
    saveDb();
    
    // Выполняем маленькую активность каждые 30 секунд
    // 1. Обновляем инфу об админе
    if (isReady && mtClient) {
      try {
        const adminEntity = await mtClient.getEntity(ADMIN_ID);
        if (adminEntity) {
          updateUserInfo(
            ADMIN_ID.toString(),
            adminEntity.username,
            adminEntity.firstName,
            adminEntity.lastName,
            adminEntity.about || null,
            adminEntity.phone || null
          );
        }
      } catch (e) {
        // Игнорируем
      }
    }
    
    // 2. Проверяем статус бота
    try {
      const me = await bot.getMe();
      console.log(`🤖 Бот активен: @${me.username}`);
    } catch (e) {
      console.error("Ошибка проверки бота:", e.message);
    }
    
  } catch (e) {
    console.error("Ошибка anti-sleep:", e.message);
  }
}

// ===== СТАРТ АНТИ-СНА =====
function startAntiSleep() {
  setInterval(antiSleep, 30000); // Каждые 30 секунд
  console.log("💤 Anti-sleep запущен (каждые 30 секунд)");
}

// ===== СТАРТ АКТИВНОГО ПАРКИНГА =====
function startActiveParking() {
  // Первый запуск через 10 секунд
  setTimeout(async () => {
    await activeParking();
  }, 10000);
  
  // Затем каждые 5 минут
  setInterval(async () => {
    await activeParking();
  }, 300000); // 5 минут
  
  console.log("🚗 Активный паркинг запущен (каждые 5 минут)");
}

// ===== /START =====
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId === ADMIN_ID) {
    bot.sendMessage(chatId, 
      `👨‍💻 **Ryzen Monitor v3.0**\n\n` +
      `⚡️ **Супер-активный мониторинг**\n` +
      `• Активный паркинг каждые 5 минут\n` +
      `• Анти-сон каждые 30 секунд\n` +
      `• Проверка подарков 24/7\n\n` +
      `📊 Команды:\n` +
      `• Отправьте ссылку на группу → активный мониторинг\n` +
      `• /db — выгрузить БД\n` +
      `• /stats — статистика\n` +
      `• /parking — ручной паркинг\n` +
      `• /gifts [@username] — проверить подарки\n\n` +
      `🔍 Для поиска отправьте @username`
    , { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, 
      `🤖 **Ryzen Search Bot v3.0**\n\n` +
      `🔍 Отправьте @username для поиска\n` +
      `📊 Показывает: ID, историю, подарки и связи\n` +
      `⚡️ Активный мониторинг 24/7`
    , { parse_mode: 'Markdown' });
  }
});

// ===== /PARKING (ручной паркинг) =====
bot.onText(/\/parking/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  if (userId !== ADMIN_ID) return;

  bot.sendMessage(chatId, "🚗 Запускаю ручной паркинг...");
  await activeParking();
  bot.sendMessage(chatId, "✅ Паркинг завершен!");
});

// ===== /GIFTS [@username] =====
bot.onText(/\/gifts(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const targetUsername = match[1]?.trim();

  if (userId !== ADMIN_ID) return;

  if (!targetUsername) {
    return bot.sendMessage(chatId, "❌ Использование: /gifts @username");
  }

  const searchUsername = targetUsername.startsWith('@') ? targetUsername : '@' + targetUsername;
  
  // Ищем пользователя
  let foundUser = null;
  for (const key of Object.keys(db.users)) {
    const u = db.users[key];
    if (u.usernames.some(item => item.value.toLowerCase() === searchUsername.toLowerCase())) {
      foundUser = u;
      break;
    }
  }

  if (!foundUser) {
    return bot.sendMessage(chatId, `❌ Пользователь ${searchUsername} не найден в БД.`);
  }

  bot.sendMessage(chatId, `🔍 Проверяю подарки для ${searchUsername}...`);
  await checkGiftsCorrect(foundUser.id);
  
  const userData = db.users[foundUser.id];
  if (userData.gifts && userData.gifts.length > 0) {
    let report = `🎁 **Подарки для ${searchUsername}:**\n\n`;
    userData.gifts.forEach((g, i) => {
      const fromUser = db.users[g.from];
      const fromName = fromUser?.usernames?.[0]?.value || g.from;
      report += `${i+1}. ${g.type === 'nft' ? '💎 NFT' : '🎁 Обычный'} от ${fromName}\n`;
      report += `   📅 ${new Date(g.date).toLocaleString()}\n`;
    });
    bot.sendMessage(chatId, report, { parse_mode: 'Markdown' });
  } else {
    bot.sendMessage(chatId, `❌ Нет подарков для ${searchUsername}`);
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
  let totalGiftCount = 0;
  for (const key of Object.keys(db.users)) {
    if (db.users[key].gifts && db.users[key].gifts.length > 0) {
      usersWithGifts++;
      totalGiftCount += db.users[key].gifts.length;
    }
  }

  bot.sendMessage(chatId,
    `📊 **Статистика Ryzen Monitor v3.0**\n\n` +
    `👤 Всего пользователей: ${totalUsers}\n` +
    `🎁 Пользователей с подарками: ${usersWithGifts}\n` +
    `🎁 Всего подарков: ${totalGiftCount}\n` +
    `🔄 Взаимных связей: ${totalGifts}\n` +
    `💬 Чатов в мониторинге: ${totalChats}\n` +
    `⏱ Аптайм: ${Math.round(process.uptime() / 60)} минут\n` +
    `💤 Анти-сон: активен (30с)\n` +
    `🚗 Паркинг: активен (5м)\n\n` +
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
      caption: `📊 База данных Ryzen v3.0\nПользователей: ${Object.keys(db.users).length}\nСвязей: ${db.giftConnections.length}`
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

  // === ДОБАВЛЕНИЕ ГРУППЫ ===
  if (userId === ADMIN_ID && (text.includes('t.me/') || text.includes('telegram.me/'))) {
    if (db.monitoredChats.length >= 100) {
      return bot.sendMessage(chatId, "⚠️ Лимит 100 групп.");
    }

    if (db.monitoredChats.includes(text)) {
      return bot.sendMessage(chatId, "ℹ️ Уже в мониторинге.");
    }

    db.monitoredChats.push(text);
    saveDb();

    bot.sendMessage(chatId, `✅ Чат добавлен. Начинаю активный паркинг...`);
    await activeParking();
    bot.sendMessage(chatId, `✅ Паркинг завершен! Все участники в БД.`);
    return;
  }

  // === ПОИСК ПО @USERNAME ===
  if (text.startsWith('@') || !text.includes(' ')) {
    const searchUsername = text.startsWith('@') ? text : '@' + text;
    
    // Ищем в БД
    let foundUser = null;
    for (const key of Object.keys(db.users)) {
      const u = db.users[key];
      if (u.usernames.some(item => item.value.toLowerCase() === searchUsername.toLowerCase())) {
        foundUser = u;
        break;
      }
    }

    // Если нет — пытаемся найти через Userbot
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
          
          // Проверяем подарки
          await checkGiftsCorrect(userIdStr);
          
          foundUser = db.users[userIdStr];
        }
      } catch (e) {
        console.error(`Ошибка поиска ${searchUsername}:`, e.message);
      }
    }

    if (!foundUser) {
      return bot.sendMessage(chatId, `❌ Пользователь ${searchUsername} не найден.`);
    }

    // ===== ФОРМИРУЕМ ОТЧЁТ =====
    let report = `👤 **${searchUsername}**\n`;
    report += `🆔 ID: \`${foundUser.id}\`\n`;
    report += `📅 Впервые: ${new Date(foundUser.firstSeen).toLocaleString()}\n`;
    report += `🕒 Последний раз: ${new Date(foundUser.lastSeen).toLocaleString()}\n\n`;

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

    // ===== ПОДАРКИ =====
    if (foundUser.gifts && foundUser.gifts.length > 0) {
      report += `\n🎁 **Подарки (${foundUser.gifts.length}):**\n`;
      
      const sortedGifts = [...foundUser.gifts].sort((a, b) => 
        new Date(b.date) - new Date(a.date)
      ).slice(0, 10);
      
      for (const gift of sortedGifts) {
        const fromUser = db.users[gift.from];
        const fromName = fromUser?.usernames?.[0]?.value || gift.from;
        
        const isMutual = db.giftConnections.some(g => 
          (g.from === gift.from && g.to === foundUser.id)
        );
        
        report += `• ${gift.type === 'nft' ? '💎 NFT' : '🎁 Обычный'} от ${fromName}`;
        if (isMutual) {
          report += ` 🔄 **ВЗАИМНАЯ!**`;
        }
        report += ` (${new Date(gift.date).toLocaleString()})\n`;
      }
      
      if (foundUser.gifts.length > 10) {
        report += `• ... и ещё ${foundUser.gifts.length - 10} подарков\n`;
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
    report += `• Всего подарков: ${fou
