import 'dotenv/config';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function tgRequest(method, params = {}) {
  const res = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    }
  );
  return res.json();
}

async function sendMessage(chatId, text) {
  return tgRequest('sendMessage', { chat_id: chatId, text });
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg || !msg.text) return;
  const chatId = msg.chat.id;
  // TODO: replace with real Claude API call
  await sendMessage(chatId, 'Привет, я агент Прилавки');
}

async function startPolling() {
  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN не задан');
    process.exit(1);
  }
  let offset = 0;
  console.log('Агент запущен (long polling)');
  for (;;) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates` +
          `?timeout=25&offset=${offset}&allowed_updates=["message"]`
      );
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          handleUpdate(update).catch((e) => console.error('handleUpdate error:', e));
          offset = update.update_id + 1;
        }
      }
    } catch (e) {
      console.error('Polling error:', e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

startPolling();
