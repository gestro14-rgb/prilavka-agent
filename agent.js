import 'dotenv/config';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_API_URL = process.env.ADMIN_API_URL;
const ADMIN_JWT_TOKEN = process.env.ADMIN_JWT_TOKEN;
const ALLOWED_USER_ID = 686803005;

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

async function apiRequest(path, method = 'GET', body = null) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_JWT_TOKEN}`,
    },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${ADMIN_API_URL}${path}`, opts);
  return res.json();
}

const tools = [
  {
    name: 'get_stats',
    description:
      'Получить статистику магазина: общая выручка, количество заказов по статусам, ' +
      'число пользователей, топ-5 товаров, выручка по дням за неделю.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_schedule',
    description: 'Получить текущее расписание доставки по дням недели.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'update_schedule',
    description: 'Установить слот доставки для конкретного дня недели (создать или обновить).',
    input_schema: {
      type: 'object',
      properties: {
        day_of_week: {
          type: 'number',
          description: 'День недели: 0=Вс, 1=Пн, 2=Вт, 3=Ср, 4=Чт, 5=Пт, 6=Сб',
        },
        slot: {
          type: 'string',
          description: 'Временной слот, например "18:00–21:00"',
        },
        is_open: {
          type: 'boolean',
          description: 'Открыт ли день для доставки',
        },
      },
      required: ['day_of_week', 'slot', 'is_open'],
    },
  },
  {
    name: 'get_products',
    description: 'Получить список всех товаров магазина.',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_product',
    description: 'Создать новый товар в каталоге.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Название товара' },
        price: { type: 'number', description: 'Цена в рублях' },
        category_id: { type: 'number', description: 'ID категории' },
        description: { type: 'string', description: 'Описание (необязательно)' },
        unit: { type: 'string', description: 'Единица измерения: кг, шт, л и т.д.' },
        is_available: {
          type: 'boolean',
          description: 'Доступен для заказа (по умолчанию true)',
        },
      },
      required: ['name', 'price', 'category_id'],
    },
  },
  {
    name: 'get_orders',
    description: 'Получить список заказов (все статусы, последние по дате).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

async function executeTool(name, input) {
  switch (name) {
    case 'get_stats':
      return apiRequest('/api/admin/stats');
    case 'get_schedule':
      return apiRequest('/api/admin/delivery-schedule');
    case 'update_schedule':
      return apiRequest('/api/admin/delivery-schedule', 'POST', input);
    case 'get_products':
      return apiRequest('/api/admin/products');
    case 'create_product':
      return apiRequest('/api/admin/products', 'POST', input);
    case 'get_orders':
      return apiRequest('/api/admin/orders');
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

async function downloadPhotoAsBase64(fileId) {
  const info = await tgRequest('getFile', { file_id: fileId });
  if (!info.ok) return null;
  const url = `https://api.telegram.org/file/bot${BOT_TOKEN}/${info.result.file_path}`;
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  return Buffer.from(buf).toString('base64');
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg) return;
  if (msg.from?.id !== ALLOWED_USER_ID) return;

  const chatId = msg.chat.id;
  const contentParts = [];

  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    const base64 = await downloadPhotoAsBase64(largest.file_id);
    if (base64) {
      contentParts.push({
        type: 'image',
        source: { type: 'base64', media_type: 'image/jpeg', data: base64 },
      });
    }
  }

  const text = msg.text || msg.caption;
  if (text) contentParts.push({ type: 'text', text });

  if (contentParts.length === 0) return;

  const messages = [{ role: 'user', content: contentParts }];

  let response;
  for (;;) {
    response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 4096,
      thinking: { type: 'adaptive' },
      system:
        'Ты помощник администратора интернет-магазина «Прилавка» (доставка эко-продуктов, Москва). ' +
        'Отвечай кратко и по делу на русском языке. ' +
        'Используй инструменты для получения актуальных данных из системы. ' +
        'Числа форматируй читаемо: пробел как разделитель тысяч, руб. для рублей.',
      tools,
      messages,
    });

    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      try {
        result = await executeTool(block.name, block.input);
      } catch (e) {
        result = { error: String(e) };
      }
      toolResults.push({
        type: 'tool_result',
        tool_use_id: block.id,
        content: JSON.stringify(result),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResults });
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  const reply = textBlock?.text ?? '(нет ответа)';
  await sendMessage(chatId, reply);
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
