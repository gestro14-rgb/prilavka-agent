import 'dotenv/config';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_API_URL   = process.env.ADMIN_API_URL;
const ADMIN_JWT_TOKEN = process.env.ADMIN_JWT_TOKEN;
const ALLOWED_USER_ID = 686803005;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── API helpers ───────────────────────────────────────────────────────────────

async function tgRequest(method, params = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
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

// ── Slug / price helpers ──────────────────────────────────────────────────────

const RU_MAP = {
  а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'yo',ж:'zh',з:'z',и:'i',й:'y',
  к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',
  х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya',
};

function makeSlug(name) {
  return name.toLowerCase()
    .split('').map(c => RU_MAP[c] ?? (c === ' ' ? '-' : c)).join('')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// Rounds wholesale×3 to nearest number ending in 9 or 0.
// e.g. 126→129, 144→140, 147→149, 99→99, 150→150
function roundPrice(raw) {
  const floor10 = Math.floor(raw / 10) * 10;
  const ceil10  = Math.ceil(raw  / 10) * 10;
  const candidates = [floor10, floor10 - 1, ceil10, ceil10 - 1].filter(n => n > 0);
  return candidates.reduce((best, n) =>
    Math.abs(n - raw) < Math.abs(best - raw) ? n : best
  );
}

// ── Category / subcategory detection ─────────────────────────────────────────

// Check greens first — "лук зелёный", "руккола" etc. must not fall into vegetables
const CATEGORY_PATTERNS = [
  { cat: 'greens',     re: /петрушк|укроп|кинз|базилик|мят|тархун|розмарин|тимьян|салат|щавел|мангольд|микрозелень|спарж|черемш|кресс|порей|лук зелён|шнитт|руккол/i },
  { cat: 'fruits',     re: /яблок|груш|персик|нектарин|слив|абрикос|черешн|вишн|виноград|арбуз|дын|манго|киви|гранат|хурм|инжир|банан|апельсин|лимон|мандарин|клубник|авокадо/i },
  { cat: 'vegetables', re: /огурц|помидор|томат|перец|капуст|свёкл|морков|лук|чеснок|баклажан|кабачок|тыкв|брокколи|редис|редьк|кукуруз|горош|шпинат|фенхел|батат|имбир|пастернак|реп|картофел|сельдер/i },
];

function detectCategory(name) {
  for (const { cat, re } of CATEGORY_PATTERNS) {
    if (re.test(name)) return cat;
  }
  return 'vegetables';
}

// Mirrors migration-013 assignment logic (slug → ILIKE patterns)
const SUBCAT_PATTERNS = [
  { slug: 'tomatoes',        re: /томат|помидор|черри/i },
  { slug: 'cucumbers',       re: /огурц/i },
  { slug: 'root-vegetables', re: /морков|свёкл|редис|редьк|репа|пастернак|батат|картофел|имбир/i },
  { slug: 'brassicas',       re: /капуст|брокколи|цветная/i },
  { slug: 'peppers',         re: /перец|перч/i },
  { slug: 'onions-garlic',   re: /лук|чеснок|шалот/i },
  { slug: 'squash',          re: /кабачок|тыква|баклажан/i },
  { slug: 'pome-fruits',     re: /яблок|груш/i },
  { slug: 'stone-fruits',    re: /персик|нектарин|слив|абрикос/i },
  { slug: 'berries-grapes',  re: /черешн|вишн|клубник|виноград/i },
  { slug: 'melons',          re: /арбуз|дын/i },
  { slug: 'exotic',          re: /манго|киви|гранат|хурм|инжир|авокадо|папай|маракуй|ананас|банан/i },
  { slug: 'citrus',          re: /лимон|апельсин|мандарин/i },
  { slug: 'fresh-herbs',     re: /петрушк|укроп|кинза|лук зелён|черемш|шнитт/i },
  { slug: 'salads',          re: /салат|руккол|шпинат|мангольд|щавел|кресс/i },
  { slug: 'spice-herbs',     re: /базилик|мята|тархун|розмарин|тимьян/i },
];

function detectSubcategorySlug(name) {
  for (const { slug, re } of SUBCAT_PATTERNS) {
    if (re.test(name)) return slug;
  }
  return null;
}

// ── Price breakdown ───────────────────────────────────────────────────────────

function buildPricing(price) {
  return [
    `Закупка у фермеров: ${Math.round(price * 0.33)} ₽`,
    `Логистика и доставка: ${Math.round(price * 0.25)} ₽`,
    `Бережная упаковка: ${Math.round(price * 0.12)} ₽`,
    `Отбор и контроль качества: ${Math.round(price * 0.15)} ₽`,
    `Работа сервиса: ${Math.round(price * 0.15)} ₽`,
  ];
}

// ── Category visual defaults ──────────────────────────────────────────────────

const CATEGORY_EMOJI  = { vegetables: '🥦', fruits: '🍎', greens: '🌿' };
const CATEGORY_BG     = {
  vegetables: 'var(--color-accent-soft)',
  greens:     'var(--color-accent-soft)',
  fruits:     '#FFF0E0',
};
const BADGE_LABELS    = { hit: 'Хит', eco: 'Эко', new: 'Новинка', popular: 'Популярное' };

// ── Subcategory id cache (slug → id), loaded once at startup ─────────────────

let subcategoryCache = {};

async function loadSubcategoryCache() {
  try {
    const subs = await apiRequest('/api/admin/subcategories');
    if (Array.isArray(subs)) {
      subcategoryCache = Object.fromEntries(subs.map(s => [s.slug, s.id]));
      console.log(`Подкатегории загружены: ${subs.length}`);
    }
  } catch (e) {
    console.error('Не удалось загрузить подкатегории:', e.message);
  }
}

// ── Product body builder ──────────────────────────────────────────────────────

function buildProductBody({ name, price, category, weight, description, ingredients, badge_type, sort_order, index = 0 }) {
  const cat        = category || detectCategory(name);
  const subcatSlug = detectSubcategorySlug(name);
  const slug       = makeSlug(name);

  return {
    id:           `${slug}-${Date.now() + index}`,
    title:        name,
    price,
    category:     cat,
    weight:       weight || '',
    emoji:        CATEGORY_EMOJI[cat] || '🛒',
    bg:           CATEGORY_BG[cat]    || 'linear-gradient(135deg, #F4F7F2, #fff)',
    badge:        badge_type ? { type: badge_type, label: BADGE_LABELS[badge_type] || badge_type } : null,
    composition:  [
      ...(description  ? [description]  : []),
      ...(ingredients && ingredients !== name ? [ingredients] : []),
    ],
    suppliers:    [],
    pricing:      buildPricing(price),
    isActive:     true,
    sortOrder:    sort_order ?? 0,
    subcategoryId: subcatSlug ? (subcategoryCache[subcatSlug] ?? null) : null,
  };
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const tools = [
  {
    name: 'get_stats',
    description:
      'Получить статистику магазина: общая выручка, заказы по статусам, ' +
      'пользователи, топ-5 товаров, выручка за неделю.',
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
        day_of_week: { type: 'number', description: 'День недели: 0=Вс, 1=Пн, 2=Вт, 3=Ср, 4=Чт, 5=Пт, 6=Сб' },
        slot:        { type: 'string', description: 'Временной слот, например "18:00–21:00"' },
        is_open:     { type: 'boolean', description: 'Открыт ли день для доставки' },
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
    description: 'Создать один новый товар в каталоге. Категорию, подкатегорию, emoji и bg система определит по названию автоматически.',
    input_schema: {
      type: 'object',
      properties: {
        name:        { type: 'string',  description: 'Название товара' },
        price:       { type: 'number',  description: 'Итоговая цена в рублях (уже с наценкой)' },
        weight:      { type: 'string',  description: 'Вес/объём: "1 кг", "500 г", "100 г"' },
        description: { type: 'string',  description: 'Описание товара (1-2 предложения)' },
        ingredients: { type: 'string',  description: 'Состав, если применимо' },
        badge_type:  { type: 'string',  description: 'Бейдж: hit, eco, new, popular — или не передавать' },
        sort_order:  { type: 'number',  description: 'Порядок сортировки' },
        is_active:   { type: 'boolean', description: 'Активен (по умолчанию true)' },
        category:    { type: 'string',  description: 'Переопределить категорию: vegetables, fruits или greens' },
      },
      required: ['name', 'price'],
    },
  },
  {
    name: 'create_products_bulk',
    description:
      'Массово создать товары по списку с минимальными данными. ' +
      'Злата генерирует: description, weight, badge_type. ' +
      'Система вычисляет сама: цену (wholesale×3 с округлением), категорию, подкатегорию, разбивку цены. ' +
      'После создания сообщи пользователю список товаров с финальными ценами.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          description: 'Список товаров для создания',
          items: {
            type: 'object',
            properties: {
              name:            { type: 'string', description: 'Название товара' },
              wholesale_price: { type: 'number', description: 'Оптовая цена в рублях (без наценки)' },
              description:     { type: 'string', description: '1-2 предложения в тёплом тоне эко-бренда' },
              weight:          { type: 'string', description: 'Вес/объём: "1 кг", "500 г", "100 г"' },
              badge_type:      { type: 'string', description: 'Бейдж: hit, eco, new, popular — или не передавать' },
              ingredients:     { type: 'string', description: 'Состав, если применимо' },
              sort_order:      { type: 'number', description: 'Порядок сортировки' },
            },
            required: ['name', 'wholesale_price'],
          },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'get_orders',
    description: 'Получить список заказов (все статусы, последние по дате).',
    input_schema: { type: 'object', properties: {}, required: [] },
  },
];

// ── Tool executor ─────────────────────────────────────────────────────────────

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

    case 'create_product': {
      const body = buildProductBody({
        name:        input.name,
        price:       input.price,
        category:    input.category,
        weight:      input.weight,
        description: input.description,
        ingredients: input.ingredients,
        badge_type:  input.badge_type,
        sort_order:  input.sort_order,
      });
      if (input.is_active === false) body.isActive = false;
      return apiRequest('/api/admin/products', 'POST', body);
    }

    case 'create_products_bulk': {
      const results = [];
      for (let i = 0; i < input.items.length; i++) {
        const item  = input.items[i];
        const price = roundPrice(item.wholesale_price * 3);
        const body  = buildProductBody({
          name:        item.name,
          price,
          weight:      item.weight,
          description: item.description,
          ingredients: item.ingredients,
          badge_type:  item.badge_type,
          sort_order:  item.sort_order ?? i,
          index:       i,
        });
        try {
          const res = await apiRequest('/api/admin/products', 'POST', body);
          results.push({
            name:     item.name,
            price,
            category: body.category,
            id:       body.id,
            status:   res.error ? 'error' : 'ok',
            error:    res.error,
          });
        } catch (e) {
          results.push({ name: item.name, price, status: 'error', error: String(e) });
        }
      }
      return {
        created: results.filter(r => r.status === 'ok').length,
        total:   results.length,
        results,
      };
    }

    case 'get_orders':
      return apiRequest('/api/admin/orders');

    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Message handling ──────────────────────────────────────────────────────────

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

  const chatId       = msg.chat.id;
  const contentParts = [];

  if (msg.photo) {
    const largest = msg.photo[msg.photo.length - 1];
    const base64  = await downloadPhotoAsBase64(largest.file_id);
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
      model:      'claude-opus-4-8',
      max_tokens: 4096,
      thinking:   { type: 'adaptive' },
      system:
        'Ты помощник администратора интернет-магазина «Прилавка» (доставка эко-продуктов, Москва). ' +
        'Отвечай кратко и по делу на русском языке. ' +
        'Используй инструменты для получения актуальных данных из системы. ' +
        'Числа форматируй читаемо: пробел как разделитель тысяч, руб. для рублей.\n\n' +
        'Когда пользователь присылает список товаров с оптовыми ценами ' +
        '(например «морковь 50, лук 30» или таблицу), используй инструмент create_products_bulk. ' +
        'Для каждого товара сгенерируй description (1-2 предложения, тёплый тон эко-бренда, ' +
        'ориентир — Экомаркет/ВкусВилл), подбери реалистичный weight ' +
        '(зелень ~100 г, корнеплоды/овощи 500 г–1 кг, фрукты 1 кг), ' +
        'выбери badge_type (eco/hit/new/popular) или не передавай если неочевидно. ' +
        'Цену продажи, категорию, подкатегорию и разбивку цены система посчитает сама — ' +
        'передавать их не нужно. ' +
        'После создания покажи пользователю список добавленных товаров с финальными ценами.',
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
        type:        'tool_result',
        tool_use_id: block.id,
        content:     JSON.stringify(result),
      });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user',      content: toolResults });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  await sendMessage(chatId, textBlock?.text ?? '(нет ответа)');
}

// ── Polling ───────────────────────────────────────────────────────────────────

async function startPolling() {
  if (!BOT_TOKEN) {
    console.error('TELEGRAM_BOT_TOKEN не задан');
    process.exit(1);
  }
  await loadSubcategoryCache();
  let offset = 0;
  console.log('Агент запущен (long polling)');
  for (;;) {
    try {
      const res  = await fetch(
        `https://api.telegram.org/bot${BOT_TOKEN}/getUpdates` +
        `?timeout=25&offset=${offset}&allowed_updates=["message"]`
      );
      const data = await res.json();
      if (data.ok && data.result.length > 0) {
        for (const update of data.result) {
          handleUpdate(update).catch(e => console.error('handleUpdate error:', e));
          offset = update.update_id + 1;
        }
      }
    } catch (e) {
      console.error('Polling error:', e);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

startPolling();
