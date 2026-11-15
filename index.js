require("dotenv").config();
const path = require("path");
const express = require("express");
const { bot, WEBAPP_URL, ALLOWED_UPDATES } = require("./bot");
require("./rates").startAutoRefresh();

const app = express();
app.use(express.json({ limit: "200kb" }));

app.use(require("./routes/catalog"));
app.use(require("./routes/orders"));
app.use(express.static(path.join(__dirname, "public"), { setHeaders: (res, p) => p.endsWith(".html") && res.set("Cache-Control", "no-cache") }));
app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
// адрес для вебхука: WEBHOOK_URL или домен Railway (подставляется сам)
const WEBHOOK_URL = process.env.WEBHOOK_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? `https://${process.env.RAILWAY_PUBLIC_DOMAIN}` : "");

async function start() {
  if (bot) {
    if (WEBHOOK_URL) {
      const hookPath = "/bot-webhook";
      app.use(bot.webhookCallback(hookPath));
      await bot.telegram.setWebhook(WEBHOOK_URL + hookPath, { allowed_updates: ALLOWED_UPDATES });
      console.log("[bot] webhook:", WEBHOOK_URL + hookPath);
    } else {
      bot.launch({ allowedUpdates: ALLOWED_UPDATES });
      console.log("[bot] long polling (локально)");
    }
    if (WEBAPP_URL) {
      bot.telegram.setChatMenuButton({ menuButton: { type: "web_app", text: "Каталог", web_app: { url: WEBAPP_URL } } })
        .catch((e) => console.warn("[bot] menu button:", e.message));
    }
  }
  app.listen(PORT, () => console.log(`[server] порт ${PORT}, каталог: ${WEBAPP_URL || "(нет домена)"}, база: ${require("./db").DB_PATH}`));
}

start();
process.once("SIGINT", () => { if (bot && !WEBHOOK_URL) bot.stop("SIGINT"); process.exit(0); });
process.once("SIGTERM", () => { if (bot && !WEBHOOK_URL) bot.stop("SIGTERM"); process.exit(0); });
