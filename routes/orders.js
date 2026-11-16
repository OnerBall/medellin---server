// routes/orders.js — заказ из Mini App. Цены пересчитываются на сервере
// по базе, сумме из браузера мы не доверяем.
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const products = require("../products");
const { notifyNewOrder, cancelByClient, CANCELLABLE, STATUS_LABELS } = require("../bot");
const rates = require("../rates");
const { unitOf, plural } = require("../units");

const router = express.Router();
const MIN_ORDER = parseInt(process.env.MIN_ORDER || "50000", 10);

// Проверка подписи Telegram initData — так мы знаем, кто оформил заказ
function tgUser(initData) {
  const token = process.env.BOT_TOKEN;
  if (!initData || !token) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    params.delete("hash");
    const check = [...params.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join("\n");
    const secret = crypto.createHmac("sha256", "WebAppData").update(token).digest();
    const h = crypto.createHmac("sha256", secret).update(check).digest("hex");
    if (!hash || h.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash))) return null;
    return JSON.parse(params.get("user") || "null");
  } catch (e) {
    return null;
  }
}

const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, n);

router.post("/api/orders", async (req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 60), phone = clean(b.phone, 30), city = clean(b.city, 60), country = clean(b.country, 40), comment = clean(b.comment, 300);
  if (!name) return res.status(400).json({ error: "Укажите имя" });
  if (phone.replace(/\D/g, "").length < 10) return res.status(400).json({ error: "Укажите телефон" });
  if (!city) return res.status(400).json({ error: "Укажите город" });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 50) return res.status(400).json({ error: "Корзина пуста" });

  const items = [];
  for (const it of b.items) {
    const r = products.get(String(it.id || ""));
    const qty = Math.min(999, Math.max(1, parseInt(it.qty, 10) || 0));
    if (!r || !products.isPublic(r)) return res.status(409).json({ error: "Какой-то товар закончился или убран из каталога. Обновите корзину." });
    if (!r.in_stock) return res.status(409).json({ error: `«${r.name}» сейчас нет в наличии` });
    const sizes = JSON.parse(r.sizes || "[]");
    const size = sizes.includes(it.size) ? it.size : "";
    items.push({ id: r.id, name: r.name, size, qty, pack: r.pack_qty, price: products.effPrice(r), unit: r.unit || "pcs" });
  }
  const total = items.reduce((s, i) => s + i.price * i.pack * i.qty, 0);
  if (total < MIN_ORDER) return res.status(400).json({ error: `Минимальная сумма заказа — ${MIN_ORDER.toLocaleString("ru-RU").replace(/\u00a0/g, " ")} ₸` });
  const user = tgUser(b.initData);
  const buyer = rates.BY_CODE[b.buyerCountry] ? b.buyerCountry : rates.countryByPhone(phone) || "KZ";
  const cur = rates.BY_CODE[buyer].cur;
  const id = String(Date.now()).slice(-6);
  const row = {
    id, country, name, phone, city, comment, items: JSON.stringify(items), total_kzt: total, status: "pending",
    tg_user_id: user ? user.id : null, tg_username: user && user.username ? user.username : null, created_at: Date.now(),
    token: crypto.randomBytes(6).toString("hex"),
    buyer_country: buyer, shown_total: rates.convert(total, buyer), rate_used: cur === "KZT" ? null : rates.rate(cur)
  };
  db.prepare(`INSERT INTO orders (id,country,name,phone,city,comment,items,total_kzt,status,tg_user_id,tg_username,created_at,buyer_country,shown_total,rate_used)
    VALUES (@id,@country,@name,@phone,@city,@comment,@items,@total_kzt,@status,@tg_user_id,@tg_username,@created_at,@buyer_country,@shown_total,@rate_used)`).run(row);
  db.prepare("UPDATE orders SET token=? WHERE id=?").run(row.token, id);
  notifyNewOrder(row);
  const base = baseUrl(req);
  const link = `${base}/o/${id}-${row.token}`;
  const fmt = (n) => Math.round(n).toLocaleString("ru-RU").replace(/\u00a0/g, " ");
  const bc = rates.BY_CODE[buyer];
  const waText = `Здравствуйте! Заказ №${id} из каталога Medellin\n\n` +
    items.map((i, k) => `${k + 1}. ${i.name}${i.size ? ` (${i.size})` : ""} × ${i.qty} уп. — ${fmt(i.price * i.pack * i.qty)} ₸`).join("\n") +
    `\n\nИтого: ${fmt(total)} ₸` + (row.shown_total && bc ? ` (≈ ${fmt(row.shown_total)} ${bc.sym})` : "") +
    `\n👤 ${name}, ${city}\n📞 ${phone}\n\n📷 Заказ с фото: ${link}`;
  res.json({ id, total, items, link, waText });
});

const baseUrl = (req) => process.env.WEBAPP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : `${req.protocol}://${req.get("host")}`);
const h = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// страница заказа с фото — для WhatsApp (по секретной ссылке /o/<id>-<token>)
router.get("/o/:key", (req, res) => {
  const [id, token] = String(req.params.key).split("-");
  const o = db.prepare("SELECT * FROM orders WHERE id=?").get(id || "");
  if (!o || !o.token || o.token !== token) return res.status(404).send("Заказ не найден");
  const base = baseUrl(req);
  const fmt = (n) => Math.round(n).toLocaleString("ru-RU").replace(/\u00a0/g, " ");
  const items = JSON.parse(o.items).map((i) => { const r = products.get(i.id); const ph = r && JSON.parse(r.photos || "[]").length ? `/photo/${r.id}/0` : ""; return { ...i, ph }; });
  const og = items.find((i) => i.ph);
  res.set("Cache-Control", "no-store").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Заказ №${h(o.id)} — Medellin</title>
<meta property="og:title" content="Заказ №${h(o.id)} — ${fmt(o.total_kzt)} ₸"><meta property="og:description" content="${items.length} поз. · ${h(o.name)}, ${h(o.city)}">
${og ? `<meta property="og:image" content="${base}${og.ph}">` : ""}<meta name="robots" content="noindex">
<style>body{margin:0;background:#160507;color:#F5EBDD;font-family:-apple-system,system-ui,sans-serif}.w{max-width:560px;margin:0 auto;padding:18px}
h1{font-family:Georgia,serif;font-size:26px;margin:6px 0 4px}.m{color:#C9B8A6;font-size:14px;margin-bottom:16px}
.i{display:flex;gap:12px;align-items:center;padding:10px;margin-bottom:10px;border-radius:18px;background:rgba(245,235,221,.06);box-shadow:inset 0 0 0 1px rgba(245,235,221,.1)}
.i img{width:96px;height:120px;object-fit:cover;border-radius:12px;background:#2A0A0F;flex:none}.i b{display:block;font-weight:600}.i small{color:#C9B8A6}.i .p{color:#D9B26F;font-weight:700;margin-top:4px}
.t{margin-top:16px;padding:16px;border-radius:18px;background:linear-gradient(135deg,rgba(217,178,111,.18),rgba(90,15,26,.3));box-shadow:inset 0 0 0 1px rgba(217,178,111,.45);font-size:24px;font-weight:700;color:#D9B26F}</style></head>
<body><div class="w"><h1>Заказ №${h(o.id)}</h1><div class="m">${new Date(o.created_at + 5 * 3600e3).toISOString().slice(0, 16).replace("T", " ")} · ${h(o.name)} · ${h(o.city)} · ${h(o.phone)}</div>
${items.map((i, k) => `<div class="i">${i.ph ? `<img src="${i.ph}" alt="">` : ""}<div><b>${k + 1}. ${h(i.name)}</b><small>${i.size ? h(i.size) + " · " : ""}${i.qty} уп. × ${i.pack} ${plural(i.pack, unitOf(i.unit).forms)}</small><div class="p">${fmt(i.price * i.pack * i.qty)} ₸</div></div></div>`).join("")}
<div class="t">Итого: ${fmt(o.total_kzt)} ₸</div></div></body></html>`);
});

// страница «поделиться товаром»: красивое превью в WhatsApp/Telegram и переход в каталог
let botName = (process.env.BOT_USERNAME || "").replace("@", "");
async function getBotName() {
  if (botName) return botName;
  try { const { bot } = require("../bot"); if (bot) botName = (await bot.telegram.getMe()).username; } catch (e) {}
  return botName;
}
router.get("/p/:id", async (req, res) => {
  const r = products.get(String(req.params.id));
  const name = await getBotName();
  const go = name ? `https://t.me/${name}?startapp=${encodeURIComponent(req.params.id)}` : "/";
  if (!r || !products.isPublic(r)) return res.redirect(go);
  const base = baseUrl(req), fmt = (n) => Math.round(n).toLocaleString("ru-RU").replace(/\u00a0/g, " ");
  const u = unitOf(r.unit);
  const desc = `${products.onSale(r) ? `🔥 ${fmt(r.sale_price)} ₸ вместо ${fmt(r.price_per_unit)} ₸` : `${fmt(r.price_per_unit)} ₸`} ${u.per} · упаковка ${r.pack_qty} ${plural(r.pack_qty, u.forms)} · опт Medellin`;
  res.set("Cache-Control", "public, max-age=600").send(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${h(r.name)} — Medellin</title><meta property="og:title" content="${h(r.name)}"><meta property="og:description" content="${h(desc)}">
${JSON.parse(r.photos || "[]").length ? `<meta property="og:image" content="${base}/photo/${h(r.id)}/0">` : ""}<meta property="og:type" content="product">
<meta http-equiv="refresh" content="0;url=${h(go)}"></head>
<body style="background:#160507;color:#F5EBDD;font-family:system-ui;text-align:center;padding:40px">
<p>${h(r.name)}<br>${h(desc)}</p><p><a style="color:#D9B26F" href="${h(go)}">Открыть в каталоге Medellin</a></p></body></html>`);
});

// мои заказы (по подписи Telegram) и отмена неоплаченного
router.post("/api/my-orders", (req, res) => {
  const user = tgUser((req.body || {}).initData);
  if (!user) return res.json({ items: [] });
  const rows = db.prepare("SELECT * FROM orders WHERE tg_user_id=? ORDER BY created_at DESC LIMIT 20").all(user.id);
  res.json({ items: rows.map((o) => ({ id: o.id, total: o.total_kzt, date: o.created_at, status: o.status,
    statusText: (STATUS_LABELS[o.status] || o.status).replace(/^\S+\s/, ""), count: JSON.parse(o.items).length, canCancel: CANCELLABLE.includes(o.status),
    items: JSON.parse(o.items).map((i) => ({ id: i.id, size: i.size || "", qty: i.qty })) })) });
});

router.post("/api/orders/cancel", (req, res) => {
  const b = req.body || {};
  const user = tgUser(b.initData);
  const o = user && db.prepare("SELECT * FROM orders WHERE id=? AND tg_user_id=?").get(String(b.id || ""), user.id);
  if (!o) return res.status(404).json({ error: "Заказ не найден" });
  if (o.status === "cancelled") return res.status(409).json({ error: "Заказ уже отменён" });
  if (!CANCELLABLE.includes(o.status)) return res.status(409).json({ error: "Заказ уже оплачен или отправлен — напишите нам в WhatsApp" });
  cancelByClient(o);
  res.json({ ok: true });
});

router.tgUser = tgUser;
module.exports = router;
