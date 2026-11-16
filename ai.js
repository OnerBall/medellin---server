// ai.js — AI-ассистент каталога: голос → текст → подбор товаров.
// Нужен OPENAI_API_KEY. Без ключа работает простой поиск по словам (голос — нет).
const products = require("./products");
const { BY_KEY, SECTION_TITLE } = require("./categories");

const KEY = (process.env.OPENAI_API_KEY || "").trim();
const BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const CHAT_MODEL = process.env.AI_MODEL || "gpt-4o-mini";
const STT_MODEL = process.env.AI_STT_MODEL || "gpt-4o-mini-transcribe";
const enabled = () => !!KEY;

// ---------- речь → текст ----------
async function transcribe(src, mime = "audio/ogg") {
  let buf = src;
  if (typeof src === "string") {
    const audio = await fetch(src);
    if (!audio.ok) throw new Error("не удалось скачать голосовое");
    buf = Buffer.from(await audio.arrayBuffer());
  }
  const type = String(mime || "audio/ogg").split(";")[0];
  const ext = /mp4|m4a|aac/.test(type) ? "m4a" : /webm/.test(type) ? "webm" : /mpeg|mp3/.test(type) ? "mp3" : /wav/.test(type) ? "wav" : "ogg";
  const tryModel = async (model) => {
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type }), `voice.${ext}`);
    fd.append("model", model);
    fd.append("language", "ru");
    fd.append("prompt", "Оптовый магазин белья: трусы, майки, топы, пижамы, халаты, сорочки, термобельё, лосины, носки, боди, кофты, размеры S M L XL XXL.");
    const r = await fetch(`${BASE}/audio/transcriptions`, { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: fd });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
    return String(j.text || "").trim();
  };
  try { return await tryModel(STT_MODEL); }
  catch (e) { if (STT_MODEL !== "whisper-1") return tryModel("whisper-1"); throw e; }
}

// ---------- каталог в компактном виде для модели ----------
function catalogLines(list) {
  return list.map((p) => {
    const c = BY_KEY[p.category];
    const where = c ? `${SECTION_TITLE[c.section]}/${c.title}` : "";
    const desc = (p.description || "").replace(/\s+/g, " ").slice(0, 90);
    return [p.id, p.name, where, `${p.price}₸/${p.unit.label}`, p.sizes.join(" "), p.colors.join(" "), p.inStock ? "" : "нет в наличии", desc]
      .filter(Boolean).join(" | ");
  }).join("\n");
}

// ---------- запасной поиск без AI ----------
const norm = (s) => String(s || "").toLowerCase().replace(/ё/g, "е");
const stem = (w) => (w.length > 5 ? w.slice(0, w.length - 2) : w.length > 3 ? w.slice(0, w.length - 1) : w);
function simpleSearch(q, list) {
  const words = norm(q).split(/[^a-zа-я0-9]+/).filter((w) => w.length > 1).map(stem);
  if (!words.length) return [];
  return list.map((p) => {
    const c = BY_KEY[p.category];
    const hay = norm([p.name, p.description, c && c.title, c && SECTION_TITLE[c.section], p.sizes.join(" "), p.colors.join(" ")].join(" "));
    return [p, words.filter((w) => hay.includes(w)).length + (p.inStock ? 0.1 : 0)];
  }).filter(([, s]) => s >= 1).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p);
}

// ---------- подбор товаров ----------
async function find(query) {
  const list = products.listPublic();
  if (!list.length) return { reply: "Каталог пока наполняется — загляните чуть позже 🤍", items: [] };
  if (!enabled()) {
    const items = simpleSearch(query, list);
    return { reply: items.length ? "Вот что нашла по вашему запросу 👇" : "", items };
  }
  const sys = `Ты — вежливый консультант оптового магазина белья Medellin (Казахстан). Клиент описывает, что ищет (голосом или текстом, бывают ошибки распознавания).
Выбери из каталога до 6 самых подходящих товаров. Учитывай раздел (женщинам/мужчинам/детям), тип, размер, цвет, бюджет. Товары «нет в наличии» предлагай только если других нет.
Если запрос не про товары (приветствие, вопрос о доставке, оплате) — ответь коротко и верни пустой список. Минимальный заказ ${process.env.MIN_ORDER || 50000} ₸, доставка по Казахстану и СНГ.
Если подходящего нет — честно скажи и предложи похожее.
Ответ строго JSON: {"reply":"1–2 коротких предложения на русском, на «вы», без перечисления товаров","ids":["id",...]}
Каталог (id | название | раздел/категория | цена | размеры | цвета | наличие | описание):
${catalogLines(list)}`;
  const r = await fetch(`${BASE}/chat/completions`, {
    method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: CHAT_MODEL, temperature: 0.2, response_format: { type: "json_object" }, max_tokens: 300,
      messages: [{ role: "system", content: sys }, { role: "user", content: String(query).slice(0, 500) }] })
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || `HTTP ${r.status}`);
  let out = {};
  try { out = JSON.parse(j.choices[0].message.content); } catch (e) {}
  const byId = new Map(list.map((p) => [p.id, p]));
  const items = (Array.isArray(out.ids) ? out.ids : []).map((id) => byId.get(String(id))).filter(Boolean).slice(0, 6);
  return { reply: String(out.reply || "").slice(0, 400), items };
}

// ---------- лимит запросов, чтобы не сжечь бюджет ----------
const LIMIT = parseInt(process.env.AI_LIMIT_PER_HOUR || "20", 10);
const hits = new Map();
function allow(uid) {
  const now = Date.now(), arr = (hits.get(uid) || []).filter((t) => now - t < 3600e3);
  if (arr.length >= LIMIT) { hits.set(uid, arr); return false; }
  arr.push(now); hits.set(uid, arr); return true;
}

module.exports = { enabled, transcribe, find, allow };
