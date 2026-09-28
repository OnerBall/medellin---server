// db.js — единственное место, которое знает про SQLite.
// Файл базы лежит в DB_PATH (по умолчанию ./data/medellin.db).
// На Railway подключите Volume и укажите DB_PATH внутри него —
// тогда данные переживают редеплои.

const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data", "medellin.db");
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT UNIQUE NOT NULL
  );

  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    description TEXT DEFAULT '',
    price_per_unit INTEGER NOT NULL,
    pack_qty INTEGER NOT NULL,
    sizes TEXT DEFAULT '[]',
    colors TEXT DEFAULT '[]',
    sku TEXT DEFAULT '',
    in_stock INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0,
    photos TEXT DEFAULT '[]',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS rates (
    code TEXT PRIMARY KEY,
    value REAL NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    country TEXT,
    name TEXT,
    phone TEXT,
    city TEXT,
    items TEXT NOT NULL,
    total_kzt INTEGER NOT NULL,
    total_converted REAL,
    rate_used REAL,
    payment_method TEXT,
    receipt_photo TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    telegram_chat_id INTEGER,
    telegram_message_id INTEGER
  );
`);

// ---- сиды по умолчанию, только если таблицы пустые ----
const seedCategories = ["Мужское", "Женское", "Детское", "Пижамы", "Домашние костюмы"];
const catCount = db.prepare("SELECT COUNT(*) AS n FROM categories").get().n;
if (catCount === 0) {
  const insertCat = db.prepare("INSERT INTO categories (name) VALUES (?)");
  const tx = db.transaction((cats) => cats.forEach((c) => insertCat.run(c)));
  tx(seedCategories);
}

const rateDefaults = { KGS: 5.30, UZS: 0.0346, TJS: 41.80, RUB: 5.00 };
const rateCount = db.prepare("SELECT COUNT(*) AS n FROM rates").get().n;
if (rateCount === 0) {
  const insertRate = db.prepare("INSERT INTO rates (code, value, updated_at) VALUES (?, ?, ?)");
  const tx = db.transaction((rates) => {
    Object.entries(rates).forEach(([code, value]) => insertRate.run(code, value, Date.now()));
  });
  tx(rateDefaults);
}

const prodCount = db.prepare("SELECT COUNT(*) AS n FROM products").get().n;
if (prodCount === 0) {
  const insertProduct = db.prepare(`
    INSERT INTO products (id, name, category, description, price_per_unit, pack_qty, sizes, colors, sku, in_stock, hidden, photos, created_at)
    VALUES (@id, @name, @category, @description, @price_per_unit, @pack_qty, @sizes, @colors, @sku, @in_stock, @hidden, @photos, @created_at)
  `);
  const seedProducts = [
    {
      id: "p_boxers_black", name: "Мужские боксеры, чёрные", category: "Мужское",
      description: "Приятный к телу дышащий трикотаж. В упаковке 10 шт разных размеров, один цвет.",
      price_per_unit: 960, pack_qty: 10,
      sizes: JSON.stringify(["M", "L", "XL", "XXL", "3XL"]), colors: JSON.stringify(["чёрный"]),
      sku: "MED-M-BLK-10", in_stock: 1, hidden: 0, photos: "[]", created_at: Date.now()
    },
    {
      id: "p_women_lace", name: "Женские трусы, кружево", category: "Женское",
      description: "Мягкий хлопок с кружевной отделкой по краю.",
      price_per_unit: 1500, pack_qty: 6,
      sizes: JSON.stringify(["S", "M", "L"]), colors: JSON.stringify(["белый", "бежевый", "чёрный"]),
      sku: "MED-W-LACE-6", in_stock: 1, hidden: 0, photos: "[]", created_at: Date.now()
    },
    {
      id: "p_kids_cotton", name: "Детские трусы, хлопок", category: "Детское",
      description: "Дышащий хлопок для ежедневной носки, набор на неделю.",
      price_per_unit: 1000, pack_qty: 6,
      sizes: JSON.stringify(["4-5", "6-7", "8-9"]), colors: JSON.stringify(["розовый", "голубой"]),
      sku: "MED-K-COT-6", in_stock: 1, hidden: 0, photos: "[]", created_at: Date.now()
    }
  ];
  const tx = db.transaction((rows) => rows.forEach((r) => insertProduct.run(r)));
  tx(seedProducts);
}

module.exports = db;
