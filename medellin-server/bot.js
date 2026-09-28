const { Telegraf, Markup } = require("telegraf");
const db = require("./db");

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

let bot = null;
if (BOT_TOKEN) {
  bot = new Telegraf(BOT_TOKEN);
} else {
  console.warn("[bot] BOT_TOKEN не задан — уведомления администратору работать не будут.");
}

const STATUS_LABELS = {
  pending: "⏳ Ожидает",
  paid: "✅ Оплата получена",
  unpaid: "❌ Не оплачено",
  shipped: "📦 Отправлен"
};

const COUNTRY_FLAGS = { KZ: "🇰🇿", KG: "🇰🇬", UZ: "🇺🇿", TJ: "🇹🇯", RU: "🇷🇺" };

function fmt(n) {
  return Math.round(n).toLocaleString("ru-RU");
}

function orderCaption(order) {
  const items = JSON.parse(order.items);
  const itemsText = items
    .map((i) => `• ${i.name}${i.size || i.color ? ` (${[i.size, i.color].filter(Boolean).join(", ")})` : ""} × ${i.qty} уп. — ${fmt(i.packPrice * i.qty)} ₸`)
    .join("\n");

  const flag = COUNTRY_FLAGS[order.country] || "";
  let text = `${flag} Новый заказ №${order.id}\n\n`;
  text += `Статус: ${STATUS_LABELS[order.status] || order.status}\n\n`;
  text += `Клиент: ${order.name || "—"}\n`;
  text += `Телефон: ${order.phone || "—"}\n`;
  text += `Город: ${order.city || "—"}\n\n`;
  text += `${itemsText}\n\n`;
  text += `Итого: ${fmt(order.total_kzt)} ₸`;
  if (order.total_converted) {
    text += `\nПоказано клиенту: ≈ ${fmt(order.total_converted)}`;
    if (order.rate_used) text += ` (курс ${order.rate_used})`;
  }
  text += `\nОплата: ${order.payment_method}`;
  return text;
}

function statusKeyboard(orderId) {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("✅ Оплата получена", `status:${orderId}:paid`),
      Markup.button.callback("❌ Не оплачено", `status:${orderId}:unpaid`)
    ],
    [Markup.button.callback("📦 Отправлен", `status:${orderId}:shipped`)]
  ]);
}

async function notifyNewOrder(order) {
  if (!bot || !ADMIN_CHAT_ID) return;
  try {
    const caption = orderCaption(order);
    let sent;
    if (order.receipt_photo) {
      // receipt_photo — data URL (base64); Telegraf может отправить Buffer
      const base64 = order.receipt_photo.split(",")[1];
      const buffer = Buffer.from(base64, "base64");
      sent = await bot.telegram.sendPhoto(
        ADMIN_CHAT_ID,
        { source: buffer },
        { caption, reply_markup: statusKeyboard(order.id).reply_markup }
      );
    } else {
      sent = await bot.telegram.sendMessage(ADMIN_CHAT_ID, caption, statusKeyboard(order.id));
    }
    db.prepare("UPDATE orders SET telegram_chat_id = ?, telegram_message_id = ? WHERE id = ?")
      .run(sent.chat.id, sent.message_id, order.id);
  } catch (e) {
    console.error("[bot] Не удалось отправить уведомление о заказе:", e.message);
  }
}

async function updateOrderMessage(order) {
  if (!bot || !order.telegram_chat_id || !order.telegram_message_id) return;
  try {
    const caption = orderCaption(order);
    if (order.receipt_photo) {
      await bot.telegram.editMessageCaption(order.telegram_chat_id, order.telegram_message_id, undefined, caption, {
        reply_markup: statusKeyboard(order.id).reply_markup
      });
    } else {
      await bot.telegram.editMessageText(order.telegram_chat_id, order.telegram_message_id, undefined, caption, {
        reply_markup: statusKeyboard(order.id).reply_markup
      });
    }
  } catch (e) {
    // сообщение могли удалить вручную — не критично
    console.warn("[bot] Не удалось обновить сообщение заказа:", e.message);
  }
}

if (bot) {
  bot.on("callback_query", async (ctx) => {
    const data = ctx.callbackQuery.data || "";
    const [, orderId, status] = data.split(":");
    if (!orderId || !STATUS_LABELS[status]) return ctx.answerCbQuery();

    db.prepare("UPDATE orders SET status = ? WHERE id = ?").run(status, orderId);
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (order) await updateOrderMessage(order);
    await ctx.answerCbQuery("Статус обновлён: " + STATUS_LABELS[status]);
  });

  bot.catch((err) => console.error("[bot] Ошибка:", err));
}

module.exports = { bot, notifyNewOrder, updateOrderMessage };
