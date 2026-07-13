import 'dotenv/config';
import fetch from 'node-fetch';
import Anthropic from '@anthropic-ai/sdk';

const BOT_TOKEN       = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_API_URL   = process.env.ADMIN_API_URL;
const ADMIN_JWT_TOKEN = process.env.ADMIN_JWT_TOKEN;
const ALLOWED_USER_ID = 686803005;
const MINI_APP_URL    = process.env.MINI_APP_URL || 'https://prilavka-app-production.up.railway.app';
const PENDING_TTL_MS  = 5 * 60 * 1000; // черновик правки товара живёт 5 минут

const START_MESSAGE = `Привет! 👋 Я Михаил, делаю доставку свежих овощей и фруктов на юго-запад Москвы.

Работаю со своими проверенными поставщиками, лично отбираю лучшее, привожу вечером с 18:00 до 21:00.

💳 Оплата при получении — никакой предоплаты
🌿 Показываю честно, куда уходит каждый рубль
📍 Работаю по вашему району

Жмите кнопку ниже, чтобы посмотреть каталог 👇`;

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
    { pct: 33, label: 'Фермерам',          sub: 'закупка напрямую у производителей', color: '#2A7A2A', amount: Math.round(price * 0.33) },
    { pct: 25, label: 'Логистика',          sub: 'доставка и хранение',               color: '#E0A458', amount: Math.round(price * 0.25) },
    { pct: 12, label: 'Упаковка',           sub: 'бережная упаковка без пластика',    color: '#8B6F47', amount: Math.round(price * 0.12) },
    { pct: 15, label: 'Контроль качества',  sub: 'отбор и проверка свежести',         color: '#6B92B8', amount: Math.round(price * 0.15) },
    { pct: 15, label: 'Сервис',             sub: 'работа платформы и эквайринг',      color: '#C4782A', amount: Math.round(price * 0.15) },
  ];
}

// ── Category visual defaults ──────────────────────────────────────────────────

const CATEGORY_EMOJI  = { vegetables: '🥦', fruits: '🍎', greens: '🌿' };
const CATEGORY_BG     = {
  vegetables: 'var(--color-accent-soft)',
  greens:     'var(--color-accent-soft)',
  fruits:     '#FFF0E0',
};
const BADGE_LABELS    = { hit: 'Хит', eco: 'Эко', new: 'Новинка', popular: 'Популярное', deal: 'Выгодно' };

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
      ...(description  ? [[description, '']]  : []),
      ...(ingredients && ingredients !== name ? [[ingredients, '']] : []),
    ],
    suppliers:    [],
    pricing:      buildPricing(price),
    isActive:     true,
    sortOrder:    sort_order ?? 0,
    subcategoryId: subcatSlug ? (subcategoryCache[subcatSlug] ?? null) : null,
  };
}

// ── Pending product-update drafts (chatId → draft), confirmed via plain "да"/"нет" ──

const pendingChanges = new Map();

const FIELD_LABELS = {
  title:         'Название',
  price:         'Цена',
  weight:        'Вес/объём',
  category:      'Категория',
  sortOrder:     'Порядок сортировки',
  isActive:      'Показывать в приложении',
  inStock:       'В наличии',
  isBundle:      'Набор с кастомизируемым составом',
  badge:         'Метка',
  emoji:         'Эмодзи',
  bg:            'Фон карточки',
  imageUrl:      'Фото товара',
  homeImageUrl:  'Фото для Главной',
  subcategoryId: 'Подкатегория',
  composition:   'Состав',
  suppliers:     'Поставщики',
  pricing:       'Разбивка цены',
  nutrition:     'Пищевая ценность',
};

function formatComposition(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '—';
  return arr.map(([name, amount]) => (amount ? `${name}: ${amount}` : name)).join(', ');
}

function formatSuppliers(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '—';
  return arr.map(s => (s.region ? `${s.name} (${s.region})` : s.name)).join(', ');
}

function formatPricing(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '—';
  return arr.map(p => `${p.label} ${p.pct}%`).join(', ');
}

function formatNutrition(n) {
  if (!n) return '—';
  return `К:${n.calories ?? '—'} Б:${n.protein ?? '—'} Ж:${n.fat ?? '—'} У:${n.carbs ?? '—'}`;
}

function formatValue(field, value) {
  if (field === 'badge') {
    if (!value) return 'нет';
    const label = BADGE_LABELS[value.type] || value.type;
    return value.label && value.label !== label ? `${label} ("${value.label}")` : label;
  }
  if (field === 'composition') return formatComposition(value);
  if (field === 'suppliers')   return formatSuppliers(value);
  if (field === 'pricing')     return formatPricing(value);
  if (field === 'nutrition')   return formatNutrition(value);
  if (field === 'isActive' || field === 'inStock' || field === 'isBundle') return value ? 'да' : 'нет';
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}

// Сравнивает запрошенные изменения с текущим товаром (DTO из GET /api/admin/products)
// и строит {payload, diff}: payload — только реально изменившиеся поля (для PUT,
// который сам умеет частичные обновления), diff — человекочитаемый список
// "было → стало" для показа пользователю перед подтверждением.
//
// extra.subcategoryResolution — уже отрезолвленная подкатегория (по имени, с
// проверкой принадлежности итоговой категории) или явный сброс, готовится
// вызывающим кодом (executeTool), т.к. требует сетевого похода за списком
// подкатегорий. undefined = подкатегорию не меняем.
// extra.subcategoriesById — id → name, только для отображения старого значения в diff.
function buildProductUpdate(input, cur, extra = {}) {
  const payload = {};
  const diff = [];

  const setField = (dtoKey, newVal) => {
    if (newVal === undefined || newVal === cur[dtoKey]) return;
    payload[dtoKey] = newVal;
    diff.push({ field: dtoKey, label: FIELD_LABELS[dtoKey] || dtoKey, from: formatValue(dtoKey, cur[dtoKey]), to: formatValue(dtoKey, newVal) });
  };

  setField('title', input.title);
  setField('price', input.price);
  setField('weight', input.weight);
  setField('category', input.category);
  setField('sortOrder', input.sort_order);
  setField('isActive', input.is_active);
  setField('inStock', input.in_stock);
  setField('isBundle', input.is_bundle);
  setField('emoji', input.emoji);
  setField('bg', input.bg);

  // image_url / home_image_url: нужен реальный http(s)-адрес, ничего не
  // выдумываем. Пустая строка — явная очистка (бэкенд сам превращает '' в null).
  for (const [inputKey, dtoKey] of [['image_url', 'imageUrl'], ['home_image_url', 'homeImageUrl']]) {
    if (input[inputKey] === undefined) continue;
    const val = String(input[inputKey]).trim();
    if (val && !/^https?:\/\//i.test(val)) continue; // не похоже на ссылку — молча игнорируем поле
    setField(dtoKey, val);
  }

  // Бейдж — трёхзначная логика: undefined = не трогать, badge_type
  // '' / 'none' = явно очистить, иначе — установить.
  if (input.badge_type !== undefined) {
    const newBadge = !input.badge_type || input.badge_type === 'none'
      ? null
      : { type: input.badge_type, label: input.badge_label || BADGE_LABELS[input.badge_type] || input.badge_type, color: input.badge_color || null };
    if (JSON.stringify(newBadge) !== JSON.stringify(cur.badge || null)) {
      payload.badge = newBadge;
      diff.push({ field: 'badge', label: 'Метка', from: formatValue('badge', cur.badge), to: formatValue('badge', newBadge) });
    }
  }

  // Подкатегория — id уже отрезолвлен вызывающим кодом, здесь только
  // сравниваем и строим diff по человекочитаемым именам.
  if (extra.subcategoryResolution !== undefined) {
    const newId = extra.subcategoryResolution.id;
    if (newId !== (cur.subcategoryId ?? null)) {
      payload.subcategoryId = newId;
      const oldName = cur.subcategoryId != null ? (extra.subcategoriesById?.[cur.subcategoryId] || cur.subcategoryId) : 'нет';
      const newName = newId != null ? (extra.subcategoryResolution.name || newId) : 'нет';
      diff.push({ field: 'subcategoryId', label: FIELD_LABELS.subcategoryId, from: oldName, to: newName });
    }
  }

  // Состав: либо полная замена (composition), либо правка только первой
  // строки — она же "описание" (description) в терминах create_product,
  // отдельной колонки для описания в БД нет. Не использовать оба сразу —
  // если передан composition, description игнорируется.
  if (input.composition !== undefined) {
    const newComposition = input.composition.map(item => [item.name || '', item.amount || '']);
    if (JSON.stringify(newComposition) !== JSON.stringify(cur.composition || [])) {
      payload.composition = newComposition;
      diff.push({ field: 'composition', label: FIELD_LABELS.composition, from: formatComposition(cur.composition), to: formatComposition(newComposition) });
    }
  } else if (input.description !== undefined) {
    const rest        = (cur.composition || []).slice(1);
    const firstAmount  = cur.composition?.[0]?.[1] || '';
    const newComposition = [[input.description, firstAmount], ...rest];
    if (JSON.stringify(newComposition) !== JSON.stringify(cur.composition || [])) {
      payload.composition = newComposition;
      diff.push({ field: 'composition', label: 'Описание (первая строка состава)', from: formatComposition(cur.composition), to: formatComposition(newComposition) });
    }
  }

  // Поставщики — полная замена массива. imageUrl намеренно не выдумываем —
  // либо переносим существующий (модель видит его через get_products), либо
  // оставляем пустым.
  if (input.suppliers !== undefined) {
    const newSuppliers = input.suppliers.map(s => ({
      emoji: s.emoji || '', name: s.name || '', region: s.region || '', note: s.note || '', imageUrl: s.imageUrl || '',
    }));
    if (JSON.stringify(newSuppliers) !== JSON.stringify(cur.suppliers || [])) {
      payload.suppliers = newSuppliers;
      diff.push({ field: 'suppliers', label: FIELD_LABELS.suppliers, from: formatSuppliers(cur.suppliers), to: formatSuppliers(newSuppliers) });
    }
  }

  // Разбивка цены — полная замена массива, не пересчитывается автоматически
  // при смене price (так же ведёт себя и админка).
  if (input.pricing !== undefined) {
    const newPricing = input.pricing.map(p => ({
      label: p.label || '', sub: p.sub || '', pct: p.pct ?? 0, amount: p.amount ?? 0, color: p.color || '',
    }));
    if (JSON.stringify(newPricing) !== JSON.stringify(cur.pricing || [])) {
      payload.pricing = newPricing;
      diff.push({ field: 'pricing', label: FIELD_LABELS.pricing, from: formatPricing(cur.pricing), to: formatPricing(newPricing) });
    }
  }

  // Пищевая ценность — задаётся целиком (все 4 поля разом), очистка через
  // этот инструмент не поддерживается (редкий случай, делается в админке).
  if (input.nutrition !== undefined) {
    if (JSON.stringify(input.nutrition) !== JSON.stringify(cur.nutrition || null)) {
      payload.nutrition = input.nutrition;
      diff.push({ field: 'nutrition', label: FIELD_LABELS.nutrition, from: formatNutrition(cur.nutrition), to: formatNutrition(input.nutrition) });
    }
  }

  return { payload, diff };
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
    name: 'propose_product_update',
    description:
      'Подготовить изменение СУЩЕСТВУЮЩЕГО товара — ЛЮБОГО поля карточки (не создание нового). ' +
      'Находит товар по названию или id, сравнивает с переданными полями и сохраняет черновик изменений — ' +
      'НЕ применяет их сразу. После вызова покажи пользователю список изменений "было → стало" (и warning, если ' +
      'он есть в ответе) и спроси подтверждение обычным текстом (например: "Применить? Напиши да или нет"). ' +
      'Изменения применяются отдельным шагом вне тебя, когда пользователь ответит "да" следующим сообщением — ' +
      'не утверждай, что они уже применены. Передавай только те поля, которые нужно изменить; остальные ' +
      'останутся как есть.\n' +
      'ВАЖНО про composition/suppliers/pricing — это ПОЛНАЯ замена массива, не добавление одного элемента. ' +
      'Если пользователь просит добавить/убрать/поменять один элемент — сначала посмотри текущий список через ' +
      'get_products и пришли сюда весь итоговый массив целиком (иначе остальные элементы потеряются).\n' +
      'ВАЖНО про description — отдельного поля "описание" в базе нет: это первая строка состава ' +
      '(composition[0]). Используй description, только если меняешь именно её, не трогая остальной состав; ' +
      'если нужно переписать весь состав — используй composition. Никогда не передавай оба сразу.',
    input_schema: {
      type: 'object',
      properties: {
        product_query:  { type: 'string',  description: 'Название товара (или его часть) либо id — для поиска' },
        title:          { type: 'string',  description: 'Новое название' },
        price:          { type: 'number',  description: 'Новая цена в рублях' },
        weight:         { type: 'string',  description: 'Новый вес/объём' },
        category:       { type: 'string',  description: 'Новая категория — id из списка существующих категорий магазина (уточни через get_products/каталог, если не уверен)' },
        subcategory:    { type: 'string',  description: 'Название подкатегории из существующих для этой категории — или "none", чтобы убрать подкатегорию' },
        sort_order:     { type: 'number',  description: 'Новый порядок сортировки' },
        is_active:      { type: 'boolean', description: 'Показывать товар в приложении' },
        in_stock:       { type: 'boolean', description: 'Есть в наличии' },
        is_bundle:      { type: 'boolean', description: 'Набор с кастомизируемым составом (влияет на логику чекаута; сами позиции состава набора редактируются отдельно в админке, не этим инструментом)' },
        badge_type:     { type: 'string',  description: 'Новая метка: hit, eco, new, popular, deal — или "none", чтобы убрать метку' },
        badge_label:    { type: 'string',  description: 'Текст метки (если не задан — берётся стандартный по типу)' },
        badge_color:    { type: 'string',  description: 'Цвет метки в hex, опционально' },
        emoji:          { type: 'string',  description: 'Эмодзи-иконка карточки товара' },
        bg:             { type: 'string',  description: 'Фон карточки: CSS-цвет или градиент' },
        image_url:      { type: 'string',  description: 'Прямая ссылка на фото товара (http/https). Пустая строка — убрать фото. НЕ выдумывай ссылку, если пользователь её не давал.' },
        home_image_url: { type: 'string',  description: 'Прямая ссылка на фото для блока "Готовые наборы" на Главной. Пустая строка — убрать. НЕ выдумывай ссылку.' },
        description:    { type: 'string',  description: 'Описание товара — правит только первую строку состава (composition[0]), остальной состав не трогает. Не использовать вместе с composition.' },
        composition: {
          type: 'array',
          description: 'ПОЛНЫЙ новый состав товара ("что внутри"), заменяет текущий целиком. Не использовать вместе с description.',
          items: {
            type: 'object',
            properties: {
              name:   { type: 'string', description: 'Название ингредиента/позиции' },
              amount: { type: 'string', description: 'Количество, например "0.5 кг" — можно оставить пустым' },
            },
            required: ['name'],
          },
        },
        suppliers: {
          type: 'array',
          description: 'ПОЛНЫЙ новый список поставщиков, заменяет текущий целиком.',
          items: {
            type: 'object',
            properties: {
              emoji:    { type: 'string' },
              name:     { type: 'string' },
              region:   { type: 'string' },
              note:     { type: 'string' },
              imageUrl: { type: 'string', description: 'Ссылка на фото поставщика — переноси существующую (см. get_products), не выдумывай новую' },
            },
            required: ['name'],
          },
        },
        pricing: {
          type: 'array',
          description: 'ПОЛНАЯ новая разбивка цены "из чего складывается цена", заменяет текущую целиком. Сумма pct обычно должна быть 100.',
          items: {
            type: 'object',
            properties: {
              label:  { type: 'string' },
              sub:    { type: 'string' },
              pct:    { type: 'number' },
              amount: { type: 'number' },
              color:  { type: 'string' },
            },
            required: ['label', 'pct', 'amount'],
          },
        },
        nutrition: {
          type: 'object',
          description: 'Пищевая ценность на 100 г — передавай все 4 поля разом.',
          properties: {
            calories: { type: 'number' },
            protein:  { type: 'number' },
            fat:      { type: 'number' },
            carbs:    { type: 'number' },
          },
        },
      },
      required: ['product_query'],
    },
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

async function executeTool(name, input, chatId) {
  switch (name) {
    case 'get_stats':
      return apiRequest('/api/admin/stats');

    case 'get_schedule':
      return apiRequest('/api/admin/delivery-schedule');

    case 'update_schedule':
      return apiRequest('/api/admin/delivery-schedule', 'POST', input);

    case 'get_products':
      return apiRequest('/api/admin/products');

    case 'propose_product_update': {
      const [products, categories, subcategories] = await Promise.all([
        apiRequest('/api/admin/products'),
        apiRequest('/api/admin/categories'),
        apiRequest('/api/admin/subcategories'),
      ]);
      if (!Array.isArray(products)) return { error: 'Не удалось получить список товаров' };

      const q = (input.product_query || '').trim().toLowerCase();
      let matches = products.filter(p => p.id.toLowerCase() === q);
      if (matches.length === 0) {
        matches = products.filter(p => p.title.toLowerCase().includes(q));
      }
      if (matches.length === 0) return { error: 'not_found', query: input.product_query };
      if (matches.length > 1) {
        return { error: 'ambiguous', matches: matches.map(p => ({ id: p.id, title: p.title })) };
      }
      const cur = matches[0];

      // Категория — сверяем с живым списком: у неё FK на categories(id),
      // несуществующее значение уронит PUT с невнятной 500-й ошибкой.
      if (input.category !== undefined && Array.isArray(categories)) {
        const validIds = categories.map(c => c.id);
        if (!validIds.includes(input.category)) {
          return { error: 'invalid_category', category: input.category, valid_categories: validIds };
        }
      }

      // Подкатегория — по названию, должна принадлежать итоговой категории
      // товара (как и в админке); "none"/пусто — явный сброс.
      let subcategoryResolution;
      const targetCategory = input.category !== undefined ? input.category : cur.category;
      if (input.subcategory !== undefined) {
        const sq = input.subcategory.trim().toLowerCase();
        if (!sq || sq === 'none') {
          subcategoryResolution = { id: null, name: null };
        } else if (Array.isArray(subcategories)) {
          const scMatches = subcategories.filter(
            sc => sc.categoryId === targetCategory && sc.name.toLowerCase().includes(sq)
          );
          if (scMatches.length === 0) {
            return { error: 'subcategory_not_found', subcategory: input.subcategory, category: targetCategory };
          }
          if (scMatches.length > 1) {
            return { error: 'subcategory_ambiguous', matches: scMatches.map(sc => sc.name) };
          }
          subcategoryResolution = { id: scMatches[0].id, name: scMatches[0].name };
        }
      } else if (input.category !== undefined && input.category !== cur.category && cur.subcategoryId != null) {
        // Категория меняется, подкатегорию явно не указали — сбрасываем,
        // как это делает сама админка (иначе останется несовместимая пара).
        subcategoryResolution = { id: null, name: null };
      }

      // is_bundle — предупреждаем, если включают набор без единой позиции
      // кастомизируемого состава (она живёт в отдельной таблице и этим
      // инструментом не заполняется — покупатель увидит пустой блок).
      let bundleWarning = null;
      if (input.is_bundle === true && cur.isBundle !== true) {
        try {
          const items = await apiRequest(`/api/admin/products/${encodeURIComponent(cur.id)}/composition`);
          if (Array.isArray(items) && items.length === 0) {
            bundleWarning =
              'у товара пока нет позиций кастомизируемого состава — покупатель увидит пустой блок ' +
              '"настройте состав", пока их не добавят отдельно в админке.';
          }
        } catch { /* необязательная проверка, не блокируем предложение из-за её сбоя */ }
      }

      const subcategoriesById = Object.fromEntries(
        (Array.isArray(subcategories) ? subcategories : []).map(sc => [sc.id, sc.name])
      );

      const { payload, diff } = buildProductUpdate(input, cur, { subcategoryResolution, subcategoriesById });
      if (diff.length === 0) return { error: 'no_changes', product: cur.title };

      pendingChanges.set(chatId, {
        productId: cur.id,
        title:     cur.title,
        payload,
        diff,
        expiresAt: Date.now() + PENDING_TTL_MS,
      });

      return {
        product: cur.title,
        id: cur.id,
        changes: diff.map(d => `${d.label}: ${d.from} → ${d.to}`),
        warning: bundleWarning,
        note: 'Черновик сохранён, изменения ещё НЕ применены. Покажи список изменений (и warning, если он есть) пользователю и спроси подтверждение.',
      };
    }

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

  // TEMP DEBUG — убрать после диагностики /start
  console.log('[UPDATE] от', msg.from?.id, 'text:', JSON.stringify(msg.text));

  // /start (в том числе с реферальным диплинком "/start ref_XXXXX") — приветствие
  // с кнопкой Mini App для ЛЮБОГО пользователя, до фильтра по админу.
  if (msg.text === '/start' || msg.text?.startsWith('/start ')) {
    console.log('[START] Получена команда /start от', msg.from?.id); // TEMP DEBUG
    try {
      const result = await tgRequest('sendMessage', {
        chat_id: msg.chat.id,
        text: START_MESSAGE,
        reply_markup: {
          inline_keyboard: [[
            { text: '🛒 Открыть Прилавку', web_app: { url: MINI_APP_URL } },
          ]],
        },
      });
      console.log('[START] Результат отправки:', JSON.stringify(result)); // TEMP DEBUG
    } catch (e) {
      console.error('[START] Исключение при отправке:', e); // TEMP DEBUG
    }
    return;
  }

  if (msg.from?.id !== ALLOWED_USER_ID) return;

  const chatId = msg.chat.id;
  const text   = msg.text || msg.caption;

  // Подтверждение/отмена черновика правки товара — решается детерминированно,
  // в коде, а не моделью: между сообщениями нет истории диалога (messages
  // ниже собирается с нуля на каждый апдейт), поэтому применение изменений
  // в БД не должно зависеть от того, "помнит" ли модель, что предлагала.
  const pending = pendingChanges.get(chatId);
  if (pending && text) {
    const trimmed = text.trim();
    if (/^(да|подтверждаю|ок|окей|применить)\.?$/i.test(trimmed)) {
      pendingChanges.delete(chatId);
      if (Date.now() > pending.expiresAt) {
        await sendMessage(chatId, 'Черновик изменения устарел (прошло больше 5 минут). Сформулируй правку заново.');
        return;
      }
      const result = await apiRequest(`/api/admin/products/${encodeURIComponent(pending.productId)}`, 'PUT', pending.payload);
      if (result?.error) {
        await sendMessage(chatId, `Не удалось применить изменения: ${result.error}`);
      } else {
        await sendMessage(
          chatId,
          `Готово ✅ Товар «${pending.title}» обновлён:\n` +
            pending.diff.map(d => `• ${d.label}: ${d.from} → ${d.to}`).join('\n')
        );
      }
      return;
    }
    if (/^(нет|отмена|отменить|стоп)\.?$/i.test(trimmed)) {
      pendingChanges.delete(chatId);
      await sendMessage(chatId, 'Отменено, изменения не применены.');
      return;
    }
    // Пользователь написал не да/нет, а что-то ещё — черновик больше не
    // актуален, не заставляем его сначала разбираться со старым предложением.
    pendingChanges.delete(chatId);
  }

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
        'При вызове create_products_bulk ОБЯЗАТЕЛЬНО передавай поле description для каждого товара — ' +
        '1-2 предложения на русском в тёплом тоне: например «Сочная молодая морковь с грядки. ' +
        'Богата витамином А и природной сладостью.» Без description товар будет без описания в каталоге. ' +
        'Также подбери реалистичный weight согласно стандартам эко-доставок (Экомаркет, ВкусВилл):\n' +
        'ОВОЩИ: томаты обычные 500-700 г, томаты черри 200-300 г, огурцы 500 г, перец болгарский 500 г, ' +
        'перец острый 100 г, морковь 1 кг, свёкла 1 кг, картофель 1 кг, капуста белокочанная 1 кг, ' +
        'капуста пекинская 500 г, брокколи 400-500 г, цветная капуста 500 г, лук репчатый 1 кг, ' +
        'чеснок 200 г, баклажан 500 г, кабачок 500 г, тыква 1 кг, редис 300 г, кукуруза 2-3 шт, ' +
        'шпинат 200 г, руккола 100-150 г, спаржа 250 г, имбирь 200 г, батат 500 г.\n' +
        'ФРУКТЫ: яблоки/груши 1 кг, персики/нектарины/абрикосы/сливы 500 г, черешня/вишня 500 г, ' +
        'клубника 300-500 г, виноград 500 г, арбуз 1 шт, дыня 1 шт, манго 1-2 шт, ' +
        'киви 500 г или 6 шт, гранат 2-3 шт, лимоны 500 г или 4-5 шт, авокадо 2 шт, хурма 4 шт.\n' +
        'ЗЕЛЕНЬ: петрушка/укроп/кинза/базилик 50-100 г (пучок), мята/тархун/розмарин/тимьян 30-50 г, ' +
        'лук зелёный 100 г, лук-порей 300 г, салат айсберг/романо 1 шт (300-400 г), ' +
        'руккола/шпинат листовой 100-150 г, щавель/мангольд 200 г, микрозелень 50-100 г, ' +
        'черемша 200 г, кресс-салат 100 г. ' +
        'Если товара нет в списке — ориентируйся на ближайший аналог. Не пиши "1 кг" для всего подряд.\n' +
        'Поле badge_type ВСЕГДА оставляй null если пользователь явно не попросил поставить бейдж ' +
        '(например «добавь хит» или «поставь эко»). Не угадывай бейдж самостоятельно. ' +
        'Цену продажи, категорию, подкатегорию и разбивку цены система посчитает сама — ' +
        'передавать их не нужно. ' +
        'После создания покажи пользователю список добавленных товаров с финальными ценами.\n\n' +
        'Чтобы изменить СУЩЕСТВУЮЩИЙ товар — ЛЮБОЕ поле его карточки (цена, вес, категория, подкатегория, ' +
        'метка, наличие, активность, порядок сортировки, название, эмодзи, фон карточки, фото, описание/состав, ' +
        'поставщики, разбивка цены, пищевая ценность, признак "набор") — используй ТОЛЬКО propose_product_update, ' +
        'никогда create_product для этого. Этот инструмент только готовит черновик и ничего не применяет. ' +
        'После вызова покажи пользователю список изменений "было → стало" (и текст из поля warning, если оно ' +
        'непустое) и спроси подтверждение обычным текстом, например: "Применить эти изменения? Напиши да или нет". ' +
        'НЕ утверждай, что изменения уже применены — их применит отдельный шаг после того, как пользователь ' +
        'ответит "да" следующим сообщением.\n' +
        'Если пользователь просит изменить только один элемент внутри composition/suppliers/pricing (например ' +
        '"добавь укроп в состав" или "добавь ещё поставщика"), сначала вызови get_products, чтобы увидеть текущий ' +
        'полный массив, и передай в propose_product_update весь итоговый список целиком — эти поля заменяются ' +
        'полностью, а не дополняются.\n' +
        'Если propose_product_update вернул error:\n' +
        '- "not_found" или "ambiguous" — сообщи и уточни у пользователя, какой товар он имеет в виду;\n' +
        '- "no_changes" — скажи, что все переданные значения совпадают с текущими, менять нечего;\n' +
        '- "invalid_category" — сообщи, что такой категории нет, и перечисли valid_categories из ответа;\n' +
        '- "subcategory_not_found" или "subcategory_ambiguous" — сообщи и уточни точное название подкатегории.',
      tools,
      messages,
    });

    if (response.stop_reason !== 'tool_use') break;

    const toolResults = [];
    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      let result;
      try {
        result = await executeTool(block.name, block.input, chatId);
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
