require('dotenv').config();
const { Telegraf } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const sqlite3 = require('sqlite3');
const axios = require('axios');
const geoip = require('geoip-lite');
const cron = require('node-cron');
const fs = require('fs');
const http = require('http');

// ======== КОНФИГ ========
const BOT_TOKEN = process.env.BOT_TOKEN || '8604211340:AAH-E71spuuTBW1SqkAnxegZV-8dg0oMKNE';
const SESSION1 = process.env.SESSION1 || '1AZWarzgBu0XytYHkDr8Sgw1-YaFoHCW8eFyf3sH9v11AmkhV3UzDE_KGCg-Wl2kXfBFeezVUeDZYmcXw-eQlCwzqEBFF9Vs6jbCpxw5uKRJ4hHbAg6N-mCUa18AGkU9FjKsW020uqnTOYp2W-nNXmq-LbAm6DFJj81wIOD5N_5c9baKjKNfHoL3QO2FPVtSIqu_R8qZebwRtjipsY2FzSVjPRxVfkKkpjmw8xJGhJofSfyT8d9XJ5jdsuHxy0djbJjtklvmL3dfcJslavebqUiQbzg7aWwtRLMPn7imtiLS12i_wVPnuKKpqAE9mYidqxCipkT36waMezCdrzGyXP5vjeKBrAuE=';
const SESSION2 = process.env.SESSION2 || '1AZWarzgBuy3IuBoDogKRtgHpQfsDb8HJF68xM-JUU2F5Lbwec1D4ODVEbTKRq-Wwh4wwMcvb1xAqD0qcKs0iG_21oNyS5ygv9CJDR7-qMwFotbc0Z0pSFD5d8-qyARBTe4FD1ybo8vD-qgvpC3MWqwq97a1ZVjtpt23PbwdyPoCFR3Ljjxu1UW7cidYausDi_QLlU5bQV2XSkeN0wpCS9sS951Wftq_s1QQs5Z7Xd4YoSpXV-Xdw45ECuQ3w31OgAqGSQCMdAe3mbzksOCKtRRK52KwEmDkAdf3YP_Qjjqj-9tCpHU_ApiScWuWxIY8eKQ04q5cR1DM5j28YO0y5Q5HMlmZap98=';
const ADMIN_ID = 8976354028;
const PORT = process.env.PORT || 10000;

// ======== ПОДНИМАЕМ ПОРТ ========
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('✅ Bot is running on port ' + PORT);
});
server.listen(PORT, () => console.log(`✅ HTTP сервер на порту ${PORT}`));

// ======== УДАЛЯЕМ СТАРУЮ БД ========
try {
  if (fs.existsSync('monitor.db')) fs.unlinkSync('monitor.db');
  if (fs.existsSync('monitor.db-journal')) fs.unlinkSync('monitor.db-journal');
} catch(e) {}

const db = new sqlite3.Database('monitor.db', sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE);

db.exec(`
  CREATE TABLE IF NOT EXISTS accounts (
    id INTEGER PRIMARY KEY,
    username TEXT,
    phone TEXT,
    first_name TEXT,
    last_name TEXT,
    bio TEXT,
    ip TEXT,
    last_seen INTEGER,
    registered_at INTEGER,
    country TEXT,
    city TEXT,
    operator TEXT,
    updated_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    changed_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS ip_log (
    ip TEXT PRIMARY KEY,
    country TEXT,
    city TEXT,
    isp TEXT,
    lat REAL,
    lon REAL
  );
  CREATE TABLE IF NOT EXISTS mvd_base (
    phone TEXT PRIMARY KEY,
    full_name TEXT,
    passport TEXT,
    region TEXT,
    wanted INTEGER
  );
`, (err) => err ? console.error('❌', err.message) : console.log('✅ БД готова'));

const bot = new Telegraf(BOT_TOKEN);
let clients = [];
let isMonitoring = false;

// ======== ИНИЦИАЛИЗАЦИЯ КЛИЕНТОВ ========
async function initClients() {
  const sessions = [SESSION1, SESSION2];
  for (let s of sessions) {
    try {
      const client = new TelegramClient(new StringSession(s), 6, 'TELEGRAM', { connectionRetries: 5 });
      await client.connect();
      clients.push(client);
      console.log('✅ Клиент подключён');
    } catch (e) {
      console.log('❌ Ошибка сессии:', e.message);
    }
  }
  return clients[0];
}

// ======== ОБОГАЩЕНИЕ ========
function enrichFromMVD(phone) {
  if (!phone) return;
  const data = { full_name: 'Иванов Иван', passport: '1234 567890', wanted: 0 };
  db.run('INSERT OR REPLACE INTO mvd_base (phone, full_name, passport, wanted) VALUES (?,?,?,?)',
    [phone, data.full_name, data.passport, data.wanted]);
}

function getCountryByPhone(phone) {
  if (!phone) return 'Неизвестно';
  if (phone.startsWith('+7')) return 'Россия';
  if (phone.startsWith('+380')) return 'Украина';
  if (phone.startsWith('+375')) return 'Беларусь';
  if (phone.startsWith('+1')) return 'США';
  if (phone.startsWith('+44')) return 'Великобритания';
  if (phone.startsWith('+49')) return 'Германия';
  if (phone.startsWith('+86')) return 'Китай';
  if (phone.startsWith('+91')) return 'Индия';
  if (phone.startsWith('+81')) return 'Япония';
  if (phone.startsWith('+55')) return 'Бразилия';
  return 'Неизвестно';
}

// ======== МОНИТОРИНГ (С ПРОВЕРКОЙ НА ТИП) ========
async function monitorAll() {
  if (isMonitoring) return;
  isMonitoring = true;
  
  console.log('[MONITOR] Запуск цикла...');
  
  db.all('SELECT id, username, phone FROM accounts', [], async (err, accounts) => {
    if (err) { 
      console.error('❌ Ошибка:', err.message);
      isMonitoring = false;
      return;
    }
    
    if (!accounts || accounts.length === 0) {
      console.log('[MONITOR] Добавляем стартовые...');
      const starters = ['durov', 'realdurov', 'elonmusk', 'binance', 'crypto'];
      for (let user of starters) {
        try {
          const client = await initClients();
          const entity = await client.getEntity(user);
          if (entity.className === 'User') {
            db.run('INSERT OR IGNORE INTO accounts (id, username) VALUES (?, ?)', [entity.id, user]);
            console.log(`[MONITOR] Добавлен ${user} (ID: ${entity.id})`);
          }
        } catch(e) {}
      }
      setTimeout(() => { isMonitoring = false; monitorAll(); }, 5000);
      return;
    }

    // ======== ОБНОВЛЕНИЕ ========
    for (let acc of accounts) {
      try {
        if (clients.length === 0) await initClients();
        if (clients.length === 0) {
          console.log('[MONITOR] Нет клиентов');
          isMonitoring = false;
          break;
        }
        
        const client = clients[Math.floor(Math.random() * clients.length)];
        let entity;
        try {
          entity = await client.getEntity(acc.id || acc.username);
        } catch (e) {
          if (acc.username) {
            try {
              entity = await client.getEntity(acc.username);
            } catch (e2) {
              console.log(`[MONITOR] Не найден ${acc.username}`);
              continue;
            }
          } else continue;
        }

        // ✅ ПРОВЕРКА — ЕСЛИ НЕ USER — УДАЛЯЕМ
        if (entity.className !== 'User') {
          console.log(`[MONITOR] ${acc.username} — не пользователь, удаляю`);
          db.run('DELETE FROM accounts WHERE id = ? OR username = ?', [acc.id, acc.username]);
          continue;
        }

        const newData = {
          id: entity.id,
          username: entity.username || acc.username,
          phone: entity.phone || null,
          first_name: entity.firstName || '',
          last_name: entity.lastName || '',
          bio: entity.about || '',
          last_seen: entity.status?.wasOnline ? Math.floor(entity.status.wasOnline.getTime() / 1000) : null,
        };

        db.get('SELECT * FROM accounts WHERE id = ?', [newData.id], (err, old) => {
          if (err) return;
          
          if (old) {
            for (let field of ['phone', 'username', 'first_name', 'last_name', 'bio']) {
              const oldVal = old[field] || '';
              const newVal = newData[field] || '';
              if (oldVal !== newVal && (oldVal || newVal)) {
                db.run('INSERT INTO history (account_id, field, old_value, new_value, changed_at) VALUES (?,?,?,?,?)',
                  [newData.id, field, oldVal, newVal, Date.now()]);
              }
            }
          }

          db.run(`
            INSERT OR REPLACE INTO accounts 
            (id, username, phone, first_name, last_name, bio, last_seen, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            newData.id,
            newData.username || null,
            newData.phone || null,
            newData.first_name || null,
            newData.last_name || null,
            newData.bio || null,
            newData.last_seen || null,
            Date.now()
          ], (err) => {
            if (err) console.error('❌ Ошибка обновления:', err.message);
          });

          if (newData.phone) {
            const country = getCountryByPhone(newData.phone);
            db.run('UPDATE accounts SET country = ? WHERE id = ?', [country, newData.id]);
            enrichFromMVD(newData.phone);
          }
        });

      } catch (e) {
        console.log(`[MONITOR] Ошибка:`, e.message);
      }

      await new Promise(r => setTimeout(r, 3000 + Math.random() * 7000));
    }

    // ======== АГРЕССИВНОЕ РАСШИРЕНИЕ ========
    console.log('[MONITOR] Агрессивное расширение...');
    try {
      if (clients.length > 0) {
        const client = clients[0];
        const dialogs = await client.getDialogs();
        console.log(`[MONITOR] Найдено ${dialogs.length} диалогов`);
        
        let newUsers = 0;
        
        for (let dialog of dialogs.slice(0, 50)) {
          try {
            const entity = dialog.entity;
            
            if (entity.className === 'Channel' || entity.className === 'Chat') {
              try {
                const participants = await client.getParticipants(entity, { limit: 200 });
                console.log(`[MONITOR] Канал ${entity.title}: ${participants.length} участников`);
                
                for (let user of participants) {
                  if (user.className === 'User' && user.username) {
                    db.run('INSERT OR IGNORE INTO accounts (id, username) VALUES (?, ?)', 
                      [user.id, user.username]);
                    newUsers++;
                  }
                }
              } catch(e) {}
            }
            
            if (dialog.entity.className === 'User' && dialog.entity.username) {
              db.run('INSERT OR IGNORE INTO accounts (id, username) VALUES (?, ?)', 
                [dialog.entity.id, dialog.entity.username]);
              newUsers++;
            }
            
          } catch(e) {}
        }
        
        console.log(`[MONITOR] Добавлено ${newUsers} новых пользователей`);
      }
    } catch (e) {
      console.log('[MONITOR] Ошибка расширения:', e.message);
    }

    console.log('[MONITOR] Цикл завершён.');
    isMonitoring = false;
  });
}

// ======== КОМАНДЫ ========
bot.command('db', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) return ctx.reply('⛔ Только админ');
  try {
    await ctx.reply('📊 Формирую отчёт...');
    let count = 0;
    try {
      const r = db.prepare('SELECT COUNT(*) as count FROM accounts').get();
      count = r ? r.count : 0;
    } catch(e) {}
    
    let allAccounts = [];
    try {
      const r = db.prepare('SELECT * FROM accounts LIMIT 50').all();
      allAccounts = Array.isArray(r) ? r : [];
    } catch(e) {}
    
    let report = '📊 *ОТЧЁТ ПО БАЗЕ*\n\n';
    report += `👥 Аккаунтов: *${count}*\n\n`;
    
    if (count === 0) {
      report += '❌ База пуста. Мониторинг заполнит через 10 минут.';
    } else {
      report += `📌 *Последние ${Math.min(allAccounts.length, 20)}:*\n\n`;
      for (const acc of allAccounts.slice(0, 20)) {
        report += `🔹 @${acc.username || acc.id} | ${acc.phone || 'нет номера'}\n`;
      }
    }
    
    await ctx.reply(report, { parse_mode: 'Markdown' });
    if (count > 0) {
      await ctx.replyWithDocument({ source: 'monitor.db', filename: `monitor_${Date.now()}.db` });
    }
  } catch (e) {
    await ctx.reply('❌ Ошибка: ' + e.message);
  }
});

bot.start(async (ctx) => {
  await ctx.reply(`
🔍 *БОТ-ПРОБИВ 24/7*

/search @username — найти аккаунт
/phone +номер — поиск по номеру
/ip 1.2.3.4 — поиск по IP
/db — выгрузка БД (админ)

🚀 Мониторит ВСЕХ пользователей
📊 Автоматически расширяет базу
  `, { parse_mode: 'Markdown' });
});

bot.command('search', async (ctx) => {
  const username = ctx.message.text.split(' ')[1]?.replace('@', '');
  if (!username) return ctx.reply('/search @durov');

  db.get('SELECT * FROM accounts WHERE username LIKE ?', [`%${username}%`], (err, acc) => {
    if (err || !acc) {
      db.run('INSERT OR IGNORE INTO accounts (username) VALUES (?)', [username]);
      return ctx.reply(`➕ @${username} добавлен в мониторинг`);
    }
    
    let msg = `📌 *@${username}*\n\n`;
    msg += `🆔 ID: ${acc.id || '—'}\n`;
    msg += `📱 Телефон: ${acc.phone || 'не найден'}\n`;
    msg += `👤 Имя: ${acc.first_name || ''} ${acc.last_name || ''}\n`;
    msg += `🌍 Страна: ${acc.country || '—'}\n`;
    msg += `🕒 Активность: ${acc.last_seen ? new Date(acc.last_seen * 1000).toLocaleString() : '—'}`;
    ctx.reply(msg, { parse_mode: 'Markdown' });
  });
});

bot.command('phone', async (ctx) => {
  const phone = ctx.message.text.split(' ')[1];
  if (!phone) return ctx.reply('/phone +380501234567');

  const clean = phone.replace(/\s/g, '');
  db.get('SELECT * FROM accounts WHERE phone = ?', [clean], (err, acc) => {
    const country = getCountryByPhone(clean);
    let msg = `📞 *${clean}*\n\n🌍 Страна: ${country}\n`;
    if (acc) {
      msg += `\n🔗 Аккаунт: @${acc.username || acc.id}\n`;
      msg += `👤 Имя: ${acc.first_name || ''}`;
    } else {
      msg += `\n❌ Не найден. Добавляю в мониторинг...`;
      db.run('INSERT OR IGNORE INTO accounts (phone) VALUES (?)', [clean]);
    }
    ctx.reply(msg, { parse_mode: 'Markdown' });
  });
});

bot.command('ip', async (ctx) => {
  const ip = ctx.message.text.split(' ')[1];
  if (!ip) return ctx.reply('/ip 1.2.3.4');

  const geo = geoip.lookup(ip);
  let msg = `🌐 *IP: ${ip}*\n\n`;
  if (geo) {
    msg += `📍 ${geo.country}, ${geo.city || '—'}`;
  } else {
    msg += '❌ Гео не определена';
  }
  ctx.reply(msg, { parse_mode: 'Markdown' });
});

// ======== ЗАПУСК ========
async function start() {
  console.log('[BOT] Инициализация...');
  await initClients();
  console.log('[BOT] Клиенты готовы');

  monitorAll();
  cron.schedule('*/10 * * * *', () => { monitorAll(); });

  bot.launch();
  console.log(`[BOT] ✅ БОТ ЗАПУЩЕН НА ПОРТУ ${PORT}`);
  console.log('[BOT] 👑 АДМИН ID: ' + ADMIN_ID);
}

start().catch(console.error);
process.on('unhandledRejection', console.error);
process.on('uncaughtException', console.error);
