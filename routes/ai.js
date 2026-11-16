// routes/ai.js — AI-ассистент внутри Mini App: голос или текст → подбор товаров
const express = require("express");
const ai = require("../ai");
const { tgUser } = require("./orders");
const analytics = require("../analytics");

const router = express.Router();
const who = (req, initData) => { const u = tgUser(initData); return u ? `tg${u.id}` : `ip${req.ip}`; };
const uidOf = (initData) => { const u = tgUser(initData); return u ? u.id : null; };
const answer = (res, query, r, uid) => { analytics.log("ai", { uid, q: query, n: r.items.length }); res.json({ query, reply: r.reply, ids: r.items.map((p) => p.id) }); };

router.post("/api/ai/find", async (req, res) => {
  const q = String((req.body || {}).q || "").trim().slice(0, 300);
  if (q.length < 2) return res.status(400).json({ error: "Напишите, что ищете" });
  if (!ai.allow(who(req, (req.body || {}).initData))) return res.status(429).json({ error: "Слишком много запросов — попробуйте чуть позже" });
  try { answer(res, q, await ai.find(q), uidOf((req.body || {}).initData)); }
  catch (e) { console.warn("[ai] find:", e.message); res.status(502).json({ error: "Ассистент сейчас недоступен" }); }
});

router.post("/api/ai/voice", express.raw({ type: () => true, limit: "6mb" }), async (req, res) => {
  if (!ai.enabled()) return res.status(503).json({ error: "Голосовой поиск пока не включён — напишите текстом" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "Пустая запись" });
  if (!ai.allow(who(req, req.get("X-Init-Data")))) return res.status(429).json({ error: "Слишком много запросов — попробуйте чуть позже" });
  try {
    const q = await ai.transcribe(req.body, req.get("Content-Type"));
    if (!q) return res.status(422).json({ error: "Не расслышали 🙈 Скажите ещё раз" });
    answer(res, q, await ai.find(q), uidOf(req.get("X-Init-Data")));
  } catch (e) { console.warn("[ai] voice:", e.message); res.status(502).json({ error: "Не получилось распознать — попробуйте ещё раз" }); }
});

// события из Mini App для аналитики (пачкой)
const seen = new Map();
router.post("/api/ev", (req, res) => {
  const b = req.body || {};
  let uid = seen.get(b.initData);
  if (uid === undefined) { uid = uidOf(b.initData); if (b.initData) { seen.set(b.initData, uid); if (seen.size > 5000) seen.clear(); } }
  for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, 40)) analytics.log(String(e.k || ""), { uid, pid: e.p, q: e.q, n: e.n });
  res.json({ ok: true });
});

// Mini App открыли — запоминаем покупателя для рассылки новинок
router.post("/api/hello", (req, res) => {
  const u = tgUser((req.body || {}).initData);
  if (u) require("../digest").track(u, !u.allows_write_to_pm);
  res.json({ ok: true });
});

module.exports = router;
