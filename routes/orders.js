// routes/orders.js — заказ из Mini App. Цены пересчитываются на сервере
// по базе, сумме из браузера мы не доверяем.
const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const products = require("../products");
const { notifyNewOrder } = require("../bot");

const router = express.Router();

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
    items.push({ id: r.id, name: r.name, size, qty, pack: r.pack_qty, price: r.price_per_unit });
  }
  const total = items.reduce((s, i) => s + i.price * i.pack * i.qty, 0);
  const user = tgUser(b.initData);
  const id = String(Date.now()).slice(-6);
  const row = {
    id, country, name, phone, city, comment, items: JSON.stringify(items), total_kzt: total, status: "pending",
    tg_user_id: user ? user.id : null, tg_username: user && user.username ? user.username : null, created_at: Date.now()
  };
  db.prepare(`INSERT INTO orders (id,country,name,phone,city,comment,items,total_kzt,status,tg_user_id,tg_username,created_at)
    VALUES (@id,@country,@name,@phone,@city,@comment,@items,@total_kzt,@status,@tg_user_id,@tg_username,@created_at)`).run(row);
  notifyNewOrder(row);
  res.json({ id, total, items });
});

module.exports = router;
