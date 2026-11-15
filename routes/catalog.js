// routes/catalog.js — каталог для Mini App + отдача фото товаров
const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const products = require("../products");
const { SECTIONS, CATEGORIES } = require("../categories");

const router = express.Router();
const PHOTO_DIR = process.env.PHOTO_DIR || path.join(path.dirname(db.DB_PATH), "photos");
fs.mkdirSync(PHOTO_DIR, { recursive: true });

router.get("/api/catalog", (req, res) => {
  const items = products.listPublic();
  const count = {};
  for (const p of items) count[p.category] = (count[p.category] || 0) + 1;
  res.set("Cache-Control", "no-cache");
  res.json({
    shop: {
      name: "Medellin",
      whatsapp: (process.env.WHATSAPP || "77022585183").replace(/\D/g, ""),
      channel: process.env.CHANNEL_URL || "",
      minPack: parseInt(process.env.PACK_DEFAULT || "12", 10)
    },
    sections: SECTIONS.map((s) => ({
      ...s,
      count: items.filter((p) => p.section === s.key).length,
      cover: (items.find((p) => p.section === s.key) || {}).photos?.[0] || null,
      categories: CATEGORIES.filter((c) => c.section === s.key).map((c) => ({ key: c.key, title: c.title, count: count[c.key] || 0 }))
    })),
    products: items
  });
});

// /photo/:id/:n — фото товара. Telegram хранит файл, мы скачиваем его
// один раз и дальше отдаём из кеша на диске.
const inflight = new Map();
router.get("/photo/:id/:n", async (req, res) => {
  const r = products.get(req.params.id);
  const n = parseInt(req.params.n, 10) || 0;
  const fileId = r && JSON.parse(r.photos || "[]")[n];
  if (!fileId) return res.status(404).end();
  const safe = fileId.replace(/[^A-Za-z0-9_-]/g, "").slice(-80);
  const file = path.join(PHOTO_DIR, safe + ".jpg");
  res.set("Cache-Control", "public, max-age=2592000, immutable");
  if (fs.existsSync(file)) return res.sendFile(file);
  const { bot } = require("../bot");
  if (!bot) return res.status(404).end();
  try {
    if (!inflight.has(file)) {
      inflight.set(file, (async () => {
        const link = await bot.telegram.getFileLink(fileId);
        const resp = await fetch(link.href);
        if (!resp.ok) throw new Error("telegram " + resp.status);
        const buf = Buffer.from(await resp.arrayBuffer());
        fs.writeFileSync(file + ".tmp", buf);
        fs.renameSync(file + ".tmp", file);
      })().finally(() => setTimeout(() => inflight.delete(file), 1000)));
    }
    await inflight.get(file);
    res.sendFile(file);
  } catch (e) {
    console.warn("[photo]", e.message);
    res.status(502).end();
  }
});

module.exports = router;
