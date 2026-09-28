// auth.js — простая защита админских ручек одним общим секретом
// (ADMIN_SECRET в переменных окружения). Мини-App шлёт его в
// заголовке X-Admin-Secret после того, как администратор один раз
// ввёл пароль в самом приложении.
//
// Это осознанно упрощённый вариант для старта. Более правильный
// способ для настоящего Telegram Mini App — проверять initData,
// которую Telegram подписывает и передаёт каждому открытию
// приложения (тогда не нужен отдельный пароль вообще, личность
// администратора подтверждает сам Telegram). Это можно добавить
// позже без изменения остальной части API — достаточно заменить
// requireAdmin().

function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    return res.status(500).json({ error: "ADMIN_SECRET не задан на сервере" });
  }
  const provided = req.get("X-Admin-Secret");
  if (provided !== secret) {
    return res.status(401).json({ error: "неверный пароль администратора" });
  }
  next();
}

module.exports = { requireAdmin };
