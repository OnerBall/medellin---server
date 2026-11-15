// bot.js — Telegram-бот Medellin:
//  • сам добавляет товары из постов канала (бот должен быть админом канала)
//  • принимает пересланные посты из канала — так заливаются старые товары
//  • присылает админу карточку товара с кнопками: категория, цена, скрыть, нет в наличии, удалить
//  • присылает заказы из каталога с кнопками статуса
const { Telegraf, Markup } = require("telegraf");
const db = require("./db");
const products = require("./products");
const { CATEGORIES, SECTIONS, SECTION_TITLE, BY_KEY, label } = require("./categories");
const { ORDER: UNIT_ORDER, unitOf, plural } = require("./units");
const MIN_ORDER = parseInt(process.env.MIN_ORDER || "50000", 10);

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_IDS = String(process.env.ADMIN_CHAT_ID || "").split(",").map((x) => parseInt(x.trim(), 10)).filter(Boolean);
const CHANNEL_ID = (process.env.CHANNEL_ID || "").trim(); // необязательно: -100… или @username — брать посты только из этого канала
const domain = process.env.RAILWAY_PUBLIC_DOMAIN;
const WEBAPP_URL = process.env.WEBAPP_URL || (domain ? `https://${domain}` : "");
const ALBUM_WAIT_MS = 2500;

const isAdmin = (id) => ADMIN_IDS.includes(Number(id));
const fmt = (n) => Math.round(n || 0).toLocaleString("ru-RU").replace(/ /g, " ");

let bot = null;
if (BOT_TOKEN) bot = new Telegraf(BOT_TOKEN);
else console.warn("[bot] BOT_TOKEN не задан — бот выключен.");

const catalogKb = (text = "🛍 Открыть каталог") => (WEBAPP_URL ? Markup.inlineKeyboard([[Markup.button.webApp(text, WEBAPP_URL)]]) : undefined);

// ---------- карточка товара для админа ----------
function cardText(r) {
  const missing = [];
  if (!r.category || !BY_KEY[r.category]) missing.push("категорию");
  if (!r.price_per_unit) missing.push("цену");
  if (!JSON.parse(r.photos || "[]").length) missing.push("фото");
  let status;
  if (r.hidden === 2) status = "🙈 Скрыт вами";
  else if (missing.length) status = `⚠️ Скрыт: укажите ${missing.join(", ")}`;
  else status = r.in_stock ? "✅ В каталоге" : "⛔ В каталоге, но «нет в наличии»";
  const sizes = JSON.parse(r.sizes || "[]");
  const u = unitOf(r.unit);
  const media = products.mediaOf(r) || [];
  const nv = media.filter((m) => m.t === "v").length, np = media.length ? media.filter((m) => m.t === "p").length : JSON.parse(r.photos || "[]").length;
  return [
    status, "",
    `🛍 ${r.name}`,
    `💰 ${r.price_per_unit ? fmt(r.price_per_unit) + " ₸ / " + u.label : "цена не найдена"} · упаковка ${products.packText(r)}` + (r.price_per_unit ? ` = ${fmt(r.price_per_unit * r.pack_qty)} ₸` : ""),
    `📂 ${label(r.category)}`,
    sizes.length ? `📏 ${sizes.join(" ")}` : null,
    `🖼 фото: ${np}` + (nv ? ` · 🎬 видео: ${nv}` : "")
  ].filter((x) => x !== null).join("\n");
}

function cardKb(r) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📂 Категория", `cat:${r.id}`), Markup.button.callback("💰 Цена", `price:${r.id}`), Markup.button.callback("📦 Упаковка", `pack:${r.id}`)],
    [Markup.button.callback(`🏷 Цена ${unitOf(r.unit).per}`, `unit:${r.id}`)],
    [Markup.button.callback(r.hidden === 2 ? "👁 Показать" : "🙈 Скрыть", `hide:${r.id}`),
      Markup.button.callback(r.in_stock ? "⛔ Нет в наличии" : "✅ Есть в наличии", `stock:${r.id}`)],
    [Markup.button.callback("🗑 Удалить", `del:${r.id}`)]
  ]);
}

function catKb(id) {
  const rows = [];
  for (const s of SECTIONS) {
    const cs = CATEGORIES.filter((c) => c.section === s.key);
    for (let i = 0; i < cs.length; i += 2)
      rows.push(cs.slice(i, i + 2).map((c) => Markup.button.callback(`${s.title[0]} · ${c.title}`, `setcat:${id}:${c.key}`)));
  }
  rows.push([Markup.button.callback("← Назад", `back:${id}`)]);
  return Markup.inlineKeyboard(rows);
}

async function sendCard(chatId, r, prefix = "") {
  const photos = JSON.parse(r.photos || "[]");
  const text = (prefix ? prefix + "\n" : "") + cardText(r);
  try {
    if (photos[0]) return await bot.telegram.sendPhoto(chatId, photos[0], { caption: text, ...cardKb(r) });
  } catch (e) { console.warn("[bot] sendPhoto:", e.message); }
  return bot.telegram.sendMessage(chatId, text, cardKb(r));
}

async function editCard(msg, r, kb) {
  const text = cardText(r);
  const markup = (kb || cardKb(r)).reply_markup;
  try {
    if (msg.photo) await bot.telegram.editMessageCaption(msg.chat.id, msg.message_id, undefined, text, { reply_markup: markup });
    else await bot.telegram.editMessageText(msg.chat.id, msg.message_id, undefined, text, { reply_markup: markup });
  } catch (e) {
    if (!/not modified/.test(e.message)) console.warn("[bot] editCard:", e.message);
  }
}

// ---------- разбор сообщения с товаром ----------
function mediaOf(m) {
  if (m.photo && m.photo.length) { const p = m.photo[m.photo.length - 1]; return { t: "p", id: p.file_id, uid: p.file_unique_id }; }
  const v = m.video || m.animation || (m.document && /^video\//.test(m.document.mime_type || "") ? m.document : null);
  if (v) { const th = v.thumbnail || v.thumb; return { t: "v", id: v.file_id, uid: v.file_unique_id, th: th ? th.file_id : null, size: v.file_size || 0 }; }
  if (m.document && /^image\//.test(m.document.mime_type || "")) return { t: "p", id: m.document.file_id, uid: m.document.file_unique_id };
  return null;
}
const photoOf = (m) => mediaOf(m);

function sourceOf(m) {
  const o = m.forward_origin;
  if (o && o.type === "channel" && o.chat) return { key: `ch:${o.chat.id}:${o.message_id}`, chat: o.chat };
  if (m.forward_from_chat && m.forward_from_message_id) return { key: `ch:${m.forward_from_chat.id}:${m.forward_from_message_id}`, chat: m.forward_from_chat };
  if (m.chat && m.chat.type === "channel") return { key: `ch:${m.chat.id}:${m.message_id}`, chat: m.chat };
  return { key: `dm:${m.chat.id}:${m.message_id}`, chat: null };
}

function channelAllowed(chat) {
  if (!CHANNEL_ID || !chat) return true;
  return String(chat.id) === CHANNEL_ID || (chat.username && "@" + chat.username.toLowerCase() === CHANNEL_ID.toLowerCase());
}

// альбомы приходят пачкой сообщений — собираем их и импортируем одним товаром
const albums = new Map();
function collect(m, notifyChat, isEdit) {
  const src = sourceOf(m);
  if (src.chat && !channelAllowed(src.chat)) return;
  const item = mediaOf(m);
  const caption = m.caption || m.text || "";
  if (!m.media_group_id) return finish({ source: src.key, mediaGroupId: null, caption, media: item ? [item] : [] }, notifyChat, isEdit);
  // для альбомов ключ — по первому (наименьшему) сообщению, чтобы пересылка того же альбома не создала дубль
  const gid = `${m.chat.id}:${m.media_group_id}`;
  let a = albums.get(gid);
  if (!a) { a = { photos: [], caption: "", keys: [], notifyChat, isEdit }; albums.set(gid, a); }
  if (item) a.photos.push({ id: m.message_id, item });
  if (caption) a.caption = caption;
  a.keys.push({ id: m.message_id, key: src.key });
  clearTimeout(a.timer);
  a.timer = setTimeout(() => {
    albums.delete(gid);
    const first = a.keys.sort((x, y) => x.id - y.id)[0];
    finish({ source: first.key, mediaGroupId: gid, caption: a.caption, media: a.photos.sort((x, y) => x.id - y.id).map((p) => p.item) }, a.notifyChat, a.isEdit);
  }, ALBUM_WAIT_MS);
}

async function finish(post, notifyChat, isEdit) {
  let res;
  try { res = products.importPost(post); } catch (e) { console.error("[bot] import:", e); return; }
  const target = notifyChat || ADMIN_IDS[0];
  if (!target) return;
  if (!res) {
    if (notifyChat) await bot.telegram.sendMessage(notifyChat, "🤔 Не похоже на товар: нет ни фото, ни цены. Пропускаю.");
    return;
  }
  if (!res.created && !res.captionChanged && !res.mediaChanged && !notifyChat) return; // повтор без изменений — молчим
  const prefix = res.created ? "🆕 Новый товар из канала" : isEdit || res.captionChanged || res.mediaChanged ? "✏️ Товар обновлён" : "♻️ Этот товар уже в каталоге";
  try { await sendCard(target, res.product, prefix); } catch (e) { console.warn("[bot] card:", e.message); }
}

// ---------- заказы ----------
const STATUS_LABELS = { pending: "⏳ Новый", contacted: "📞 Связались", paid: "✅ Оплачен", shipped: "📦 Отправлен", cancelled: "❌ Отменён" };
const CLIENT_STATUS = { paid: "✅ Оплата по заказу №{id} получена. Спасибо!", shipped: "📦 Заказ №{id} отправлен! Спасибо, что выбрали Medellin 🤍" };

function orderCaption(o) {
  const items = JSON.parse(o.items);
  const lines = items.map((i) => `• ${i.name}${i.size ? ` (${i.size})` : ""} × ${i.qty} уп. (${i.qty * i.pack} ${plural(i.qty * i.pack, unitOf(i.unit).forms)}) — ${fmt(i.price * i.pack * i.qty)} ₸`).join("\n");
  const who = o.tg_username ? `@${o.tg_username}` : o.tg_user_id ? `tg://user?id=${o.tg_user_id}` : "";
  return `🛒 Заказ №${o.id}\nСтатус: ${STATUS_LABELS[o.status] || o.status}\n\n` +
    `👤 ${o.name || "—"}${who ? " · " + who : ""}\n📞 ${o.phone || "—"}\n📍 ${[o.city, o.country].filter(Boolean).join(", ") || "—"}\n` +
    (o.comment ? `💬 ${o.comment}\n` : "") + `\n${lines}\n\n💰 Итого: ${fmt(o.total_kzt)} ₸`;
}

function statusKb(o) {
  const phone = String(o.phone || "").replace(/\D/g, "");
  const rows = [
    [Markup.button.callback("📞 Связались", `status:${o.id}:contacted`), Markup.button.callback("✅ Оплачен", `status:${o.id}:paid`)],
    [Markup.button.callback("📦 Отправлен", `status:${o.id}:shipped`), Markup.button.callback("❌ Отменён", `status:${o.id}:cancelled`)]
  ];
  if (phone.length >= 10) rows.push([Markup.button.url("💬 Написать в WhatsApp", `https://wa.me/${phone}`)]);
  return Markup.inlineKeyboard(rows);
}

async function notifyNewOrder(o) {
  if (!bot || !ADMIN_IDS.length) return;
  for (const a of ADMIN_IDS) {
    try {
      const sent = await bot.telegram.sendMessage(a, orderCaption(o), statusKb(o));
      if (a === ADMIN_IDS[0]) db.prepare("UPDATE orders SET telegram_chat_id=?, telegram_message_id=? WHERE id=?").run(sent.chat.id, sent.message_id, o.id);
    } catch (e) { console.error("[bot] заказ админу:", e.message); }
  }
  if (o.tg_user_id) {
    try {
      await bot.telegram.sendMessage(o.tg_user_id, `🤍 Заказ №${o.id} принят!\nСумма: ${fmt(o.total_kzt)} ₸\n\nМы напишем вам в WhatsApp в ближайшее время.`, catalogKb("🛍 Вернуться в каталог"));
    } catch (e) { /* клиент мог не запускать бота — не страшно */ }
  }
}

// ---------- обработчики ----------
const pending = new Map(); // chatId -> { id, field, msg }

if (bot) {
  bot.start(async (ctx) => {
    if (isAdmin(ctx.from.id)) {
      await ctx.reply(
        "Привет! Я наполняю каталог Medellin сам 🤍\n\n" +
        "• Добавь меня админом в канал — каждый новый пост с фото и ценой сразу попадёт в каталог.\n" +
        "• Старые товары: выдели посты в канале и перешли их мне.\n" +
        "• Категория берётся из хэштега (#женскиетрусы, #пижамы…). Если хэштега нет — пришлю кнопки, выберешь.\n\n" +
        "Команды: /stats — сводка, /hidden — скрытые товары, /tags — список хэштегов.", catalogKb());
    } else {
      await ctx.reply(`Добро пожаловать в Medellin 🤍\nОптовый каталог белья, пижам и халатов.\nЗаказ от ${fmt(MIN_ORDER)} ₸ · доставка по Казахстану и СНГ.`, catalogKb());
    }
  });

  bot.command("stats", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const all = db.prepare("SELECT * FROM products").all();
    const pub = all.filter(products.isPublic).length;
    const orders = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_kzt),0) s FROM orders WHERE status!='cancelled'").get();
    await ctx.reply(`📊 Товаров: ${all.length}\n✅ В каталоге: ${pub}\n🙈 Скрыто: ${all.length - pub}\n\n🛒 Заказов: ${orders.n} на ${fmt(orders.s)} ₸`, catalogKb());
  });

  bot.command("hidden", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rows = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all().filter((r) => !products.isPublic(r)).slice(0, 15);
    if (!rows.length) return ctx.reply("Скрытых товаров нет — всё в каталоге ✅");
    for (const r of rows) await sendCard(ctx.chat.id, r);
  });

  bot.command("tags", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const t = SECTIONS.map((s) => `${s.title}:\n` + CATEGORIES.filter((c) => c.section === s.key).map((c) => `#${c.tag} — ${c.title}`).join("\n")).join("\n\n");
    await ctx.reply("Хэштеги для постов:\n\n" + t);
  });

  bot.on("channel_post", (ctx) => collect(ctx.update.channel_post, null, false));
  bot.on("edited_channel_post", (ctx) => collect(ctx.update.edited_channel_post, null, true));

  bot.on("message", async (ctx) => {
    const m = ctx.message;
    if (!isAdmin(ctx.from.id)) {
      return ctx.reply("Каталог Medellin — по кнопке ниже 👇\nВопросы — в WhatsApp: wa.me/" + (process.env.WHATSAPP || "77022585183"), catalogKb());
    }
    // ответ админа на «введи цену/упаковку»
    const p = pending.get(ctx.chat.id);
    if (p && m.text && /^\s*[\d\s]+\s*(₸|тг)?\s*$/i.test(m.text)) {
      const v = parseInt(m.text.replace(/\D/g, ""), 10);
      pending.delete(ctx.chat.id);
      if (!(v > 0)) return ctx.reply("Нужно число больше нуля.");
      const r = products.update(p.id, { [p.field]: v });
      if (!r) return ctx.reply("Товар уже удалён.");
      await editCard(p.msg, r);
      return ctx.reply(p.field === "price_per_unit" ? `💰 Цена обновлена: ${fmt(v)} ₸ / шт` : `📦 Упаковка: ${v} шт`);
    }
    if (photoOf(m) || m.forward_origin || m.forward_from_chat || /(тг|₸|тенге)/i.test(m.text || m.caption || "")) {
      return collect(m, ctx.chat.id, false);
    }
    await ctx.reply("Перешли мне пост с товаром из канала или отправь фото с описанием и ценой — добавлю в каталог.\n/stats — сводка", catalogKb());
  });

  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    const msg = ctx.callbackQuery.message;
    const [act, id, extra] = data.split(":");
    if (!isAdmin(ctx.from.id)) return ctx.answerCbQuery("Только для администратора");

    if (act === "status") {
      if (!STATUS_LABELS[extra]) return ctx.answerCbQuery();
      db.prepare("UPDATE orders SET status=? WHERE id=?").run(extra, id);
      const o = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
      if (o) {
        try { await ctx.editMessageText(orderCaption(o), statusKb(o)); } catch (e) { /* not modified */ }
        if (o.tg_user_id && CLIENT_STATUS[extra]) bot.telegram.sendMessage(o.tg_user_id, CLIENT_STATUS[extra].replace("{id}", o.id)).catch(() => {});
      }
      return ctx.answerCbQuery(STATUS_LABELS[extra]);
    }

    const r = products.get(id);
    if (!r && act !== "delno") { await ctx.answerCbQuery("Товар уже удалён"); return; }
    switch (act) {
      case "cat": await editCard(msg, r, catKb(id)); return ctx.answerCbQuery("Выбери категорию");
      case "back": await editCard(msg, r); return ctx.answerCbQuery();
      case "setcat": {
        if (!BY_KEY[extra]) return ctx.answerCbQuery();
        const u = products.update(id, { category: extra });
        await editCard(msg, u); return ctx.answerCbQuery("📂 " + label(extra));
      }
      case "price":
      case "pack":
        pending.set(ctx.chat.id, { id, field: act === "price" ? "price_per_unit" : "pack_qty", msg });
        await ctx.answerCbQuery();
        return ctx.reply(act === "price" ? "Напиши цену за 1 шт числом, например 650" : "Сколько штук в упаковке? Напиши число, например 12");
      case "unit": {
        const next = UNIT_ORDER[(UNIT_ORDER.indexOf(r.unit || "pcs") + 1) % UNIT_ORDER.length];
        const u = products.update(id, { unit: next });
        await editCard(msg, u); return ctx.answerCbQuery("Цена " + unitOf(next).per);
      }
      case "hide": {
        const u = products.update(id, { hidden: r.hidden === 2 ? 0 : 2 });
        await editCard(msg, u); return ctx.answerCbQuery(u.hidden === 2 ? "Скрыт из каталога" : "Показан в каталоге");
      }
      case "stock": {
        const u = products.update(id, { in_stock: r.in_stock ? 0 : 1 });
        await editCard(msg, u); return ctx.answerCbQuery(u.in_stock ? "Есть в наличии" : "Нет в наличии");
      }
      case "del":
        await editCard(msg, r, Markup.inlineKeyboard([[Markup.button.callback("🗑 Да, удалить", `delok:${id}`), Markup.button.callback("Отмена", `back:${id}`)]]));
        return ctx.answerCbQuery("Точно удалить?");
      case "delok":
        products.remove(id);
        try {
          if (msg.photo) await ctx.editMessageCaption(`🗑 Удалено: ${r.name}`);
          else await ctx.editMessageText(`🗑 Удалено: ${r.name}`);
        } catch (e) { /* ignore */ }
        return ctx.answerCbQuery("Удалено");
      default: return ctx.answerCbQuery();
    }
  });

  bot.catch((err) => console.error("[bot] Ошибка:", err));
}

const ALLOWED_UPDATES = ["message", "edited_message", "channel_post", "edited_channel_post", "callback_query"];

module.exports = { bot, notifyNewOrder, WEBAPP_URL, ALLOWED_UPDATES, SECTION_TITLE };
