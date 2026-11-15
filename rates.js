// rates.js — страны покупателей и курсы валют к тенге.
// Курсы сами обновляются по Нацбанку РК; админ может задать свой командой /rate.
const db = require("./db");

const COUNTRIES = [
  { code: "KZ", flag: "🇰🇿", name: "Казахстан", cur: "KZT", sym: "₸", phone: "+7 " },
  { code: "KG", flag: "🇰🇬", name: "Кыргызстан", cur: "KGS", sym: "сом", phone: "+996 " },
  { code: "UZ", flag: "🇺🇿", name: "Узбекистан", cur: "UZS", sym: "сум", phone: "+998 " },
  { code: "RU", flag: "🇷🇺", name: "Россия", cur: "RUB", sym: "₽", phone: "+7 " },
  { code: "TJ", flag: "🇹🇯", name: "Таджикистан", cur: "TJS", sym: "сомони", phone: "+992 " }
];
const BY_CODE = Object.fromEntries(COUNTRIES.map((c) => [c.code, c]));
// примерные курсы (тенге за 1 единицу) — пока не пришли свежие из Нацбанка
const DEFAULTS = { KGS: 5.9, UZS: 0.041, RUB: 6.3, TJS: 47 };

db.exec(`CREATE TABLE IF NOT EXISTS rates (code TEXT PRIMARY KEY, value REAL NOT NULL, manual INTEGER NOT NULL DEFAULT 0, updated_at INTEGER)`);
const cols = db.prepare("PRAGMA table_info(rates)").all().map((c) => c.name);
if (!cols.includes("manual")) db.exec("ALTER TABLE rates ADD COLUMN manual INTEGER NOT NULL DEFAULT 0");
if (!cols.includes("source")) db.exec("ALTER TABLE rates ADD COLUMN source TEXT");
for (const [code, value] of Object.entries(DEFAULTS))
  db.prepare("INSERT OR IGNORE INTO rates (code, value, manual, updated_at) VALUES (?, ?, 0, 0)").run(code, value);

function rate(cur) {
  if (cur === "KZT") return 1;
  const r = db.prepare("SELECT value FROM rates WHERE code=?").get(cur);
  return r ? r.value : DEFAULTS[cur] || null;
}

function allRates() {
  return db.prepare("SELECT code, value, manual, source, updated_at FROM rates ORDER BY code").all();
}

function setManual(cur, value) {
  if (value === null) db.prepare("UPDATE rates SET manual=0 WHERE code=?").run(cur);
  else db.prepare("INSERT INTO rates (code, value, manual, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(code) DO UPDATE SET value=excluded.value, manual=1, updated_at=excluded.updated_at").run(cur, value, Date.now());
}

// сумма в тенге → в валюте страны (округление под валюту)
function convert(kzt, country) {
  const c = BY_CODE[country];
  if (!c || c.cur === "KZT") return null;
  const v = kzt / rate(c.cur);
  return c.cur === "UZS" ? Math.round(v / 100) * 100 : Math.round(v);
}

// страна по номеру телефона
function countryByPhone(phone) {
  const d = String(phone || "").replace(/\D/g, "");
  if (d.startsWith("996")) return "KG";
  if (d.startsWith("998")) return "UZ";
  if (d.startsWith("992")) return "TJ";
  if (/^[78]7/.test(d)) return "KZ";
  if (/^[78][3489]/.test(d)) return "RU";
  return null;
}

// курсы Нацбанка РК (RSS): <title>KGS</title> … <description>5.93</description> … <quant>1</quant>
async function refresh(skip = []) {
  try {
    const resp = await fetch("https://nationalbank.kz/rss/rates_all.xml", { signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const xml = await resp.text();
    let n = 0;
    for (const item of xml.split("<item>").slice(1)) {
      const code = (item.match(/<title>\s*([A-Z]{3})\s*<\/title>/) || [])[1];
      const val = parseFloat((item.match(/<description>\s*([\d.,]+)\s*<\/description>/) || [])[1]?.replace(",", "."));
      const quant = parseFloat((item.match(/<quant>\s*([\d.,]+)\s*<\/quant>/) || [])[1]?.replace(",", ".")) || 1;
      if (!code || !(code in DEFAULTS) || !(val > 0) || skip.includes(code)) continue;
      db.prepare("UPDATE rates SET value=?, updated_at=?, source='nbk' WHERE code=? AND manual=0").run(val / quant, Date.now(), code);
      n++;
    }
    console.log(`[rates] обновлено по Нацбанку: ${n}`);
  } catch (e) {
    console.warn("[rates] не удалось обновить:", e.message);
  }
}

// mig.kz: курс обменника (покупка). На главной есть KGS и RUB; строки таблицы вида
// <tr><td class="buy">4.95</td><td class="currency">KGS</td><td class="sell">5.35</td></tr>
async function refreshMig() {
  const resp = await fetch("https://mig.kz/", { signal: AbortSignal.timeout(15000), headers: { "User-Agent": "Mozilla/5.0 MedellinBot" } });
  if (!resp.ok) throw new Error("mig HTTP " + resp.status);
  const html = await resp.text();
  const got = {};
  for (const row of html.match(/<tr[^>]*>[\s\S]*?<\/tr>/gi) || []) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].replace(/<[^>]+>/g, "").trim());
    const i = cells.findIndex((c) => /^[A-Z]{3}$/.test(c));
    if (i < 1 || !(cells[i] in DEFAULTS)) continue;
    const buy = parseFloat(String(cells[i - 1]).replace(",", "."));
    if (buy > 0 && !got[cells[i]]) got[cells[i]] = buy;
  }
  for (const [code, v] of Object.entries(got)) db.prepare("UPDATE rates SET value=?, updated_at=?, source='mig' WHERE code=? AND manual=0").run(v, Date.now(), code);
  return Object.keys(got);
}

async function refreshAll() {
  let mig = [];
  if ((process.env.RATES_SOURCE || "mig") === "mig") {
    try { mig = await refreshMig(); console.log("[rates] mig.kz:", mig.join(", ") || "ничего"); } catch (e) { console.warn("[rates] mig.kz:", e.message); }
  }
  await refresh(mig); // остальные валюты — по Нацбанку
}

// раз в день: в RATES_HOUR (по Алматы, по умолчанию 10:00) или при запуске, если сегодня ещё не обновляли
const almatyNow = () => new Date(Date.now() + 5 * 3600e3);
const today = () => almatyNow().toISOString().slice(0, 10);
function startAutoRefresh() {
  const hour = parseInt(process.env.RATES_HOUR || "10", 10);
  const last = db.prepare("SELECT MAX(updated_at) t FROM rates WHERE manual=0").get().t || 0;
  let done = last ? new Date(last + 5 * 3600e3).toISOString().slice(0, 10) : "";
  const tick = () => {
    if (done !== today() && (almatyNow().getUTCHours() >= hour || !done)) { done = today(); refreshAll(); }
  };
  tick();
  setInterval(tick, 10 * 60e3).unref();
}

module.exports = { COUNTRIES, BY_CODE, rate, allRates, setManual, convert, countryByPhone, refresh: refreshAll, startAutoRefresh };
