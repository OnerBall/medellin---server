require("dotenv").config();
const path = require("path");
const express = require("express");
const cors = require("cors");
const { bot } = require("./bot");

const app = express();
app.use(cors());
app.use(express.json({ limit: "15mb" })); // фото (base64) занимают место

app.use("/api", require("./routes/catalog"));
app.use("/api", require("./routes/orders"));

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
const WEBHOOK_URL = process.env.WEBHOOK_URL; // напр. https://your-app.up.railway.app

async function start() {
  if (bot) {
    if (WEBHOOK_URL) {
      const webhookPath = "/bot-webhook";
      app.use(bot.webhookCallback(webhookPath));
      await bot.telegram.setWebhook(WEBHOOK_URL + webhookPath);
      console.log("[bot] webhook установлен:", WEBHOOK_URL + webhookPath);
    } else {
      bot.launch();
      console.log("[bot] запущен в режиме long polling (локальная разработка)");
    }
  }

  app.listen(PORT, () => console.log(`[server] слушает порт ${PORT}`));
}

start();

process.once("SIGINT", () => { if (bot) bot.stop("SIGINT"); process.exit(0); });
process.once("SIGTERM", () => { if (bot) bot.stop("SIGTERM"); process.exit(0); });
