// digest.js — «Новинки недели»: раз в неделю бот собирает новые товары,
// присылает админу превью, по кнопке «Отправить всем» рассылает подписчикам в личку.
const { Markup } = require("telegraf");
const db = require("./db");
const products = require("./products");

db.exec(`CREATE TABLE IF NOT EXISTS subscribers (
  tg_id INTEGER PRIMARY KEY, first_name TEXT, username TEXT,
  started_at INTEGER, last_seen INTEGER, unsub INTEGER NOT NULL DEFAULT 0, blocked INTEGER NOT NULL DEFAULT 0)`);
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
// все, кто уже заказывал, — тоже подписчики
db.prepare(`INSERT OR IGNORE INTO subscribers (tg_id, username, started_at, last_seen)
  SELECT tg_user_id, MAX(tg_username), MIN(created_at), MAX(created_at) FROM orders WHERE tg_user_id IS NOT NULL GROUP BY tg_user_id`).run();
const getSetting = (k) => (db.prepare("SELECT value FROM settings WHERE key=?").get(k) || {}).value || "";
const setSetting = (k, v) => db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);

const DAY = (process.env.DIGEST_DAY || "5").trim();           // 0=вс … 5=пт, off — выключить авто
const HOUR = parseInt(process.env.DIGEST_HOUR || "12", 10);    // по Алматы
const almaty = () => new Date(Date.now() + 5 * 3600e3);
const fmt = (n) => Math.round(n || 0).toLocaleString("ru-RU").replace(/ /g, " ");

let bot = null, ADMIN_IDS = [], WEBAPP_URL = "", isAdmin = () => false;

// ---------- подписчики ----------
function track(u, wasBlocked = false) {
  if (!u || !u.id || u.is_bot || isAdmin(u.id)) return;
  const now = Date.now();
  db.prepare(`INSERT INTO subscribers (tg_id, first_name, username, started_at, last_seen) VALUES (?,?,?,?,?)
    ON CONFLICT(tg_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, last_seen=excluded.last_seen
    ${wasBlocked ? "" : ", blocked=0"}`).run(u.id, u.first_name || "", u.username || "", now, now);
}
const audience = () => db.prepare("SELECT tg_id FROM subscribers WHERE unsub=0 AND blocked=0").all().map((r) => r.tg_id);
const counts = () => db.prepare("SELECT COUNT(*) total, SUM(unsub=0 AND blocked=0) active, SUM(unsub=1) unsub, SUM(blocked=1) blocked FROM subscribers").get();

// ---------- сборка выпуска ----------
function build(days = 7) {
  const since = Date.now() - days * 86400e3;
  const items = products.listPublic().filter((p) => p.inStock && p.createdAt >= since);
  const album = [];
  for (const p of items) {
    const r = products.get(p.id); const ph = r && JSON.parse(r.photos || "[]")[0];
    if (ph && album.length < 8) album.push({ type: "photo", media: ph });
  }
  const lines = items.slice(0, 8).map((p) => `• ${p.name} — ${fmt(p.price)} ₸/${p.unit.label}`);
  const text = `🆕 Новинки недели в Medellin\n\n${lines.join("\n")}` +
    (items.length > 8 ? `\n…и ещё ${items.length - 8}` : "") +
    `\n\nНовых моделей: ${items.length}. Смотрите в каталоге 👇`;
  return { items, album, text };
}
const clientKb = () => Markup.inlineKeyboard([
  ...(WEBAPP_URL ? [[Markup.button.webApp("🛍 Смотреть новинки", WEBAPP_URL)]] : []),
  [Markup.button.callback("🔕 Не присылать новинки", "unsub")]
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function sendIssue(chatId, issue, kb) {
  if (issue.album.length > 1) await bot.telegram.sendMediaGroup(chatId, issue.album);
  else if (issue.album.length === 1) await bot.telegram.sendPhoto(chatId, issue.album[0].media);
  await bot.telegram.sendMessage(chatId, issue.text, kb);
}

// превью админу
async function preview(chatIds, { auto = false } = {}) {
  const issue = build();
  const key = almaty().toISOString().slice(0, 10);
  for (const a of chatIds) {
    if (!issue.items.length) {
      if (!auto) await bot.telegram.sendMessage(a, "За последние 7 дней новых товаров нет — рассылать нечего.").catch(() => {});
      continue;
    }
    const c = counts();
    try {
      await sendIssue(a, issue);
      await bot.telegram.sendMessage(a, `👆 Так увидят клиенты.\nПолучателей: ${c.active || 0} (отписались: ${c.unsub || 0}, заблокировали бота: ${c.blocked || 0})`,
        Markup.inlineKeyboard([[Markup.button.callback(`✅ Отправить всем (${c.active || 0})`, `dg:send:${key}`), Markup.button.callback("⏭ Пропустить", `dg:skip:${key}`)]]));
    } catch (e) { console.warn("[digest] превью:", e.message); }
  }
}

let sending = false;
async function broadcast(ctx, key) {
  if (sending) return ctx.answerCbQuery("Рассылка уже идёт");
  if (getSetting("digest_sent") === key) return ctx.answerCbQuery("Этот выпуск уже отправлен", { show_alert: true });
  const issue = build();
  if (!issue.items.length) return ctx.answerCbQuery("Новинок нет");
  setSetting("digest_sent", key); sending = true;
  await ctx.answerCbQuery("Отправляю…");
  await ctx.editMessageText("⏳ Рассылка идёт…").catch(() => {});
  let ok = 0, fail = 0;
  for (const id of audience()) {
    try { await sendIssue(id, issue, clientKb()); ok++; }
    catch (e) {
      fail++;
      const code = e.response && e.response.error_code;
      if (code === 403 || code === 400) db.prepare("UPDATE subscribers SET blocked=1 WHERE tg_id=?").run(id);
      if (code === 429) await sleep(((e.response.parameters && e.response.parameters.retry_after) || 5) * 1000);
    }
    await sleep(120);
  }
  sending = false;
  await ctx.editMessageText(`✅ Новинки разосланы: ${ok}\n${fail ? `Не доставлено: ${fail} (не запускали бота или заблокировали)` : ""}`).catch(() => {});
}

// ---------- обработчики ----------
async function onCallback(ctx, act, a, b) {
  if (act === "unsub") {
    db.prepare("UPDATE subscribers SET unsub=1 WHERE tg_id=?").run(ctx.from.id);
    await ctx.answerCbQuery("Больше не пришлём");
    await ctx.reply("🔕 Готово, новинки больше не придут.\nВернуть рассылку — /news").catch(() => {});
    return true;
  }
  if (act !== "dg") return false;
  if (!isAdmin(ctx.from.id)) { await ctx.answerCbQuery("Только для администратора"); return true; }
  if (a === "skip") { setSetting("digest_sent", b); await ctx.editMessageText("⏭ Выпуск пропущен.").catch(() => {}); await ctx.answerCbQuery(); return true; }
  if (a === "send") { await broadcast(ctx, b); return true; }
  return false;
}

function init(deps) {
  ({ bot, ADMIN_IDS, WEBAPP_URL, isAdmin } = deps);
  // каждый, кто пишет боту или жмёт кнопки, — подписчик
  bot.use((ctx, next) => { if (ctx.chat && ctx.chat.type === "private" && ctx.from) track(ctx.from); return next(); });
  bot.command("news", async (ctx) => {
    track(ctx.from);
    db.prepare("UPDATE subscribers SET unsub=0 WHERE tg_id=?").run(ctx.from.id);
    await ctx.reply("🔔 Подписка на новинки включена — раз в неделю пришлём новые модели 🤍");
  });
  // авто-превью раз в неделю
  if (DAY !== "off") {
    const tick = () => {
      const d = almaty(), key = d.toISOString().slice(0, 10);
      if (String(d.getUTCDay()) === DAY && d.getUTCHours() >= HOUR && getSetting("digest_preview") !== key) {
        setSetting("digest_preview", key);
        preview(ADMIN_IDS, { auto: true });
      }
    };
    setTimeout(tick, 30e3).unref();
    setInterval(tick, 10 * 60e3).unref();
  }
}

module.exports = { init, track, preview, onCallback, counts };
