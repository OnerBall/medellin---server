// parse.js — разбирает текст поста из канала в товар.
// Ожидаемый (но не обязательный) формат, как в канале Medellin:
//   ❗️Женские трусы❗️
//   Производство: 🇨🇳
//   📦 В упаковке: 12шт. — разный размер, один цвет
//   📏 Размеры: M L
//   💰 Цена оптом: 650тг / шт.
//   #женскиетрусы
const { detect } = require("./categories");
const { detectUnit } = require("./units");

const PACK_DEFAULT = parseInt(process.env.PACK_DEFAULT || "12", 10);

const FLAGS = { "🇨🇳": "Китай", "🇹🇷": "Турция", "🇰🇿": "Казахстан", "🇺🇿": "Узбекистан", "🇷🇺": "Россия", "🇰🇬": "Кыргызстан", "🇮🇳": "Индия", "🇧🇩": "Бангладеш" };
const COLORS = {
  "черн": ["чёрный", "#151515"], "бел": ["белый", "#F4F1EA"], "красн": ["красный", "#C8323B"], "розов": ["розовый", "#F2B3BC"],
  "пудр": ["пудровый", "#E8C3BC"], "беж": ["бежевый", "#D9C3A5"], "голуб": ["голубой", "#9BB8DD"], "син": ["синий", "#2F4F8F"],
  "сер": ["серый", "#9A9A9A"], "зелен": ["зелёный", "#4F7A5A"], "бордов": ["бордовый", "#6A1422"], "фиолет": ["фиолетовый", "#7B5AA6"],
  "желт": ["жёлтый", "#E7C552"], "коричн": ["коричневый", "#6B4A35"], "молочн": ["молочный", "#F3E9D8"], "хаки": ["хаки", "#7A7550"]
};
const SIZE_RE = /^(XXS|XS|S|M|L|XL|XXL|XXXL|[2-8]XL|\d{2,3}(?:[-–\/]\d{2,3})?|\d{1,2}[-–]\d{1,2}(?:\s*лет)?)$/i;

const stripDecor = (s) => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}❗️❕‼️⭐️✨]/gu, "").replace(/\s{2,}/g, " ").trim();
const num = (s) => parseInt(String(s).replace(/[\s., ]/g, ""), 10);

function parseCaption(caption) {
  const raw = (caption || "").trim();
  const hashtags = (raw.match(/#[0-9A-Za-zА-Яа-яЁё_]+/g) || []).map((h) => h.slice(1).toLowerCase());
  const lines = raw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const body = lines.filter((l) => !/^(#[^\s]+\s*)+$/.test(l));

  // название — первая содержательная строка
  let name = "";
  for (const l of body) {
    const s = stripDecor(l.replace(/#[^\s]+/g, "")).replace(/[:—-]+$/, "").trim();
    if (s && !/^(производство|цена|размер|в упаковке|отправля|для заказа|доставка)/i.test(s)) { name = s; break; }
  }
  name = name.slice(0, 80);

  // цена: сначала строка со словом «цена», потом любое число с тг/₸
  const priceRe = /(\d[\d\s., ]*\d|\d)\s*(?:тг|₸|тенге|tg|kzt)/i;
  let price = null;
  const priceLine = body.find((l) => /цена/i.test(l) && priceRe.test(l)) || body.find((l) => priceRe.test(l));
  if (priceLine) price = num(priceLine.match(priceRe)[1]);
  if (price !== null && (isNaN(price) || price <= 0 || price > 10_000_000)) price = null;

  // упаковка
  let pack = null;
  const packLine = body.find((l) => /(упаков|в пачке|пачка|набор из|в коробке)/i.test(l) && /\d+\s*шт/i.test(l));
  if (packLine) pack = parseInt(packLine.match(/(\d+)\s*шт/i)[1], 10);
  const packGuessed = !pack;
  if (!pack || pack > 500) pack = PACK_DEFAULT;

  // размеры
  let sizes = [];
  const sizeLine = body.find((l) => /размер[а-я]*\s*[:\-–]/i.test(l)) || body.find((l) => /размер/i.test(l) && !/(разн\w*|ассорти\w*)\s+размер/i.test(l));
  if (sizeLine) {
    const after = sizeLine.split(/размер[а-я]*\s*[:\-–]?/i)[1] || "";
    sizes = stripDecor(after).split(/[\s,;|]+|(?<=[A-Za-z])\/(?=[A-Za-z])/).map((x) => x.trim().replace(/\.$/, "")).filter((x) => SIZE_RE.test(x)).map((x) => x.toUpperCase());
    sizes = [...new Set(sizes)].slice(0, 12);
  }

  // цвета — только если явно перечислены
  const colors = [];
  const colorLine = body.find((l) => /цвет/i.test(l) && !/один цвет|разн\w* цвет|ассорти/i.test(l));
  if (colorLine) {
    const t = colorLine.toLowerCase().replace(/ё/g, "е");
    for (const [stem, c] of Object.entries(COLORS)) if (t.includes(stem)) colors.push({ name: c[0], hex: c[1] });
  }

  // страна производства
  let country = "";
  const countryLine = body.find((l) => /производств/i.test(l));
  if (countryLine) {
    const flag = Object.keys(FLAGS).find((f) => countryLine.includes(f));
    country = flag ? FLAGS[flag] : stripDecor(countryLine.split(/[:\-–]/).slice(1).join(" ")).slice(0, 30);
  }

  // описание — текст без хэштегов и строки про заказ
  const description = body
    .filter((l) => !/(whatsapp|wa\.me|для заказа|пишите)/i.test(l))
    .map((l) => stripDecor(Object.entries(FLAGS).reduce((a, [f, n]) => a.split(f).join(n), l).replace(/#[^\s]+/g, "")))
    .filter(Boolean)
    .slice(1)
    .join("\n")
    .slice(0, 800);

  const category = detect(hashtags, name + " " + raw);
  const unit = detectUnit(priceLine, name);
  return { name, price, pack, packGuessed, sizes, colors, country, description, hashtags, category, unit };
}

module.exports = { parseCaption, PACK_DEFAULT };
