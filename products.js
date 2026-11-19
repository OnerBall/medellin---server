// products.js — товары: импорт из постов канала, изменения, выдача в API
// media — список фото и видео поста по порядку: [{t:"p"|"v", id, uid, th?, size?}]
// photos — производный список картинок (фото + обложки видео) для карточек и превью
const db = require("./db");
// видеообзоры, пришедшие раньше самого товара: прикрепятся, когда товар появится
db.exec("CREATE TABLE IF NOT EXISTS pending_reviews (code TEXT NOT NULL, media TEXT NOT NULL, created_at INTEGER NOT NULL)");
// расцветки: pick — клиент выбирает цвет по фото, skip1 — то же, но 1-е фото общее, mix — цвета в пачке вперемешку
try { db.exec("ALTER TABLE products ADD COLUMN color_mode TEXT"); } catch (e) { /* уже есть */ }
const MIX_RE = /(разн[а-яё]*|микс|ассорти|разноцветн[а-яё]*)\s+(цвет|расцвет)|(цвет[а-яё]*|расцветк[а-яё]*)\s*[:\-–]?\s*(микс|ассорти|разные)|в\s+ассортименте/i;
try { db.exec("ALTER TABLE products ADD COLUMN color_photos TEXT"); } catch (e) { /* уже есть */ }
try { db.exec("ALTER TABLE products ADD COLUMN color_names TEXT"); } catch (e) { /* уже есть */ }
try { db.exec("ALTER TABLE products ADD COLUMN price_rules TEXT"); } catch (e) { /* уже есть */ }
try { db.exec("ALTER TABLE products ADD COLUMN size_mode TEXT"); } catch (e) { /* уже есть */ }
// «В упаковке 12шт разные размеры» — размеры идут вперемешку в пачке, клиент размер не выбирает
const SIZE_MIX_RE = /разн[а-яё]*\s+размер|размер[а-яё]*\s*[:\-–]?\s*(микс|ассорти|разные|вперемешку)|микс\s+размер|ассорти\s+размер|размерн[а-яё]*\s+ряд\s+в\s+упаков/i;
const sizeMix = (r) => (r.size_mode ? r.size_mode === "mix" : SIZE_MIX_RE.test(r.caption || ""));
const nc = (s) => String(s || "").toLowerCase().replace(/ё/g, "е").trim();
// цена за штуку для конкретного размера и цвета (самое точное правило выигрывает)
function varPrice(r, size, colorLabel) {
  const base = effPrice(r);
  const rules = jarr(r.price_rules) || [];
  if (!rules.length) return base;
  const c = nc(colorLabel), z = String(size || "").toUpperCase();
  let best = null, score = -1;
  for (const ru of rules) {
    if (ru.c && !(c && ru.c.map(nc).includes(c))) continue;
    if (ru.s && !(z && (ru.s.includes(z) || ru.s.includes(z.split(/[\s(]/)[0])))) continue;
    const sc = (ru.c ? 1 : 0) + (ru.s ? 2 : 0);
    if (sc >= score) { score = sc; best = ru; }
  }
  if (!best) return base;
  return onSale(r) ? Math.round(best.p * r.sale_price / r.price_per_unit) : best.p;
}
const colorMode = (r) => r.color_mode || (MIX_RE.test(r.caption || "") ? "mix" : "pick");
const colorFrom = (r) => (colorMode(r) === "skip1" ? 1 : 0);
// варианты расцветок для покупателя: [{ k, label, photo }]
//  names — цвета словами (все цвета на одном фото), pick/skip1 — по фото (можно отметить только нужные фото), mix — без выбора
const jarr = (s) => { try { const a = JSON.parse(s || "null"); return Array.isArray(a) ? a : null; } catch (e) { return null; } };
function colorOpts(r) {
  const mode = colorMode(r);
  if (mode === "mix") return [];
  const names = jarr(r.color_names) || [];
  if (mode === "names") return names.map((label, k) => ({ k, label: String(label), photo: null }));
  const media = mediaOf(r);
  const n = media ? media.filter((m) => m.t === "p").length : (jarr(r.photos) || []).length;
  // одно фото со всеми цветами, а в посте перечислены цвета («Цвета: чёрный, розовый…») — выбор по названиям
  const listed = (jarr(r.colors) || []).map((c) => (typeof c === "string" ? c : c && c.name)).filter(Boolean);
  const cap = (s) => s[0].toUpperCase() + s.slice(1);
  if (!r.color_mode && listed.length > 1 && n !== listed.length) return listed.map((label, k) => ({ k, label: cap(label), photo: null }));
  // цветов столько же, сколько фото — подписываем фото названиями цветов
  if (!r.color_mode && listed.length > 1 && n === listed.length && !jarr(r.color_photos)) return listed.map((label, k) => ({ k, label: cap(label), photo: k }));
  const chosen = jarr(r.color_photos);
  const idx = (chosen || Array.from({ length: Math.max(0, n - colorFrom(r)) }, (_, i) => i + colorFrom(r))).filter((i) => Number.isInteger(i) && i >= 0 && i < n);
  return idx.map((i, j) => ({ k: i, label: `Расцветка №${j + 1}`, photo: i }));
}
const codeRe = (code) => new RegExp(`(^|[^0-9a-zа-я])${code.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9a-zа-я]|$)`, "i");
const { parseCaption } = require("./parse");
// товары, загруженные до того, как бот научился читать «Черный: S M L» — дочитываем размеры и цвета из подписи
// (и детские размеры «3/4 5/6 7/8», «1 2 3 4», которые раньше читались не полностью — например, только «11/12»)
for (const r of db.prepare("SELECT id, caption, sizes, colors FROM products WHERE caption IS NOT NULL AND caption != ''").all()) {
  try { const p = parseCaption(r.caption), old = JSON.parse(r.sizes || "[]"); if (p.sizes.length > old.length && (old.length <= 1 || old.every((z) => p.sizes.includes(z)))) db.prepare("UPDATE products SET sizes=?, colors=? WHERE id=?").run(JSON.stringify(p.sizes), JSON.stringify(p.colors.length ? p.colors : JSON.parse(r.colors || "[]")), r.id); } catch (e) { /* пропускаем */ }
}
// цены по цвету/размеру для уже загруженных товаров
for (const r of db.prepare("SELECT id, caption, colors, color_mode FROM products WHERE price_rules IS NULL AND caption LIKE '%тг%'").all()) {
  try {
    const p = parseCaption(r.caption);
    if (!p.priceRules.length) continue;
    const old = JSON.parse(r.colors || "[]");
    db.prepare("UPDATE products SET price_rules=?, price_per_unit=?, sizes=?, colors=? WHERE id=?").run(JSON.stringify(p.priceRules), p.price, JSON.stringify(p.sizes), JSON.stringify(old.length && !r.color_mode ? old : p.colors.length ? p.colors : old), r.id);
  } catch (e) { /* пропускаем */ }
}
const { BY_KEY } = require("./categories");
const { unitOf, plural, detectUnit } = require("./units");

const NEW_DAYS = 10;
const MAX_MEDIA = 10;
const VIDEO_MAX = 20 * 1024 * 1024; // Telegram отдаёт ботам файлы до 20 МБ
const newId = () => "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// старые товары без единицы — определяем по их тексту
for (const r of db.prepare("SELECT id, caption, name FROM products WHERE unit IS NULL").all()) {
  const p = parseCaption(r.caption || "");
  db.prepare("UPDATE products SET unit=? WHERE id=?").run(p.unit || detectUnit("", r.name), r.id);
}

// товары без категории — пробуем определить снова (после добавления новых категорий)
{
  const { detect } = require("./categories");
  for (const r of db.prepare("SELECT id, caption, name, price_per_unit, photos FROM products WHERE category IS NULL").all()) {
    const p = parseCaption(r.caption || "");
    const cat = p.category || detect([], r.name);
    if (cat) db.prepare("UPDATE products SET category=?, hidden=CASE WHEN hidden=1 AND price_per_unit>0 AND photos!='[]' THEN 0 ELSE hidden END WHERE id=?").run(cat, r.id);
  }
}

function get(id) {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id);
}

const mediaOf = (r) => { try { return JSON.parse(r.media || "null"); } catch (e) { return null; } };

// картинки: сначала настоящие фото, потом обложки видео
function derivePhotos(media) {
  return [...media.filter((m) => m.t === "p").map((m) => m.id), ...media.filter((m) => m.t === "v" && m.th).map((m) => m.th)].slice(0, MAX_MEDIA);
}

function mergeMedia(row, incoming) {
  const old = row ? mediaOf(row) : null;
  if (!old) return incoming.length ? incoming.slice(0, MAX_MEDIA) : null; // старый товар без media — берём новый набор целиком
  const uids = new Set(old.map((m) => m.uid));
  return [...old, ...incoming.filter((m) => !uids.has(m.uid))].slice(0, MAX_MEDIA);
}

// распродажа: цена со скидкой, если она меньше обычной
const onSale = (r) => r.sale_price > 0 && r.price_per_unit > 0 && r.sale_price < r.price_per_unit;
const effPrice = (r) => (onSale(r) ? r.sale_price : r.price_per_unit);
const complete = (r) => r.category && BY_KEY[r.category] && r.price_per_unit > 0 && JSON.parse(r.photos || "[]").length > 0;

/**
 * Импорт/обновление товара из поста.
 * post = { source, mediaGroupId, caption, media: [{t, id, uid, th, size}] }
 * Возвращает { product, created, captionChanged, mediaChanged } или null, если это не товар.
 */
function attachReview(caption, incoming, now) {
  const words = caption.replace(/#[^\s]+/g, " ").split(/[\s,.;:!]+/).filter(Boolean);
  const code = [...words].reverse().find((w) => /\d/.test(w)) || "";
  if (!code) return { skipped: "nocode" };
  const row = db.prepare("SELECT * FROM products WHERE lower(name) LIKE ? ORDER BY created_at DESC").all(`%${code.toLowerCase()}%`).find((r) => codeRe(code).test(r.name));
  if (!row) {
    const old = db.prepare("SELECT rowid, media FROM pending_reviews WHERE code = ?").get(code);
    const uids = new Set(old ? JSON.parse(old.media).map((m) => m.uid) : []);
    const media = [...(old ? JSON.parse(old.media) : []), ...incoming.filter((m) => !uids.has(m.uid))];
    if (old) db.prepare("UPDATE pending_reviews SET media = ? WHERE rowid = ?").run(JSON.stringify(media), old.rowid);
    else db.prepare("INSERT INTO pending_reviews (code, media, created_at) VALUES (?, ?, ?)").run(code, JSON.stringify(media), now);
    return { skipped: "pending", code };
  }
  const media = mergeMedia(row, incoming);
  db.prepare("UPDATE products SET media=?, photos=?, updated_at=? WHERE id=?").run(JSON.stringify(media), JSON.stringify(derivePhotos(media)), now, row.id);
  return { product: get(row.id), created: false, captionChanged: false, mediaChanged: true, review: true };
}

function importPost(post) {
  const now = Date.now();
  const incoming = post.media || [];
  let row = null;
  if (post.mediaGroupId) row = db.prepare("SELECT * FROM products WHERE media_group_id = ?").get(post.mediaGroupId);
  if (!row && post.source) row = db.prepare("SELECT * FROM products WHERE source = ?").get(post.source);

  if (row) {
    const media = mergeMedia(row, incoming);
    const photos = media ? derivePhotos(media) : JSON.parse(row.photos || "[]");
    const mediaChanged = JSON.stringify(media) !== (row.media || "null");
    const caption = post.caption && post.caption.trim() ? post.caption : row.caption;
    const f = { ...row, photos: JSON.stringify(photos), media: media ? JSON.stringify(media) : row.media, caption, updated_at: now };
    const captionChanged = !!(post.caption && post.caption.trim() && post.caption !== row.caption);
    if (captionChanged) {
      const p = parseCaption(caption);
      Object.assign(f, {
        name: p.name || row.name, description: p.description, price_per_unit: p.price ?? row.price_per_unit, pack_qty: p.pack,
        sizes: JSON.stringify(p.sizes), colors: JSON.stringify(p.colors), country: p.country, category: p.category || row.category, unit: p.unit
      });
      if (p.salePrice) f.sale_price = p.salePrice;
      f.price_rules = p.priceRules.length ? JSON.stringify(p.priceRules) : null;
    }
    // повторная пересылка того же поста: дотягиваем то, что бот раньше не умел распознать
    // (скидку, название вместо «СКИДКА», категорию) — ручные правки админа не трогаем
    let fixed = false;
    if (!captionChanged && caption) {
      const p = parseCaption(caption);
      if (p.salePrice && !(row.sale_price > 0)) { f.sale_price = p.salePrice; if (p.price) f.price_per_unit = p.price; fixed = true; }
      if (p.name && /^(скидк|акци|распрод|sale|новинк|new|товар$)/i.test(row.name || "")) { f.name = p.name; fixed = true; }
      if (p.category && !row.category) { f.category = p.category; fixed = true; }
    }
    // hidden: 0 — виден, 1 — скрыт автоматически (не хватает данных), 2 — скрыт админом
    f.hidden = row.hidden === 2 ? 2 : complete(f) ? 0 : 1;
    db.prepare(`UPDATE products SET name=@name, description=@description, price_per_unit=@price_per_unit, pack_qty=@pack_qty, sizes=@sizes,
      colors=@colors, country=@country, category=@category, unit=@unit, photos=@photos, media=@media, caption=@caption, hidden=@hidden,
      sale_price=@sale_price, price_rules=@price_rules, updated_at=@updated_at WHERE id=@id`).run({ price_rules: row.price_rules, ...f });
    return { product: get(row.id), created: false, captionChanged: captionChanged || fixed, mediaChanged };
  }

  const caption = post.caption || "";
  // видеообзор к уже загруженному товару: подпись «#обзор 010» → видео добавляется к товару с «010» в названии
  if (/#(обзор|видеообзор|видео)(?![а-яёa-z])/i.test(caption) && incoming.length) return attachReview(caption, incoming, now);
  // фото/видео совсем без подписи — это не новый товар, пропускаем
  if (!caption.replace(/#[^\s]+/g, "").trim()) return { skipped: "nocaption" };
  const p = parseCaption(caption);
  if (!incoming.length && !p.price) return null; // ни фото, ни цены — это не товар (объявление и т.п.)
  const media = incoming.slice(0, MAX_MEDIA);
  const photos = derivePhotos(media);
  const id = newId();
  const f = {
    id, name: p.name || "Товар", category: p.category, description: p.description, price_per_unit: p.price, pack_qty: p.pack,
    sizes: JSON.stringify(p.sizes), colors: JSON.stringify(p.colors), country: p.country, unit: p.unit, sale_price: p.salePrice || null, price_rules: p.priceRules.length ? JSON.stringify(p.priceRules) : null,
    photos: JSON.stringify(photos), media: JSON.stringify(media), source: post.source || null, media_group_id: post.mediaGroupId || null,
    caption, created_at: now, updated_at: now
  };
  f.hidden = complete(f) ? 0 : 1;
  db.prepare(`INSERT INTO products (id,name,category,description,price_per_unit,pack_qty,sizes,colors,country,unit,sale_price,price_rules,in_stock,hidden,photos,media,source,media_group_id,caption,created_at,updated_at)
    VALUES (@id,@name,@category,@description,@price_per_unit,@pack_qty,@sizes,@colors,@country,@unit,@sale_price,@price_rules,1,@hidden,@photos,@media,@source,@media_group_id,@caption,@created_at,@updated_at)`).run(f);
  // ждал ли этот товар видеообзор?
  for (const pr of db.prepare("SELECT rowid, code, media FROM pending_reviews").all()) {
    if (!codeRe(pr.code).test(f.name)) continue;
    const cur = get(id), media2 = mergeMedia(cur, JSON.parse(pr.media));
    db.prepare("UPDATE products SET media=?, photos=?, hidden=? WHERE id=?").run(JSON.stringify(media2), JSON.stringify(derivePhotos(media2)), cur.hidden, id);
    db.prepare("DELETE FROM pending_reviews WHERE rowid = ?").run(pr.rowid);
  }
  return { product: get(id), created: true, captionChanged: false, mediaChanged: true };
}

function update(id, fields) {
  const allowed = ["size_mode", "price_rules", "sizes", "category", "price_per_unit", "pack_qty", "in_stock", "hidden", "name", "admin_msg_id", "unit", "sale_price", "color_mode", "country", "color_photos", "color_names"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return get(id);
  db.prepare(`UPDATE products SET ${sets.map((k) => `${k}=@${k}`).join(", ")}, updated_at=@u WHERE id=@id`).run({ ...fields, u: Date.now(), id });
  const r = get(id);
  if (r && r.hidden === 1 && complete(r)) db.prepare("UPDATE products SET hidden=0 WHERE id=?").run(id);
  return get(id);
}

function remove(id) {
  db.prepare("DELETE FROM products WHERE id = ?").run(id);
}

// товар можно показывать покупателям?
const isPublic = (r) => r.hidden === 0 && !!complete(r);

function mediaList(r) {
  const photos = JSON.parse(r.photos || "[]");
  const media = mediaOf(r);
  if (!media) return photos.map((_, i) => ({ type: "photo", src: `/photo/${r.id}/${i}` }));
  const out = [];
  media.forEach((m, k) => {
    if (m.t === "p") { const i = photos.indexOf(m.id); if (i >= 0) out.push({ type: "photo", src: `/photo/${r.id}/${i}` }); }
    else if (m.t === "v" && (!m.size || m.size <= VIDEO_MAX)) {
      const i = m.th ? photos.indexOf(m.th) : -1;
      out.push({ type: "video", src: `/video/${r.id}/${k}`, poster: i >= 0 ? `/photo/${r.id}/${i}` : "" });
    }
  });
  return out;
}

function toJSON(r) {
  const photos = JSON.parse(r.photos || "[]");
  const c = BY_KEY[r.category];
  const media = mediaList(r);
  const u = unitOf(r.unit);
  return {
    id: r.id, name: r.name, section: c ? c.section : null, category: r.category, description: r.description || "",
    priceRules: (jarr(r.price_rules) || []).map((ru) => ({ c: ru.c, s: ru.s, p: onSale(r) ? Math.round(ru.p * r.sale_price / r.price_per_unit) : ru.p })), price: effPrice(r), oldPrice: onSale(r) ? r.price_per_unit : null, sale: onSale(r) ? Math.round((1 - r.sale_price / r.price_per_unit) * 100) : 0, pack: r.pack_qty, unit: { key: r.unit || "pcs", ...u }, sizes: sizeMix(r) ? [] : JSON.parse(r.sizes || "[]"), sizesInPack: sizeMix(r) ? JSON.parse(r.sizes || "[]") : [],
    colors: JSON.parse(r.colors || "[]"), country: r.country || "", inStock: !!r.in_stock,
    isNew: Date.now() - r.created_at < NEW_DAYS * 86400e3, photos: photos.map((_, i) => `/photo/${r.id}/${i}`), media,
    hasVideo: media.some((m) => m.type === "video"), nPhotos: media.filter((m) => m.type === "photo").length || photos.length, noColors: colorMode(r) === "mix", colorFrom: colorFrom(r), colorOpts: colorOpts(r).map((o) => ({ k: o.k, label: o.label, photo: o.photo === null ? null : photos[o.photo] || null })), createdAt: r.created_at
  };
}

function listPublic() {
  return db.prepare("SELECT * FROM products ORDER BY in_stock DESC, created_at DESC").all().filter(isPublic).map(toJSON);
}

const packText = (r) => `${r.pack_qty} ${plural(r.pack_qty, unitOf(r.unit).forms)}`;

module.exports = { sizeMix, varPrice, colorOpts, colorMode, colorFrom, onSale, effPrice, importPost, update, remove, get, toJSON, listPublic, isPublic, mediaOf, packText, VIDEO_MAX };
