// db.js — SQLite. Файл базы лежит в DB_PATH (на Railway — внутри Volume,
// например /data/medellin.db), тогда данные переживают редеплои.
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

// DB_PATH → иначе на диск Railway (Volume) → иначе ./data рядом с кодом (локально)
const VOL = (process.env.RAILWAY_VOLUME_MOUNT_PATH || "").trim();
const DB_PATH = (process.env.DB_PATH || "").trim() || (VOL ? path.join(VOL, "medellin.db") : path.join(__dirname, "data", "medellin.db"));
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT,
    description TEXT DEFAULT '',
    price_per_unit INTEGER,
    pack_qty INTEGER NOT NULL DEFAULT 12,
    sizes TEXT DEFAULT '[]',
    colors TEXT DEFAULT '[]',
    country TEXT DEFAULT '',
    in_stock INTEGER NOT NULL DEFAULT 1,
    hidden INTEGER NOT NULL DEFAULT 0,
    photos TEXT DEFAULT '[]',
    source TEXT,
    media_group_id TEXT,
    caption TEXT DEFAULT '',
    admin_msg_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    country TEXT,
    name TEXT,
    phone TEXT,
    city TEXT,
    comment TEXT DEFAULT '',
    items TEXT NOT NULL,
    total_kzt INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    tg_user_id INTEGER,
    tg_username TEXT,
    created_at INTEGER NOT NULL,
    telegram_chat_id INTEGER,
    telegram_message_id INTEGER
  );
`);

// миграции со старой схемы (сентябрьская версия): добавляем недостающие колонки
function addColumn(table, col, def) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
for (const [c, d] of [["country", "TEXT DEFAULT ''"], ["source", "TEXT"], ["media_group_id", "TEXT"], ["caption", "TEXT DEFAULT ''"],
  ["admin_msg_id", "INTEGER"], ["updated_at", "INTEGER"], ["unit", "TEXT"], ["media", "TEXT"], ["sale_price", "INTEGER"]]) addColumn("products", c, d);
for (const [c, d] of [["comment", "TEXT DEFAULT ''"], ["tg_user_id", "INTEGER"], ["tg_username", "TEXT"], ["buyer_country", "TEXT"], ["shown_total", "INTEGER"], ["rate_used", "REAL"], ["token", "TEXT"]]) addColumn("orders", c, d);

db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS products_source ON products(source) WHERE source IS NOT NULL;
  CREATE INDEX IF NOT EXISTS products_group ON products(media_group_id);
`);

db.DB_PATH = DB_PATH;
module.exports = db;
