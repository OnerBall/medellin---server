const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../auth");
const { notifyNewOrder } = require("../bot");

const router = express.Router();

function rowToOrder(row) {
  return {
    id: row.id,
    country: row.country,
    name: row.name,
    phone: row.phone,
    city: row.city,
    items: JSON.parse(row.items),
    totalKzt: row.total_kzt,
    totalConverted: row.total_converted,
    rateUsed: row.rate_used,
    paymentMethod: row.payment_method,
    receiptPhoto: row.receipt_photo,
    status: row.status,
    createdAt: row.created_at
  };
}

// ---- клиент создаёт заказ ----
router.post("/orders", async (req, res) => {
  const b = req.body || {};
  if (!Array.isArray(b.items) || b.items.length === 0) {
    return res.status(400).json({ error: "корзина пуста" });
  }
  if (!(b.totalKzt > 0)) {
    return res.status(400).json({ error: "totalKzt обязателен" });
  }

  const id = String(Date.now()).slice(-6);
  const row = {
    id,
    country: b.country || "KZ",
    name: b.name || "",
    phone: b.phone || "",
    city: b.city || "",
    items: JSON.stringify(b.items),
    total_kzt: Math.round(b.totalKzt),
    total_converted: b.totalConverted || null,
    rate_used: b.rateUsed || null,
    payment_method: b.paymentMethod || "",
    receipt_photo: b.receiptPhoto || null,
    status: "pending",
    created_at: Date.now()
  };

  db.prepare(`
    INSERT INTO orders (id, country, name, phone, city, items, total_kzt, total_converted, rate_used, payment_method, receipt_photo, status, created_at)
    VALUES (@id, @country, @name, @phone, @city, @items, @total_kzt, @total_converted, @rate_used, @payment_method, @receipt_photo, @status, @created_at)
  `).run(row);

  notifyNewOrder(row); // не блокируем ответ клиенту ожиданием Telegram

  res.json(rowToOrder(row));
});

// ---- админ смотрит заказы ----
router.get("/admin/orders", requireAdmin, (req, res) => {
  const rows = db.prepare("SELECT * FROM orders ORDER BY created_at DESC").all();
  res.json(rows.map(rowToOrder));
});

router.put("/admin/orders/:id/status", requireAdmin, async (req, res) => {
  const status = req.body && req.body.status;
  if (!["pending", "paid", "unpaid", "shipped"].includes(status)) {
    return res.status(400).json({ error: "недопустимый статус" });
  }
  db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, req.params.id);
  const row = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
  if (!row) return res.status(404).json({ error: "not found" });

  const { updateOrderMessage } = require("../bot");
  updateOrderMessage(row);

  res.json(rowToOrder(row));
});

module.exports = router;
