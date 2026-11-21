// aicolors.js — ИИ смотрит на фото товара и называет цвета (когда все расцветки на одном фото).
// Нужен OPENAI_API_KEY в Railway. Без ключа ничего не делает.
const products = require("./products");

const KEY = (process.env.OPENAI_API_KEY || "").trim();
const BASE = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const MODEL = process.env.AI_VISION_MODEL || "gpt-4o-mini";
const enabled = () => !!KEY;

const PAL = ["чёрный", "белый", "молочный", "бежевый", "капучино", "коричневый", "серый", "графит", "розовый", "пудра", "красный", "бордо", "малиновый",
  "сиреневый", "фиолетовый", "голубой", "синий", "тёмно-синий", "бирюзовый", "мятный", "зелёный", "хаки", "оливковый", "жёлтый", "горчичный", "оранжевый", "персиковый"];
const MIX_RE = /(разн[а-яё]*|микс|ассорти|разноцветн[а-яё]*)\s+(цвет|расцвет)|(цвет[а-яё]*|расцветк[а-яё]*)\s*[:\-–]?\s*(микс|ассорти|разные)|в\s+ассортименте/i;
const ONE_RE = /(один|одного|1)\s*цвет|однотон/i;
const jarr = (s) => { try { const a = JSON.parse(s || "null"); return Array.isArray(a) ? a : null; } catch (e) { return null; } };
const photosOf = (r) => { const m = products.mediaOf(r); return m ? m.filter((x) => x.t === "p").map((x) => x.id) : (jarr(r.photos) || []); };
const listed = (r) => (jarr(r.colors) || []).map((c) => (typeof c === "string" ? c : c && c.name)).filter(Boolean);

// товар, которому нужны цвета: цвет ещё не настраивали, в посте не «микс» и цвета не перечислены,
// и это «один цвет в упаковке» или вообще одно фото
function candidate(r) {
  if (!r || r.color_mode) return false;
  const cap = r.caption || "";
  if (MIX_RE.test(cap) || listed(r).length > 1) return false;
  const n = photosOf(r).length;
  return n >= 1 && (ONE_RE.test(cap) || n === 1);
}

async function photoData(fileId) {
  const { bot } = require("./bot");
  if (!bot) throw new Error("bot off");
  const link = await bot.telegram.getFileLink(fileId);
  const resp = await fetch(link.href);
  if (!resp.ok) throw new Error("telegram " + resp.status);
  return "data:image/jpeg;base64," + Buffer.from(await resp.arrayBuffer()).toString("base64");
}

// → ["чёрный", "бежевый", …] — цвета изделий на первом фото, слева направо / сверху вниз
async function detect(r) {
  if (!enabled()) throw new Error("нет OPENAI_API_KEY");
  const ph = photosOf(r)[0];
  if (!ph) return [];
  const img = await photoData(ph);
  const prompt = `На фото оптовый товар (бельё/одежда): несколько одинаковых изделий разных цветов.
Назови цвет КАЖДОГО изделия, по порядку слева направо / сверху вниз. Фон, цветы, бирки, упаковку и надписи не считай.
Используй только слова из списка: ${PAL.join(", ")}.
Если два изделия одного цвета, но с разным рисунком — добавь коротко рисунок: «серый в горошек», «белый с принтом». Одинаковые изделия не повторяй.
Название товара: ${r.name || ""}.
Ответ строго JSON: {"colors":["…","…"]}`;
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: MODEL, temperature: 0, response_format: { type: "json_object" }, max_tokens: 200,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: img, detail: "high" } }] }] }),
  });
  const j = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error((j.error && j.error.message) || `HTTP ${resp.status}`);
  let out = [];
  try { out = JSON.parse(j.choices[0].message.content).colors || []; } catch (e) { return []; }
  const seen = new Set();
  return out.map((s) => String(s).trim().toLowerCase().replace(/ё/g, "ё")).filter((s) => s && s.length <= 30 && !seen.has(s) && seen.add(s)).slice(0, 20);
}

// определить и сохранить; вернёт цвета, если их 2 и больше (иначе ничего не меняет)
async function apply(r) {
  const names = await detect(r);
  const n = photosOf(r).length;
  // каждый цвет на своём фото — выбор по фото уже работает, не трогаем
  if (names.length < 2 || (n > 1 && names.length <= n)) {
    if (n === 1 && names.length === 1) products.update(r.id, { color_mode: "mix" }); // одно фото, один цвет — выбор не нужен, больше не спрашиваем
    return [];
  }
  const cap = names.map((s) => s[0].toUpperCase() + s.slice(1));
  products.update(r.id, { color_mode: "names", color_names: JSON.stringify(cap) });
  return cap;
}

module.exports = { enabled, candidate, detect, apply };
