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
const rates = require("./rates");

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
const STATUS_LABELS = { pending: "⏳ Новый", contacted: "📞 Связались", invoiced: "💳 Счёт отправлен", paid: "✅ Оплачен", shipped: "📦 Отправлен", cancelled: "❌ Отменён" };
const CLIENT_STATUS = { paid: "✅ Оплата по заказу №{id} получена. Спасибо!", shipped: "📦 Заказ №{id} отправлен! Спасибо, что выбрали Medellin 🤍" };

function orderCaption(o) {
  const items = JSON.parse(o.items);
  const lines = items.map((i) => `• ${i.name}${i.size ? ` (${i.size})` : ""} × ${i.qty} уп. (${i.qty * i.pack} ${plural(i.qty * i.pack, unitOf(i.unit).forms)}) — ${fmt(i.price * i.pack * i.qty)} ₸`).join("\n");
  const who = o.tg_username ? `@${o.tg_username}` : o.tg_user_id ? `tg://user?id=${o.tg_user_id}` : "";
  const bc = rates.BY_CODE[o.buyer_country], pc = rates.BY_CODE[rates.countryByPhone(o.phone)];
  const flags = bc ? `${bc.flag} ${bc.name}` + (pc && pc.code !== bc.code ? ` (номер ${pc.flag})` : "") : pc ? `${pc.flag} ${pc.name} (по номеру)` : "";
  const shown = o.shown_total && bc ? `\n💱 Покупатель видел: ≈ ${fmt(o.shown_total)} ${bc.sym}` + (o.rate_used ? ` (курс ${o.rate_used})` : "") : "";
  return `🛒 Заказ №${o.id}${flags ? " · " + flags : ""}\nСтатус: ${STATUS_LABELS[o.status] || o.status}\n\n` +
    `👤 ${o.name || "—"}${who ? " · " + who : ""}\n📞 ${o.phone || "—"}\n📍 ${[o.city, o.country].filter(Boolean).join(", ") || "—"}\n` +
    (o.comment ? `💬 ${o.comment}\n` : "") + `\n${lines}\n\n💰 Итого: ${fmt(o.total_kzt)} ₸${shown}`;
}

function statusKb(o) {
  const phone = String(o.phone || "").replace(/\D/g, "");
  const rows = [
    [Markup.button.callback("📞 Связались", `status:${o.id}:contacted`), Markup.button.callback("✅ Оплачен", `status:${o.id}:paid`)],
    [Markup.button.callback("📦 Отправлен", `status:${o.id}:shipped`), Markup.button.callback("❌ Отменён", `status:${o.id}:cancelled`)]
  ];
  rows.push([Markup.button.callback("✏️ Изменить заказ", `oed:${o.id}`), Markup.button.callback("💳 Отправить счёт", `inv:${o.id}`)]);
  if (phone.length >= 10) rows.push([Markup.button.url("💬 Написать в WhatsApp", `https://wa.me/${phone}`)]);
  return Markup.inlineKeyboard(rows);
}

// ---------- реквизиты, изменение заказа, счёт, чеки ----------
db.exec("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT)");
const getSetting = (k) => (db.prepare("SELECT value FROM settings WHERE key=?").get(k) || {}).value || "";
const setSetting = (k, v) => db.prepare("INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(k, v);

function getOrder(id) { return db.prepare("SELECT * FROM orders WHERE id=?").get(id); }

function orderLines(o) {
  return JSON.parse(o.items).map((i) => `• ${i.name}${i.size ? ` (${i.size})` : ""} × ${i.qty} уп. — ${fmt(i.price * i.pack * i.qty)} ₸`).join("\n");
}

function shownFor(o, total) {
  const c = rates.BY_CODE[o.buyer_country];
  if (!c || c.cur === "KZT") return null;
  const r = o.rate_used || rates.rate(c.cur);
  const v = total / r;
  return c.cur === "UZS" ? Math.round(v / 100) * 100 : Math.round(v);
}
const altText = (o) => { const c = rates.BY_CODE[o.buyer_country]; return o.shown_total && c ? ` (≈ ${fmt(o.shown_total)} ${c.sym})` : ""; };

function editKb(o) {
  const items = JSON.parse(o.items);
  const rows = items.map((i, k) => [
    Markup.button.callback(`➖ ${i.name.slice(0, 22)}${i.size ? " " + i.size : ""} · ${i.qty} уп.`, `oit:${o.id}:${k}:-1`),
    Markup.button.callback("➕", `oit:${o.id}:${k}:1`)
  ]);
  rows.push([Markup.button.callback("✅ Готово — сообщить клиенту", `oek:${o.id}`)]);
  rows.push([Markup.button.callback("← Назад без уведомления", `oex:${o.id}`)]);
  return Markup.inlineKeyboard(rows);
}

function invoiceText(o) {
  const kz = !o.buyer_country || o.buyer_country === "KZ";
  const pay = (kz ? getSetting("pay_kz") : getSetting("pay_cis") || getSetting("pay_kz")).trim();
  return `💳 Счёт по заказу №${o.id} — Medellin\n\n${orderLines(o)}\n\nК оплате: ${fmt(o.total_kzt)} ₸${altText(o)}\n\n${pay}\n\nПосле оплаты пришлите фото чека в этот чат 🤍`;
}

const changed = new Set();
const waLink = (phone, text) => `https://wa.me/${String(phone || "").replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;

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
      await bot.telegram.sendMessage(o.tg_user_id, `🤍 Заказ №${o.id} принят!\nСумма: ${fmt(o.total_kzt)} ₸\n\nПроверим наличие и пришлём счёт. Чек об оплате можно прислать сюда 🤍`, catalogKb("🛍 Вернуться в каталог"));
    } catch (e) { /* клиент мог не запускать бота — не страшно */ }
  }
}

// где лежит база: на диске Railway (Volume) или внутри контейнера (стирается при обновлении)
function diskInfo() {
  const path = require("path");
  const real = path.resolve(db.DB_PATH);
  const mount = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  const onDisk = mount ? real.startsWith(path.resolve(mount) + path.sep) : null;
  return `💾 База: ${real}\n` + (onDisk === null ? "ℹ️ Диск Railway не найден" : onDisk ? "✅ На диске — не пропадёт при обновлениях" : `⚠️ НЕ на диске (${mount}) — исправь DB_PATH на ${mount}/medellin.db`);
}

// ---------- обработчики ----------
const pending = new Map(); // chatId -> { id, field, msg }
// команды регистрируем и как обычные, и как текст «/pay …» — на случай, если команду
// вставили скопированной (моноширинным текстом), тогда Telegram не помечает её как команду
const CMDS = {};
function command(name, fn) { CMDS[name] = fn; bot.command(name, fn); }

if (bot) {
  bot.start(async (ctx) => {
    if (isAdmin(ctx.from.id)) {
      await ctx.reply(
        "Привет! Я наполняю каталог Medellin сам 🤍\n\n" +
        "• Добавь меня админом в канал — каждый новый пост с фото и ценой сразу попадёт в каталог.\n" +
        "• Старые товары: выдели посты в канале и перешли их мне.\n" +
        "• Категория берётся из хэштега (#женскиетрусы, #пижамы…). Если хэштега нет — пришлю кнопки, выберешь.\n\n" +
        "Команды: /stats — сводка, /hidden — скрытые товары, /tags — хэштеги, /rates — курсы валют, /pay — реквизиты для счёта.", catalogKb());
    } else {
      await ctx.reply(`Добро пожаловать в Medellin 🤍\nОптовый каталог белья, пижам и халатов.\nЗаказ от ${fmt(MIN_ORDER)} ₸ · доставка по Казахстану и СНГ.`, catalogKb());
    }
  });

  command("stats", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const all = db.prepare("SELECT * FROM products").all();
    const pub = all.filter(products.isPublic).length;
    const orders = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(total_kzt),0) s FROM orders WHERE status!='cancelled'").get();
    await ctx.reply(`📊 Товаров: ${all.length}\n✅ В каталоге: ${pub}\n🙈 Скрыто: ${all.length - pub}\n\n🛒 Заказов: ${orders.n} на ${fmt(orders.s)} ₸\n\n${diskInfo()}`, catalogKb());
  });

  command("hidden", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const rows = db.prepare("SELECT * FROM products ORDER BY created_at DESC").all().filter((r) => !products.isPublic(r)).slice(0, 15);
    if (!rows.length) return ctx.reply("Скрытых товаров нет — всё в каталоге ✅");
    for (const r of rows) await sendCard(ctx.chat.id, r);
  });

  command("pay", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    // можно одной командой или несколькими «/pay kz …» и «/pay cis …» в одном сообщении
    const parts = [...(ctx.message.text || "").matchAll(/\/pay(?:@\w+)?\s+(kz|cis)\s+([\s\S]*?)(?=\n?\s*\/pay(?:@\w+)?\s+(?:kz|cis)\s|$)/gi)];
    if (parts.length) {
      const saved = [];
      for (const [, k, v] of parts) if (v.trim()) { setSetting("pay_" + k.toLowerCase(), v.trim()); saved.push(k.toLowerCase() === "kz" ? "🇰🇿 Казахстан" : "🌍 СНГ"); }
      if (saved.length) return ctx.reply(`✅ Реквизиты сохранены: ${saved.join(", ")}\nПроверить: /pay`);
    }
    await ctx.reply(`💳 Реквизиты в счёте:\n\n🇰🇿 Казахстан:\n${getSetting("pay_kz") || "— не заданы"}\n\n🌍 СНГ:\n${getSetting("pay_cis") || "— (будут как для Казахстана)"}\n\nИзменить:\n/pay kz Kaspi: +7 778 … (Ерлан Ж.)\n/pay cis Перевод на карту Kaspi 4400 … через ваш банк или Золотая Корона`);
  });

  command("rates", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const t = rates.allRates().map((r) => `${r.code}: 1 = ${r.value.toFixed(r.code === "UZS" ? 4 : 2)} ₸${r.manual ? " ✋ вручную" : r.source === "mig" ? " · mig.kz" : r.source === "nbk" ? " · Нацбанк" : " · примерный"}`).join("\n");
    await ctx.reply(`💱 Курсы (тенге за 1 единицу):\n${t}\n\nСвой курс: /rate KGS 6.1\nВернуть авто: /rate KGS auto\nОбновить сейчас: /rate refresh`);
  });

  command("rate", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const [, code, val] = (ctx.message.text || "").trim().split(/\s+/);
    const cur = String(code || "").toUpperCase();
    if (cur === "REFRESH") { await rates.refresh(); return ctx.reply("Курсы обновлены — /rates"); }
    if (!["KGS", "UZS", "RUB", "TJS"].includes(cur)) return ctx.reply("Пример: /rate KGS 6.1  (валюты: KGS, UZS, RUB, TJS)");
    if (/^auto$/i.test(val || "")) { rates.setManual(cur, null); await rates.refresh(); return ctx.reply(`${cur}: снова по Нацбанку ✅`); }
    const v = parseFloat(String(val || "").replace(",", "."));
    if (!(v > 0)) return ctx.reply("Нужно число, например /rate KGS 6.1");
    rates.setManual(cur, v);
    await ctx.reply(`${cur}: 1 = ${v} ₸ ✋ (вручную)`);
  });

  command("tags", async (ctx) => {
    if (!isAdmin(ctx.from.id)) return;
    const t = SECTIONS.map((s) => `${s.title}:\n` + CATEGORIES.filter((c) => c.section === s.key).map((c) => `#${c.tag} — ${c.title}`).join("\n")).join("\n\n");
    await ctx.reply("Хэштеги для постов:\n\n" + t);
  });

  bot.on("channel_post", (ctx) => collect(ctx.update.channel_post, null, false));
  bot.on("edited_channel_post", (ctx) => collect(ctx.update.edited_channel_post, null, true));

  bot.on("message", async (ctx) => {
    const m = ctx.message;
    const txt = (m.text || "").trim();
    if (txt.startsWith("/")) {
      const name = txt.slice(1).split(/[\s@]/)[0].toLowerCase();
      if (CMDS[name]) return CMDS[name](ctx);
    }
    if (!isAdmin(ctx.from.id)) {
      const file = m.photo ? m.photo[m.photo.length - 1].file_id : m.document ? m.document.file_id : null;
      if (file) {
        const o = db.prepare("SELECT * FROM orders WHERE tg_user_id=? AND status NOT IN ('shipped','cancelled') AND created_at>? ORDER BY created_at DESC LIMIT 1")
          .get(ctx.from.id, Date.now() - 30 * 86400e3);
        if (o) {
          const cap = `🧾 Чек по заказу №${o.id}\n👤 ${o.name} · ${o.phone}\n💰 ${fmt(o.total_kzt)} ₸${altText(o)}`;
          for (const a of ADMIN_IDS) {
            try {
              if (m.photo) await bot.telegram.sendPhoto(a, file, { caption: cap, ...statusKb(o) });
              else await bot.telegram.sendDocument(a, file, { caption: cap, ...statusKb(o) });
            } catch (e) { console.warn("[bot] чек:", e.message); }
          }
          return ctx.reply(`🧾 Чек по заказу №${o.id} получен! Проверим и подтвердим оплату 🤍`);
        }
      }
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

    if (["oed", "oit", "oek", "oex", "inv"].includes(act)) {
      const o = getOrder(id);
      if (!o) return ctx.answerCbQuery("Заказ не найден");
      const edit = async (text, kb) => {
        try {
          if (msg.photo || msg.document) await ctx.editMessageCaption(text, kb);
          else await ctx.editMessageText(text, kb);
        } catch (e) { /* not modified */ }
      };
      if (act === "oed") { await edit(orderCaption(o) + "\n\n✏️ Уменьши количество или убери позиции, которых нет:", editKb(o)); return ctx.answerCbQuery(); }
      if (act === "oex") { await edit(orderCaption(o), statusKb(o)); return ctx.answerCbQuery(); }
      if (act === "oit") {
        const [, , k, d] = data.split(":");
        const items = JSON.parse(o.items);
        const it = items[+k];
        if (!it) return ctx.answerCbQuery();
        it.qty += +d;
        if (it.qty <= 0) items.splice(+k, 1);
        if (!items.length) return ctx.answerCbQuery("Нельзя убрать всё — лучше нажми «❌ Отменён»");
        const total = items.reduce((a, i) => a + i.price * i.pack * i.qty, 0);
        db.prepare("UPDATE orders SET items=?, total_kzt=?, shown_total=? WHERE id=?").run(JSON.stringify(items), total, shownFor(o, total), o.id);
        changed.add(o.id);
        const u = getOrder(o.id);
        await edit(orderCaption(u) + "\n\n✏️ Уменьши количество или убери позиции, которых нет:", editKb(u));
        return ctx.answerCbQuery(`Итого: ${fmt(total)} ₸`);
      }
      if (act === "oek") {
        await edit(orderCaption(o), statusKb(o));
        if (changed.has(o.id) && o.tg_user_id) {
          changed.delete(o.id);
          bot.telegram.sendMessage(o.tg_user_id, `✏️ Заказ №${o.id} уточнён по наличию:\n\n${orderLines(o)}\n\nИтого: ${fmt(o.total_kzt)} ₸${altText(o)}`).catch(() => {});
          return ctx.answerCbQuery("Клиенту отправлен обновлённый заказ");
        }
        changed.delete(o.id);
        return ctx.answerCbQuery(o.tg_user_id ? "Изменений не было" : "Сохранено (клиент не в Telegram — напиши ему в WhatsApp)");
      }
      if (act === "inv") {
        const kz = !o.buyer_country || o.buyer_country === "KZ";
        if (!getSetting(kz ? "pay_kz" : "pay_cis") && !getSetting("pay_kz")) {
          await ctx.answerCbQuery();
          return ctx.reply("Сначала добавь реквизиты:\n/pay kz Kaspi: +7 … (Имя Ф.)\n/pay cis Перевод на карту Kaspi … или Золотая Корона …");
        }
        const text = invoiceText(o);
        let sent = false;
        if (o.tg_user_id) { try { await bot.telegram.sendMessage(o.tg_user_id, text); sent = true; } catch (e) { /* клиент не запускал бота */ } }
        db.prepare("UPDATE orders SET status='invoiced' WHERE id=? AND status IN ('pending','contacted')").run(o.id);
        const u = getOrder(o.id);
        await edit(orderCaption(u), statusKb(u));
        await ctx.answerCbQuery(sent ? "Счёт отправлен клиенту в Telegram" : "Отправь счёт в WhatsApp");
        return ctx.reply((sent ? "✅ Счёт отправлен клиенту в Telegram. Можно продублировать в WhatsApp:" : "Клиент не в Telegram — отправь счёт в WhatsApp одной кнопкой:"),
          Markup.inlineKeyboard([[Markup.button.url("💬 Отправить счёт в WhatsApp", waLink(o.phone, text))]]));
      }
    }

    if (act === "status") {
      if (!STATUS_LABELS[extra]) return ctx.answerCbQuery();
      db.prepare("UPDATE orders SET status=? WHERE id=?").run(extra, id);
      const o = db.prepare("SELECT * FROM orders WHERE id=?").get(id);
      if (o) {
        try {
          if (msg.photo || msg.document) await ctx.editMessageCaption(`🧾 ${STATUS_LABELS[o.status]} · заказ №${o.id}\n👤 ${o.name} · ${o.phone}\n💰 ${fmt(o.total_kzt)} ₸`, statusKb(o));
          else await ctx.editMessageText(orderCaption(o), statusKb(o));
        } catch (e) { /* not modified */ }
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
