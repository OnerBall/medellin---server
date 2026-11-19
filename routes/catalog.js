// routes/catalog.js — каталог для Mini App + отдача фото товаров
const express = require("express");
const path = require("path");
const fs = require("fs");
const db = require("../db");
const products = require("../products");
const { SECTIONS, CATEGORIES } = require("../categories");
const rates = require("../rates");

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
      minPack: parseInt(process.env.PACK_DEFAULT || "12", 10),
      minOrder: parseInt(process.env.MIN_ORDER || "50000", 10),
      minOrderCis: parseInt(process.env.MIN_ORDER_CIS || "150000", 10)
    },
    countries: rates.COUNTRIES.map((c) => ({ ...c, rate: rates.rate(c.cur) })),
    sections: SECTIONS.map((s) => ({
      ...s,
      count: items.filter((p) => p.section === s.key).length,
      cover: (items.find((p) => p.section === s.key) || {}).photos?.[0] || null,
      categories: CATEGORIES.filter((c) => c.section === s.key).map((c) => ({ key: c.key, title: c.title, count: count[c.key] || 0 }))
    })),
    products: items
  });
});

// /photo/:id/:n и /video/:id/:n — файлы товара. Telegram хранит файл, мы скачиваем
// его один раз и дальше отдаём из кеша на диске (видео — с поддержкой перемотки).
const inflight = new Map();
async function cached(fileId, ext) {
  const safe = fileId.replace(/[^A-Za-z0-9_-]/g, "").slice(-80);
  const file = path.join(PHOTO_DIR, safe + ext);
  if (fs.existsSync(file)) return file;
  const { bot } = require("../bot");
  if (!bot) throw new Error("bot off");
  if (!inflight.has(file)) {
    inflight.set(file, (async () => {
      const link = await bot.telegram.getFileLink(fileId);
      const resp = await fetch(link.href);
      if (!resp.ok) throw new Error("telegram " + resp.status);
      fs.writeFileSync(file + ".tmp", Buffer.from(await resp.arrayBuffer()));
      fs.renameSync(file + ".tmp", file);
    })().finally(() => setTimeout(() => inflight.delete(file), 1000)));
  }
  await inflight.get(file);
  return file;
}

router.get("/photo/:id/:n", async (req, res) => {
  const r = products.get(req.params.id);
  const fileId = r && JSON.parse(r.photos || "[]")[parseInt(req.params.n, 10) || 0];
  if (!fileId) return res.status(404).end();
  try {
    const file = await cached(fileId, ".jpg");
    res.set("Cache-Control", "public, max-age=2592000, immutable");
    res.sendFile(file);
  } catch (e) { console.warn("[photo]", e.message); res.status(502).end(); }
});

router.get("/video/:id/:n", async (req, res) => {
  const r = products.get(req.params.id);
  const m = r && (products.mediaOf(r) || [])[parseInt(req.params.n, 10) || 0];
  if (!m || m.t !== "v" || (m.size && m.size > products.VIDEO_MAX)) return res.status(404).end();
  try {
    const file = await cached(m.id, ".mp4");
    res.set("Cache-Control", "public, max-age=2592000, immutable");
    res.type("video/mp4").sendFile(file); // sendFile сам отвечает на Range-запросы
  } catch (e) { console.warn("[video]", e.message); res.status(502).end(); }
});

module.exports = router;
