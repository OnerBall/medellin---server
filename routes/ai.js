// routes/ai.js — AI-ассистент внутри Mini App: голос или текст → подбор товаров
const express = require("express");
const ai = require("../ai");
const { tgUser } = require("./orders");

const router = express.Router();
const who = (req, initData) => { const u = tgUser(initData); return u ? `tg${u.id}` : `ip${req.ip}`; };
const answer = (res, query, r) => res.json({ query, reply: r.reply, ids: r.items.map((p) => p.id) });

router.post("/api/ai/find", async (req, res) => {
  const q = String((req.body || {}).q || "").trim().slice(0, 300);
  if (q.length < 2) return res.status(400).json({ error: "Напишите, что ищете" });
  if (!ai.allow(who(req, (req.body || {}).initData))) return res.status(429).json({ error: "Слишком много запросов — попробуйте чуть позже" });
  try { answer(res, q, await ai.find(q)); }
  catch (e) { console.warn("[ai] find:", e.message); res.status(502).json({ error: "Ассистент сейчас недоступен" }); }
});

router.post("/api/ai/voice", express.raw({ type: () => true, limit: "6mb" }), async (req, res) => {
  if (!ai.enabled()) return res.status(503).json({ error: "Голосовой поиск пока не включён — напишите текстом" });
  if (!req.body || !req.body.length) return res.status(400).json({ error: "Пустая запись" });
  if (!ai.allow(who(req, req.get("X-Init-Data")))) return res.status(429).json({ error: "Слишком много запросов — попробуйте чуть позже" });
  try {
    const q = await ai.transcribe(req.body, req.get("Content-Type"));
    if (!q) return res.status(422).json({ error: "Не расслышали 🙈 Скажите ещё раз" });
    answer(res, q, await ai.find(q));
  } catch (e) { console.warn("[ai] voice:", e.message); res.status(502).json({ error: "Не получилось распознать — попробуйте ещё раз" }); }
});

module.exports = router;
