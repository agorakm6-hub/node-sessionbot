const TelegramBot = require('node-telegram-bot-api');
const { MTProto } = require('@mtproto/core');
const { GoogleGenAI } = require('@google/genai');
const http = require('http');

// Environment variables check
const BOT_TOKEN = process.env.BOT_TOKEN;
const SESSION_STRING = process.env.SESSION_STRING;
const TG_API_ID = parseInt(process.env.TG_API_ID, 10);
const TG_API_HASH = process.env.TG_API_HASH;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const PORT = process.env.PORT || 3000;
const RENDER_EXTERNAL_URL = process.env.RENDER_EXTERNAL_URL;

if (!BOT_TOKEN || !SESSION_STRING || !TG_API_ID || !TG_API_HASH || !GEMINI_API_KEY) {
  console.error('Missing required environment variables. Check BOT_TOKEN, SESSION_STRING, TG_API_ID, TG_API_HASH, GEMINI_API_KEY.');
  process.exit(1);
}

// Initialize Telegram Bot via Webhook
const bot = new TelegramBot(BOT_TOKEN, { polling: false });

if (RENDER_EXTERNAL_URL) {
  const webhookUrl = `${RENDER_EXTERNAL_URL}/bot${BOT_TOKEN}`;
  bot.setWebHook(webhookUrl).then(() => {
    console.log(`Webhook successfully set to: ${webhookUrl}`);
  }).catch((err) => {
    console.error('Failed to set webhook:', err);
  });
} else {
  console.warn('RENDER_EXTERNAL_URL is not set. Webhook might not work correctly if not running locally.');
}

// Simple HTTP server for Render health checks and webhook handling
const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === `/bot${BOT_TOKEN}`) {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      try {
        const update = JSON.parse(body);
        bot.processUpdate(update);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      } catch (e) {
        console.error('Error processing update:', e);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
      }
    });
  } else {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Telegram Channel Analysis Bot is running.');
  }
});

server.listen(PORT, () => {
  console.log(`HTTP server is listening on port ${PORT}`);
});

// Initialize MTProto client
const mtproto = new MTProto({
  api_id: TG_API_ID,
  api_hash: TG_API_HASH,
  storageOptions: {
    instance: {
      async get(key) {
        if (key === 'session') return SESSION_STRING;
        return null;
      },
      async set(key, value) {
        // Read-only session storage for string session
      },
      async remove(key) {}
    }
  }
});

async function callMTProto(method, params, options = {}) {
  try {
    return await mtproto.call(method, params, options);
  } catch (error) {
    console.error(`MTProto call error for ${method}:`, error);
    if (error.error_code && error.error_message) {
      throw new Error(`Telegram API Error (${error.error_code}): ${error.error_message}`);
    }
    throw error;
  }
}

// Initialize Gemini 1.5 Flash client via official SDK
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// Command /start
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const startText = `
👋 <b>Welcome to the Telegram Channel Compliance & Violation Analyzer Bot!</b>

This bot evaluates public Telegram channels for severe violations using AI (Gemini 1.5 Flash) and MTProto data fetching.

📌 <b>How to use:</b>
Send a link to a public Telegram channel (e.g., <code>https://t.me/durov</code> or <code>@durov</code>).

🔍 <b>What is analyzed:</b>
- PII / Doxxing (Leaked personal data, phones, passports, addresses)
- Illegal sales (Weapons, drugs, forged documents)
- Fraud, scams, and financial schemes
- Child exploitation / CSAM
- Terrorism, graphic violence, and extremism
- Hate speech and harassment
- Pirated content and copyright violations
- Phishing and malware distribution

You will receive a structured violation report, email subject, a dedicated clean complaint template in code blocks for easy copying, European legal references, and a downloadable .txt report.
  `.trim();

  bot.sendMessage(chatId, startText, { parse_mode: 'HTML' });
});

// Handle incoming messages (channel links)
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text ? msg.text.trim() : '';

  if (!text || text.startsWith('/')) return;

  // Extract channel username or link
  let channelUsername = '';
  if (text.startsWith('https://t.me/')) {
    channelUsername = text.replace('https://t.me/', '').split('/')[0].trim();
  } else if (text.startsWith('@')) {
    channelUsername = text.replace('@', '').trim();
  } else {
    if (!text.includes(' ') && !text.includes('/')) {
      channelUsername = text;
    } else {
      return; 
    }
  }

  if (!channelUsername) {
    return bot.sendMessage(chatId, '❌ Invalid channel link format. Please send a link like <code>https://t.me/channelname</code> or <code>@channelname</code>.', { parse_mode: 'HTML' });
  }

  const processingMsg = await bot.sendMessage(chatId, `🔍 Resolving channel <code>@${channelUsername}</code> and fetching the last 300 messages via MTProto...`, { parse_mode: 'HTML' });

  try {
    // 1. Resolve channel via MTProto
    const resolved = await callMTProto('contacts.resolveUsername', {
      username: channelUsername,
    });

    const chatData = resolved.chats && resolved.chats.length > 0 ? resolved.chats[0] : null;
    if (!chatData) {
      throw new Error('Channel not found or is inaccessible.');
    }

    const peer = {
      _: 'inputPeerChannel',
      channel_id: chatData.id,
      access_hash: chatData.access_hash,
    };

    // 2. Load last 300 messages
    let allMessages = [];
    let offsetId = 0;
    const limitPerReq = 100;
    const totalToFetch = 300;

    while (allMessages.length < totalToFetch) {
      const history = await callMTProto('messages.getHistory', {
        peer: peer,
        offset_id: offsetId,
        offset_date: 0,
        add_offset: 0,
        limit: limitPerReq,
        max_id: 0,
        min_id: 0,
        hash: 0,
      });

      const messages = history.messages || [];
      if (messages.length === 0) break;

      allMessages = allMessages.concat(messages);
      offsetId = messages[messages.length - 1].id;

      if (messages.length < limitPerReq) break;
    }

    if (allMessages.length === 0) {
      await bot.editMessageText('⚠️ The channel is empty or contains no accessible messages.', {
        chat_id: chatId,
        message_id: processingMsg.message_id
      });
      return;
    }

    await bot.editMessageText(`🤖 Analyzed ${allMessages.length} messages. Running compliance check through Gemini 1.5 Flash...`, {
      chat_id: chatId,
      message_id: processingMsg.message_id
    });

    // Format messages for prompt
    const formattedMessages = allMessages.map((m) => {
      const msgId = m.id;
      const date = m.date ? new Date(m.date * 1000).toISOString() : 'Unknown date';
      const msgText = m.message || '[Media / No text]';
      return `[ID: ${msgId} | Date: ${date}] ${msgText}`;
    }).join('\n\n');

    // 3. Construct prompt for Gemini 1.5 Flash
    const prompt = `
You are an expert legal and cybersecurity compliance auditor specializing in Telegram platform rules and European data protection laws (GDPR).
Analyze the following batch of ${allMessages.length} messages from the Telegram channel https://t.me/${channelUsername}.

Categories to audit strictly:
1. PII / Doxxing (Leaked personal data, full names, phone numbers, passport scans, home addresses)
2. Illegal sales (Weapons, narcotics, forged documents, illegal substances)
3. Fraud, scams, and financial pyramids
4. Child exploitation / CSAM
5. Terrorism, extreme violence, and physical harm promotion
6. Hate speech, discrimination, and targeted harassment
7. Copyright infringement and pirated content distribution
8. Phishing, malware, and credential stealing links

Return your response in valid JSON format ONLY with the following structure:
{
  "has_violations": boolean,
  "violations": [
    {
      "category": "string (one of the categories above)",
      "severity": number (1 to 5, where 5 is critical/extreme),
      "description": "Detailed explanation of why this violates rules",
      "message_id": number,
      "evidence_link": "https://t.me/${channelUsername}/<message_id>"
    }
  ],
  "email_subject": "A formal, concise email subject in English suitable for reporting this channel to Telegram Support",
  "specific_violation_summary": "A concise summary of the primary violation to be inserted into the complaint template (e.g. 'distribution of leaked personal data and doxxing')"
}

If no violations are found, set "has_violations" to false, "violations" to an empty array, and provide appropriate generic subject and summary. Do not include markdown code ticks around the JSON, return purely raw valid JSON.

Messages to analyze:
${formattedMessages}
    `.trim();

    // 4. Call Gemini 1.5 Flash
    const response = await ai.models.generateContent({
      model: 'gemini-1.5-flash',
      contents: prompt,
    });

    let responseText = response.text() || '';
    
    // Clean potential markdown blocks from response safely without multiline string syntax errors
    responseText = responseText.replace(/^