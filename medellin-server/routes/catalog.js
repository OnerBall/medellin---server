const express = require("express");
const db = require("../db");
const { requireAdmin } = require("../auth");

const router = express.Router();

function rowToProduct(row) {
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    description: row.description,
    pricePerUnit: row.price_per_unit,
    packQty: row.pack_qty,
    sizes: JSON.parse(row.sizes || "[]"),
    colors: JSON.parse(row.colors || "[]"),
    sku: row.sku,
    inStock: !!row.in_stock,
    hidden: !!row.hidden,
    photos: JSON.parse(row.photos || "[]"),
    createdAt: row.created_at
  };
}

// ---- PRODUCTS ----
// Отдаём весь список (включая скрытые) — клиентский каталог сам
// фильтрует hidden при отрисовке, это совпадает с тем, как уже
// устроен фронтенд. Мутации защищены requireAdmin.
router.get("/products", (req, res) => {
  const rows = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all();
  res.json(rows.map(rowToProduct));
});

router.post("/admin/products", requireAdmin, (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.category || !(b.pricePerUnit > 0) || !(b.packQty > 0)) {
    return res.status(400).json({ error: "name, category, pricePerUnit, packQty обязательны" });
  }
  const id = "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  db.prepare(`
    INSERT INTO products (id, name, category, description, price_per_unit, pack_qty, sizes, colors, sku, in_stock, hidden, photos, created_at)
    VALUES (@id, @name, @category, @description, @price_per_unit, @pack_qty, @sizes, @colors, @sku, @in_stock, @hidden, @photos, @created_at)
  `).run({
    id,
    name: b.name,
    category: b.category,
    description: b.description || "",
    price_per_unit: Math.round(b.pricePerUnit),
    pack_qty: Math.round(b.packQty),
    sizes: JSON.stringify(b.sizes || []),
    colors: JSON.stringify(b.colors || []),
    sku: b.sku || "",
    in_stock: b.inStock ? 1 : 0,
    hidden: 0,
    photos: JSON.stringify(b.photos || []),
    created_at: Date.now()
  });
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(id);
  res.json(rowToProduct(row));
});

router.put("/admin/products/:id", requireAdmin, (req, res) => {
  const existing = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  if (!existing) return res.status(404).json({ error: "not found" });
  const b = req.body || {};
  const merged = {
    name: b.name ?? existing.name,
    category: b.category ?? existing.category,
    description: b.description ?? existing.description,
    price_per_unit: b.pricePerUnit != null ? Math.round(b.pricePerUnit) : existing.price_per_unit,
    pack_qty: b.packQty != null ? Math.round(b.packQty) : existing.pack_qty,
    sizes: b.sizes != null ? JSON.stringify(b.sizes) : existing.sizes,
    colors: b.colors != null ? JSON.stringify(b.colors) : existing.colors,
    sku: b.sku ?? existing.sku,
    in_stock: b.inStock != null ? (b.inStock ? 1 : 0) : existing.in_stock,
    hidden: b.hidden != null ? (b.hidden ? 1 : 0) : existing.hidden,
    photos: b.photos != null ? JSON.stringify(b.photos) : existing.photos,
    id: req.params.id
  };
  db.prepare(`
    UPDATE products SET name=@name, category=@category, description=@description,
      price_per_unit=@price_per_unit, pack_qty=@pack_qty, sizes=@sizes, colors=@colors,
      sku=@sku, in_stock=@in_stock, hidden=@hidden, photos=@photos WHERE id=@id
  `).run(merged);
  const row = db.prepare("SELECT * FROM products WHERE id = ?").get(req.params.id);
  res.json(rowToProduct(row));
});

router.delete("/admin/products/:id", requireAdmin, (req, res) => {
  db.prepare("DELETE FROM products WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

// ---- CATEGORIES ----
router.get("/categories", (req, res) => {
  const rows = db.prepare("SELECT name FROM categories ORDER BY id ASC").all();
  res.json(rows.map((r) => r.name));
});

router.post("/admin/categories", requireAdmin, (req, res) => {
  const name = (req.body && req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "name обязателен" });
  try {
    db.prepare("INSERT INTO categories (name) VALUES (?)").run(name);
  } catch (e) {
    // уже существует — не ошибка, просто вернём текущий список
  }
  const rows = db.prepare("SELECT name FROM categories ORDER BY id ASC").all();
  res.json(rows.map((r) => r.name));
});

// ---- RATES ----
router.get("/rates", (req, res) => {
  const rows = db.prepare("SELECT code, value FROM rates").all();
  const out = {};
  rows.forEach((r) => (out[r.code] = r.value));
  res.json(out);
});

router.put("/admin/rates", requireAdmin, (req, res) => {
  const b = req.body || {};
  const upsert = db.prepare(`
    INSERT INTO rates (code, value, updated_at) VALUES (@code, @value, @updated_at)
    ON CONFLICT(code) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `);
  const tx = db.transaction((rates) => {
    Object.entries(rates).forEach(([code, value]) => {
      if (typeof value === "number" && value > 0) {
        upsert.run({ code, value, updated_at: Date.now() });
      }
    });
  });
  tx(b);
  const rows = db.prepare("SELECT code, value FROM rates").all();
  const out = {};
  rows.forEach((r) => (out[r.code] = r.value));
  res.json(out);
});

module.exports = router;
