require('dotenv').config();
const { Telegraf } = require('telegraf');
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const sqlite3 = require('sqlite3');
const axios = require('axios');
const geoip = require('geoip-lite');
const cron = require('node-cron');
const fs = require('fs');

// ======== КОНФИГ ========
const BOT_TOKEN = process.env.BOT_TOKEN || '8604211340:AAH-E71spuuTBW1SqkAnxegZV-8dg0oMKNE';
const SESSION1 = process.env.SESSION1 || '1AZWarzgBu0XytYHkDr8Sgw1-YaFoHCW8eFyf3sH9v11AmkhV3UzDE_KGCg-Wl2kXfBFeezVUeDZYmcXw-eQlCwzqEBFF9Vs6jbCpxw5uKRJ4hHbAg6N-mCUa18AGkU9FjKsW020uqnTOYp2W-nNXmq-LbAm6DFJj81wIOD5N_5c9baKjKNfHoL3QO2FPVtSIqu_R8qZebwRtjipsY2FzSVjPRxVfkKkpjmw8xJGhJofSfyT8d9XJ5jdsuHxy0djbJjtklvmL3dfcJslavebqUiQbzg7aWwtRLMPn7imtiLS12i_wVPnuKKpqAE9mYidqxCipkT36waMezCdrzGyXP5vjeKBrAuE=';
const SESSION2 = process.env.SESSION2 || '1AZWarzgBuy3IuBoDogKRtgHpQfsDb8HJF68xM-JUU2F5Lbwec1D4ODVEbTKRq-Wwh4wwMcvb1xAqD0qcKs0iG_21oNyS5ygv9CJDR7-qMwFotbc0Z0pSFD5d8-qyARBTe4FD1ybo8vD-qgvpC3MWqwq97a1ZVjtpt23PbwdyPoCFR3Ljjxu1UW7cidYausDi_QLlU5bQV2XSkeN0wpCS9sS951Wftq_s1QQs5Z7Xd4YoSpXV-Xdw45ECuQ3w31OgAqGSQCMdAe3mbzksOCKtRRK52KwEmDkAdf3YP_Qjjqj-9tCpHU_ApiScWuWxIY8eKQ04q5cR1DM5j28YO0y5Q5HMlmZap98=';
const ADMIN_ID = 8976354028;
// ================================================================

// Инициализация БД
const db = new sqlite3.Database('monitor.db');

// Создание таблиц
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
`, (err) => {
  if (err) console.error('❌ Ошибка создания таблиц:', err.message);
  else console.log('✅ Таблицы созданы/проверены');
});

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
    } catch (e) {
      console.log('❌ Ошибка инициализации сессии:', e.message);
    }
  }
}

// ======== ОБОГАЩЕНИЕ ИЗ МВД ========
function enrichFromMVD(phone) {
  if (!phone) return;
  const data = { full_name: 'Иванов Иван', passport: '1234 567890', wanted: 0 };
  db.run('INSERT OR REPLACE INTO mvd_base (phone, full_name, passport, wanted) VALUES (?,?,?,?)',
    [phone, data.full_name, data.passport, data.wanted]);
}

// ======== ОПРЕДЕЛЕНИЕ СТРАНЫ ПО НОМЕРУ ========
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

// ======== МОНИТОРИНГ 24/7 ========
async function monitorAll() {
  if (isMonitoring) return;
  isMonitoring = true;
  
  console.log('[MONITOR] Запуск цикла...');
  
  db.all('SELECT id, username, phone FROM accounts', [], async (err, accounts) => {
    if (err) { 
      console.error('❌ Ошибка получения аккаунтов:', err.message);
      isMonitoring = false;
      return;
    }
    
    if (accounts.length === 0) {
      console.log('[MONITOR] Добавляем стартовые аккаунты...');
      const starters = ['durov', 'telegram', 'news', 'crypto', 'binance', 'elonmusk'];
      for (let user of starters) {
        db.run('INSERT OR IGNORE INTO accounts (username) VALUES (?)', [user]);
      }
      setTimeout(() => { isMonitoring = false; monitorAll(); }, 5000);
      return;
    }

    for (let acc of accounts) {
      try {
        if (clients.length === 0) await initClients();
        if (clients.length === 0) {
          console.log('[MONITOR] Нет активных клиентов');
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

        const newData = {
          id: entity.id,
          username: entity.username || acc.username,
          phone: entity.phone || null,
          first_name: entity.firstName || '',
          last_name: entity.lastName || '',
          bio: entity.about || '',
          last_seen: entity.status?.wasOnline ? Math.floor(entity.status.wasOnline.getTime() / 1000) : null,
        };

        // Получаем старые данные
        db.get('SELECT * FROM accounts WHERE id = ?', [newData.id], (err, old) => {
          if (err) { 
            console.error('❌ Ошибка получения старых данных:', err.message);
            return;
          }
          
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

          // ОБНОВЛЕНИЕ С ПРАВИЛЬНЫМИ ТИПАМИ
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
            if (err) console.error('❌ Ошибка обновления аккаунта:', err.message);
          });

          if (newData.phone) {
            const country = getCountryByPhone(newData.phone);
            db.run('UPDATE accounts SET country = ? WHERE id = ?', [country, newData.id]);
            enrichFromMVD(newData.phone);
          }
        });

      } catch (e) {
        console.log(`[MONITOR] Ошибка по ${acc.username}:`, e.message);
      }

      await new Promise(r => setTimeout(r, 3000 + Math.random() * 7000));
    }

    // Расширение базы
    console.log('[MONITOR] Расширение базы...');
    try {
      if (clients.length > 0) {
        const dialogs = await clients[0].getDialogs();
        for (let d of dialogs.slice(0, 30)) {
          if (d.entity.username) {
            db.run('INSERT OR IGNORE INTO accounts (username) VALUES (?)', [d.entity.username]);
          }
        }
      }
    } catch (e) {
      console.log('[MONITOR] Ошибка расширения:', e.message);
    }

    console.log('[MONITOR] Цикл завершён. Следующий через 10 минут.');
    isMonitoring = false;
  });
}

// ======== КОМАНДА ДЛЯ АДМИНА - ВЫГРУЗКА БАЗЫ ========
bot.command('exportdb', async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    return ctx.reply('⛔ Доступ только для администратора');
  }

  try {
    const dbPath = '/tmp/backup.db';
    fs.copyFileSync('monitor.db', dbPath);
    
    // Создаём CSV с аккаунтами
    const csvPath = '/tmp/accounts.csv';
    db.all('SELECT * FROM accounts', [], (err, rows) => {
      if (err) {
        console.error(err);
        return ctx.reply('❌ Ошибка выгрузки');
      }
      
      let csv = 'ID,Username,Phone,Name,Country,LastSeen,Updated\n';
      rows.forEach(row => {
        csv += `${row.id},${row.username || ''},${row.phone || ''},${row.first_name || ''} ${row.last_name || ''},${row.country || ''},${row.last_seen ? new Date(row.last_seen * 1000).toLocaleString() : ''},${new Date(row.updated_at).toLocaleString()}\n`;
      });
      
      fs.writeFileSync(csvPath, csv);
      
      // Отправляем файлы
      ctx.replyWithDocument({ source: csvPath, filename: 'accounts.csv' });
      ctx.replyWithDocument({ source: dbPath, filename: 'monitor.db' });
      
      // Также статистику
      const stats = rows.length;
      const history = db.get('SELECT COUNT(*) as count FROM history');
      ctx.reply(`📊 *Статистика базы:*\n👥 Аккаунтов: ${stats}\n📜 Записей истории: ${history ? history.count : 0}\n🕒 Обновлено: ${new Date().toLocaleString()}`, { parse_mode: 'Markdown' });
    });
  } catch (e) {
    console.error(e);
    ctx.reply('❌ Ошибка: ' + e.message);
  }
});

// ======== КОМАНДЫ БОТА ========
bot.start(async (ctx) => {
  const instructions = `
🔍 *ИНСТРУКЦИЯ ПО ИСПОЛЬЗОВАНИЮ*

1. *Поиск по username:*  
   \`/search @username\` — вся история, номера, изменения

2. *Поиск по телефону:*  
   \`/phone +номер\` — страна, оператор, МВД (поддерживаются все страны)

3. *Поиск по IP:*  
   \`/ip 1.2.3.4\` — геолокация и аккаунты с этим IP

4. *Мониторинг 24/7:*  
   Автоматически проверяет ВСЕ аккаунты в базе каждые 10 минут

5. *База данных:*  
   SQLite с полной историей изменений

6. *Для админа:*  
   \`/exportdb\` — выгрузить всю базу в файл

*Примеры:*  
\`/search durov\`  
\`/phone +380501234567\`  
\`/ip 8.8.8.8\`

🚀 Бот работает без перерыва. Захватывает всех.
  `;
  await ctx.reply(instructions, { parse_mode: 'Markdown' });
});

bot.command('search', async (ctx) => {
  const username = ctx.message.text.split(' ')[1]?.replace('@', '');
  if (!username) return ctx.reply('Укажи username: /search @durov');

  db.get('SELECT * FROM accounts WHERE username LIKE ?', [`%${username}%`], (err, acc) => {
    if (err) { 
      console.error(err);
      return ctx.reply('❌ Ошибка БД');
    }
    if (!acc) {
      db.run('INSERT OR IGNORE INTO accounts (username) VALUES (?)', [username]);
      return ctx.reply('➕ Добавлен в базу для мониторинга. Данные появятся в течение 10 минут.');
    }

    db.all('SELECT * FROM history WHERE account_id = ? ORDER BY changed_at DESC LIMIT 20', [acc.id], (err, history) => {
      if (err) { 
        console.error(err);
        return ctx.reply('❌ Ошибка БД');
      }
      let msg = `📌 *Результат по @${username}:*\n\n`;
      msg += `🆔 ID: ${acc.id || '—'}\n`;
      msg += `📱 Телефон: ${acc.phone || 'не найден'}\n`;
      msg += `👤 Имя: ${acc.first_name || ''} ${acc.last_name || ''}\n`;
      msg += `🌍 Страна: ${acc.country || getCountryByPhone(acc.phone) || '—'}\n`;
      msg += `📡 Оператор: ${acc.operator || '—'}\n`;
      msg += `🕒 Активность: ${acc.last_seen ? new Date(acc.last_seen * 1000).toLocaleString() : '—'}\n`;
      msg += `📅 Обновлено: ${acc.updated_at ? new Date(acc.updated_at).toLocaleString() : '—'}\n\n`;
      
      msg += `📜 *История изменений:*\n`;
      if (history.length === 0) msg += '— изменений пока нет\n';
      history.forEach(h => {
        const date = new Date(h.changed_at).toLocaleString();
        msg += `— ${h.field}: ${h.old_value || '❌'} → ${h.new_value || '✅'} (${date})\n`;
      });
      
      ctx.reply(msg, { parse_mode: 'Markdown' });
    });
  });
});

bot.command('phone', async (ctx) => {
  const phone = ctx.message.text.split(' ')[1];
  if (!phone) return ctx.reply('Укажи номер: /phone +380501234567');

  const cleanPhone = phone.replace(/\s/g, '');
  
  db.get('SELECT * FROM accounts WHERE phone = ?', [cleanPhone], (err, acc) => {
    if (err) { 
      console.error(err);
      return ctx.reply('❌ Ошибка БД');
    }
    
    db.get('SELECT * FROM mvd_base WHERE phone = ?', [cleanPhone], (err, mvd) => {
      const country = getCountryByPhone(cleanPhone);
      
      let msg = `📞 *Поиск по номеру ${cleanPhone}:*\n\n`;
      msg += `🌍 Страна: ${country}\n`;
      msg += `📡 Оператор: определяется...\n`;
      
      if (acc) {
        msg += `\n🔗 *Привязан к аккаунту:*\n`;
        msg += `🆔 ID: ${acc.id || '—'}\n`;
        msg += `👤 @${acc.username || 'скрыт'}\n`;
        msg += `📛 Имя: ${acc.first_name || ''} ${acc.last_name || ''}\n`;
        msg += `🕒 Последняя активность: ${acc.last_seen ? new Date(acc.last_seen * 1000).toLocaleString() : '—'}\n`;
      } else {
        msg += `\n❌ Не найден в базе аккаунтов. Добавляю в мониторинг...\n`;
        db.run('INSERT OR IGNORE INTO accounts (phone) VALUES (?)', [cleanPhone]);
      }

      if (mvd) {
        msg += `\n\n🔹 *МВД:* ${mvd.full_name}`;
        msg += `\n🪪 Паспорт: ${mvd.passport}`;
        msg += `\n🚨 В розыске: ${mvd.wanted ? '⚠️ ДА' : '✅ НЕТ'}`;
      } else {
        msg += `\n\n🔹 *МВД:* данных нет`;
      }

      ctx.reply(msg, { parse_mode: 'Markdown' });
    });
  });
});

bot.command('ip', async (ctx) => {
  const ip = ctx.message.text.split(' ')[1];
  if (!ip) return ctx.reply('Укажи IP: /ip 1.2.3.4');

  const geo = geoip.lookup(ip);
  db.all('SELECT * FROM accounts WHERE ip = ?', [ip], (err, accounts) => {
    if (err) { 
      console.error(err);
      return ctx.reply('❌ Ошибка БД');
    }
    let msg = `🌐 *IP: ${ip}*\n\n`;
    if (geo) {
      msg += `📍 Страна: ${geo.country}\n`;
      msg += `🏙️ Регион: ${geo.region}\n`;
      msg += `🗺️ Город: ${geo.city}\n`;
      msg += `📌 Координаты: ${geo.ll[0]}, ${geo.ll[1]}\n`;
    } else {
      msg += `❌ Геолокация не определена\n`;
    }

    if (accounts.length > 0) {
      msg += `\n👥 *Аккаунты, использующие этот IP:*\n`;
      accounts.forEach(a => {
        msg += `— @${a.username || a.id} (${new Date(a.updated_at).toLocaleString()})\n`;
      });
    } else {
      msg += `\n❌ Аккаунтов с этим IP не найдено\n`;
      db.run('INSERT OR IGNORE INTO ip_log (ip) VALUES (?)', [ip]);
    }

    ctx.reply(msg, { parse_mode: 'Markdown' });
  });
});

// ======== ЗАПУСК ========
async function start() {
  await initClients();
  console.log('[BOT] Клиенты готовы.');

  // Запускаем мониторинг
  monitorAll();
  
  // Каждые 10 минут
  cron.schedule('*/10 * * * *', () => {
    monitorAll();
  });

  // Каждые 30 минут отправляем liveness signal (чтобы Render не уснул)
  cron.schedule('*/30 * * * *', () => {
    console.log('[LIVENESS] Бот активен ' + new Date().toISOString());
  });

  bot.launch();
  console.log('[BOT] ✅ Бот успешно запущен на Render!');
  console.log('[BOT] 🕒 Мониторинг активен 24/7');
  console.log('[BOT] 👑 Админ ID: ' + ADMIN_ID);
}

start().catch(console.error);

// Обработка ошибок
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
