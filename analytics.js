// analytics.js — что смотрят, кладут в корзину, заказывают и что ищут, но не находят
const db = require("./db");
const products = require("./products");

db.exec(`CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, uid TEXT, kind TEXT NOT NULL, pid TEXT, q TEXT, n INTEGER);
  CREATE INDEX IF NOT EXISTS events_ts ON events(ts);`);
db.prepare("DELETE FROM events WHERE ts < ?").run(Date.now() - 120 * 86400e3);

const KINDS = new Set(["open", "view", "cart", "search", "ai", "share", "repeat"]);
const ins = db.prepare("INSERT INTO events (ts, uid, kind, pid, q, n) VALUES (?,?,?,?,?,?)");
const clean = (s, n) => (s == null ? null : String(s).replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n) || null);

function log(kind, { uid = null, pid = null, q = null, n = null } = {}) {
  if (!KINDS.has(kind)) return;
  ins.run(Date.now(), uid ? String(uid) : null, kind, clean(pid, 40), q == null ? null : (clean(q, 120) || "").toLowerCase().replace(/ё/g, "е") || null, Number.isFinite(+n) && n !== null ? Math.round(+n) : null);
}

const fmt = (n) => Math.round(n || 0).toLocaleString("ru-RU").replace(/ /g, " ");
const nameOf = (pid) => { const r = products.get(pid); return r ? r.name : "(удалён)"; };

function report(days = 7) {
  const since = Date.now() - days * 86400e3;
  const q = (sql, ...a) => db.prepare(sql).all(since, ...a);
  const visitors = db.prepare("SELECT COUNT(DISTINCT uid) n FROM events WHERE ts>=? AND uid IS NOT NULL").get(since).n;
  const opens = db.prepare("SELECT COUNT(*) n FROM events WHERE ts>=? AND kind='open'").get(since).n;
  const views = q("SELECT pid, COUNT(*) c, COUNT(DISTINCT uid) u FROM events WHERE ts>=? AND kind='view' AND pid IS NOT NULL GROUP BY pid ORDER BY c DESC LIMIT 7");
  const carts = q("SELECT pid, COUNT(*) c FROM events WHERE ts>=? AND kind='cart' AND pid IS NOT NULL GROUP BY pid ORDER BY c DESC");
  // заказано (по заказам, кроме отменённых)
  const ordered = {};
  let orderCount = 0, orderSum = 0;
  for (const o of db.prepare("SELECT items, total_kzt FROM orders WHERE created_at>=? AND status!='cancelled'").all(since)) {
    orderCount++; orderSum += o.total_kzt;
    for (const i of JSON.parse(o.items || "[]")) ordered[i.id] = (ordered[i.id] || 0) + i.qty;
  }
  const topOrdered = Object.entries(ordered).sort((a, b) => b[1] - a[1]).slice(0, 7);
  const dropped = carts.map((r) => ({ pid: r.pid, c: r.c, o: ordered[r.pid] || 0 })).filter((r) => r.c >= 2 && r.o === 0).slice(0, 5);
  const notFound = q(`SELECT q, COUNT(*) c FROM events WHERE ts>=? AND kind IN ('search','ai') AND n=0 AND q IS NOT NULL
    GROUP BY q ORDER BY c DESC LIMIT 10`);
  const topSearch = q(`SELECT q, COUNT(*) c FROM events WHERE ts>=? AND kind IN ('search','ai') AND q IS NOT NULL
    GROUP BY q ORDER BY c DESC LIMIT 8`);
  const shares = db.prepare("SELECT COUNT(*) n FROM events WHERE ts>=? AND kind='share'").get(since).n;
  const repeats = db.prepare("SELECT COUNT(*) n FROM events WHERE ts>=? AND kind='repeat'").get(since).n;

  const list = (rows, f) => rows.length ? rows.map((r, i) => `${i + 1}. ${f(r)}`).join("\n") : "— пока нет данных";
  return [
    `📊 Аналитика каталога за ${days} дн.`,
    `👥 Открывали каталог: ${opens} раз, ${visitors} чел.\n🛍 Заказов: ${orderCount} на ${fmt(orderSum)} ₸\n📤 Поделились товаром: ${shares} · 🔁 Повторили заказ: ${repeats}`,
    `👀 Смотрят чаще всего:\n${list(views, (r) => `${nameOf(r.pid)} — ${r.c} просм.${r.u ? ` (${r.u} чел.)` : ""}`)}`,
    `🛒 Кладут в корзину:\n${list(carts.slice(0, 7), (r) => `${nameOf(r.pid)} — ${r.c} раз`)}`,
    `✅ Заказывают:\n${list(topOrdered, ([pid, n]) => `${nameOf(pid)} — ${n} уп.`)}`,
    `⚠️ Кладут в корзину, но не заказывают:\n${list(dropped, (r) => `${nameOf(r.pid)} — ${r.c} раз в корзине`)}`,
    `🔎 Ищут, но НЕ находят (что закупить):\n${list(notFound, (r) => `«${r.q}» — ${r.c} раз`)}`,
    `💬 Популярные запросы:\n${list(topSearch, (r) => `«${r.q}» — ${r.c}`)}`
  ].join("\n\n");
}

module.exports = { log, report };
