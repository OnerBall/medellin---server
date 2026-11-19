// routes/admin.js — редактирование товаров прямо из каталога (только для админов из ADMIN_CHAT_ID)
const crypto = require("crypto");
const express = require("express");
const products = require("../products");
const { BY_KEY } = require("../categories");
const { parsePriceRules } = require("../parse");
const rulesText = (rules) => (rules || []).map((r) => `${[...(r.c || []), ...(r.s || [])].join(" ") || "все"}: ${r.p}тг`).join("\n");

const router = express.Router();
const ADMIN_IDS = String(process.env.ADMIN_CHAT_ID || "").split(",").map((x) => parseInt(x.trim(), 10)).filter(Boolean);

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
  } catch (e) { return null; }
}
const admin = (req) => { const u = tgUser((req.body || {}).initData); return u && ADMIN_IDS.includes(Number(u.id)) ? u : null; };
const jarr = (s) => { try { const a = JSON.parse(s || "null"); return Array.isArray(a) ? a : null; } catch (e) { return null; } };

router.post("/api/admin/me", (req, res) => res.json({ admin: !!admin(req) }));

router.post("/api/admin/get", (req, res) => {
  if (!admin(req)) return res.status(403).json({ error: "forbidden" });
  const r = products.get(String(req.body.id || ""));
  if (!r) return res.status(404).json({ error: "not found" });
  const j = products.toJSON(r);
  res.json({
    id: r.id, name: r.name, soldOut: products.soldOut(r), sizeMix: products.sizeMix(r), priceText: rulesText(jarr(r.price_rules)), sizes: (jarr(r.sizes) || []).join(" "), price: r.price_per_unit, pack: r.pack_qty, sale: r.sale_price || null, category: r.category || "",
    country: r.country || "", inStock: !!r.in_stock, hidden: r.hidden === 2, unit: j.unit,
    colorMode: products.colorMode(r) === "skip1" ? "pick" : products.colorMode(r),
    colorPhotos: jarr(r.color_photos) || products.colorOpts(r).filter((o) => o.photo !== null).map((o) => o.k),
    colorNames: jarr(r.color_names) || [], photos: j.photos.slice(0, j.nPhotos),
  });
});

router.post("/api/admin/save", (req, res) => {
  if (!admin(req)) return res.status(403).json({ error: "forbidden" });
  const r = products.get(String(req.body.id || ""));
  if (!r) return res.status(404).json({ error: "not found" });
  const f = req.body.f || {}, u = {};
  const int = (v) => { const n = parseInt(String(v).replace(/\D/g, ""), 10); return Number.isFinite(n) ? n : null; };
  if (typeof f.name === "string" && f.name.trim()) u.name = f.name.trim().slice(0, 120);
  if (f.price !== undefined) { const n = int(f.price); if (n > 0) u.price_per_unit = n; }
  if (f.pack !== undefined) { const n = int(f.pack); if (n > 0 && n < 1000) u.pack_qty = n; }
  if (f.sale !== undefined) { const n = int(f.sale); u.sale_price = n > 0 && n < (u.price_per_unit || r.price_per_unit) ? n : null; }
  if (f.category !== undefined && (f.category === "" || BY_KEY[f.category])) u.category = f.category || null;
  if (typeof f.priceText === "string") {
    const rules = parsePriceRules(f.priceText.split(/\n+/).map((s) => s.trim()).filter(Boolean));
    u.price_rules = rules.length ? JSON.stringify(rules) : null;
    if (rules.length) u.price_per_unit = Math.min(...rules.map((x) => x.p));
  }
  if (typeof f.sizes === "string") u.sizes = JSON.stringify([...new Set(f.sizes.split(/[\s,;]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 15));
  if (typeof f.country === "string") u.country = f.country.trim().slice(0, 40);
  if (Array.isArray(f.soldOut)) u.sold_out = JSON.stringify(f.soldOut.map(String).slice(0, 30));
  if (typeof f.sizeMix === "boolean") u.size_mode = f.sizeMix ? "mix" : "pick";
  if (typeof f.inStock === "boolean") u.in_stock = f.inStock ? 1 : 0;
  if (typeof f.hidden === "boolean") u.hidden = f.hidden ? 2 : 0;
  if (["pick", "names", "mix"].includes(f.colorMode)) u.color_mode = f.colorMode;
  if (Array.isArray(f.colorPhotos)) u.color_photos = JSON.stringify(f.colorPhotos.map(Number).filter((n) => Number.isInteger(n) && n >= 0).slice(0, 40));
  if (Array.isArray(f.colorNames)) u.color_names = JSON.stringify(f.colorNames.map((s) => String(s).trim()).filter(Boolean).slice(0, 30).map((s) => s.slice(0, 30)));
  let r2 = products.update(r.id, u);
  if (Array.isArray(f.removePhotos) && f.removePhotos.length) r2 = products.removePhotos(r.id, f.removePhotos.map(Number));
  res.json({ ok: true, product: products.isPublic(r2) ? products.toJSON(r2) : null });
});

router.post("/api/admin/delete", (req, res) => {
  if (!admin(req)) return res.status(403).json({ error: "forbidden" });
  products.remove(String(req.body.id || ""));
  res.json({ ok: true });
});

module.exports = router;
