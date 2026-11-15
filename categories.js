// categories.js — разделы и категории каталога + хэштеги, по которым
// бот раскладывает посты из канала. Чтобы добавить категорию —
// допишите строку в CATEGORIES и поставьте этот хэштег в посте.

const SECTIONS = [
  { key: "women", title: "Женщинам" },
  { key: "men", title: "Мужчинам" },
  { key: "kids", title: "Детям" }
];

// key — внутренний ключ, tag — хэштег в канале (без #, регистр не важен)
const CATEGORIES = [
  { key: "w_panties", section: "women", title: "Трусы", tag: "женскиетрусы" },
  { key: "w_tops", section: "women", title: "Майки", tag: "женскиемайки" },
  { key: "w_croptops", section: "women", title: "Топы", tag: "топы", alt: ["топ", "женскиетопы"] },
  { key: "w_tshirts", section: "women", title: "Футболки", tag: "женскиефутболки", alt: ["футболки"] },
  { key: "w_pajamas", section: "women", title: "Пижамы", tag: "пижамы" },
  { key: "w_robes", section: "women", title: "Халаты", tag: "халаты" },
  { key: "w_sets", section: "women", title: "Комплекты", tag: "комплекты" },
  { key: "w_leggings", section: "women", title: "Лосины и панталоны", tag: "лосины", alt: ["панталоны", "леггинсы"] },
  { key: "w_thermo", section: "women", title: "Термобельё", tag: "терможенское" },
  { key: "m_briefs", section: "men", title: "Трусы", tag: "мужскиетрусы" },
  { key: "m_tops", section: "men", title: "Майки", tag: "мужскиемайки" },
  { key: "m_tshirts", section: "men", title: "Футболки", tag: "мужскиефутболки" },
  { key: "m_thermo", section: "men", title: "Термобельё", tag: "термомужское" },
  { key: "k_girls_panties", section: "kids", title: "Трусы для девочек", tag: "трусыдевочкам" },
  { key: "k_boys_panties", section: "kids", title: "Трусы для мальчиков", tag: "трусымальчикам" },
  { key: "k_girls_tops", section: "kids", title: "Майки для девочек", tag: "майкидевочкам" },
  { key: "k_boys_tops", section: "kids", title: "Майки для мальчиков", tag: "майкимальчикам" },
  { key: "k_girls_croptops", section: "kids", title: "Топы для девочек", tag: "топыдевочкам", alt: ["топдевочкам"] },
  { key: "k_thermo", section: "kids", title: "Термобельё", tag: "термодетское" }
];

const BY_KEY = Object.fromEntries(CATEGORIES.map((c) => [c.key, c]));
const BY_TAG = Object.fromEntries(CATEGORIES.flatMap((c) => [c.tag, ...(c.alt || [])].map((t) => [t, c])));
const SECTION_TITLE = Object.fromEntries(SECTIONS.map((s) => [s.key, s.title]));

function label(key) {
  const c = BY_KEY[key];
  return c ? `${SECTION_TITLE[c.section]} → ${c.title}` : "без категории";
}

// Категория по хэштегам, а если их нет — по словам в названии
function detect(hashtags, text) {
  for (const h of hashtags) {
    const c = BY_TAG[h.toLowerCase().replace(/^#/, "").replace(/ё/g, "е")] || BY_TAG[h.toLowerCase().replace(/^#/, "")];
    if (c) return c.key;
  }
  const t = (text || "").toLowerCase().replace(/ё/g, "е");
  const kid = /детск|девоч|мальч/.test(t);
  const girl = /девоч/.test(t);
  const men = /мужск/.test(t);
  if (/термо/.test(t)) return kid ? "k_thermo" : men ? "m_thermo" : /женск/.test(t) ? "w_thermo" : null;
  if (/пижам/.test(t)) return "w_pajamas";
  if (/лосин|панталон|леггин|легинс/.test(t) && !kid && !men) return "w_leggings";
  if (/(^|[^а-я])топ(ы|ик|ики)?([^а-я]|$)/.test(t) && !men) return kid ? (girl || !/мальч/.test(t) ? "k_girls_croptops" : null) : "w_croptops";
  if (/футболк/.test(t) && !kid) return men ? "m_tshirts" : "w_tshirts";
  if (/халат/.test(t)) return "w_robes";
  if (/комплект|набор/.test(t)) return "w_sets";
  if (/майк/.test(t)) return kid ? (girl ? "k_girls_tops" : /мальч/.test(t) ? "k_boys_tops" : null) : men ? "m_tops" : /женск/.test(t) ? "w_tops" : null;
  if (/трус|боксер|плавк|слип|стринг/.test(t)) return kid ? (girl ? "k_girls_panties" : /мальч/.test(t) ? "k_boys_panties" : null) : men ? "m_briefs" : /женск/.test(t) ? "w_panties" : null;
  return null;
}

module.exports = { SECTIONS, CATEGORIES, BY_KEY, SECTION_TITLE, label, detect };
