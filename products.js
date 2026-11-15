// products.js — товары: импорт из постов канала, изменения, выдача в API
// media — список фото и видео поста по порядку: [{t:"p"|"v", id, uid, th?, size?}]
// photos — производный список картинок (фото + обложки видео) для карточек и превью
const db = require("./db");
const { parseCaption } = require("./parse");
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

const complete = (r) => r.category && BY_KEY[r.category] && r.price_per_unit > 0 && JSON.parse(r.photos || "[]").length > 0;

/**
 * Импорт/обновление товара из поста.
 * post = { source, mediaGroupId, caption, media: [{t, id, uid, th, size}] }
 * Возвращает { product, created, captionChanged, mediaChanged } или null, если это не товар.
 */
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
    }
    // hidden: 0 — виден, 1 — скрыт автоматически (не хватает данных), 2 — скрыт админом
    f.hidden = row.hidden === 2 ? 2 : complete(f) ? 0 : 1;
    db.prepare(`UPDATE products SET name=@name, description=@description, price_per_unit=@price_per_unit, pack_qty=@pack_qty, sizes=@sizes,
      colors=@colors, country=@country, category=@category, unit=@unit, photos=@photos, media=@media, caption=@caption, hidden=@hidden,
      updated_at=@updated_at WHERE id=@id`).run(f);
    return { product: get(row.id), created: false, captionChanged, mediaChanged };
  }

  const caption = post.caption || "";
  const p = parseCaption(caption);
  if (!incoming.length && !p.price) return null; // ни фото, ни цены — это не товар (объявление и т.п.)
  const media = incoming.slice(0, MAX_MEDIA);
  const photos = derivePhotos(media);
  const id = newId();
  const f = {
    id, name: p.name || "Товар", category: p.category, description: p.description, price_per_unit: p.price, pack_qty: p.pack,
    sizes: JSON.stringify(p.sizes), colors: JSON.stringify(p.colors), country: p.country, unit: p.unit,
    photos: JSON.stringify(photos), media: JSON.stringify(media), source: post.source || null, media_group_id: post.mediaGroupId || null,
    caption, created_at: now, updated_at: now
  };
  f.hidden = complete(f) ? 0 : 1;
  db.prepare(`INSERT INTO products (id,name,category,description,price_per_unit,pack_qty,sizes,colors,country,unit,in_stock,hidden,photos,media,source,media_group_id,caption,created_at,updated_at)
    VALUES (@id,@name,@category,@description,@price_per_unit,@pack_qty,@sizes,@colors,@country,@unit,1,@hidden,@photos,@media,@source,@media_group_id,@caption,@created_at,@updated_at)`).run(f);
  return { product: get(id), created: true, captionChanged: false, mediaChanged: true };
}

function update(id, fields) {
  const allowed = ["category", "price_per_unit", "pack_qty", "in_stock", "hidden", "name", "admin_msg_id", "unit"];
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
    price: r.price_per_unit, pack: r.pack_qty, unit: { key: r.unit || "pcs", ...u }, sizes: JSON.parse(r.sizes || "[]"),
    colors: JSON.parse(r.colors || "[]"), country: r.country || "", inStock: !!r.in_stock,
    isNew: Date.now() - r.created_at < NEW_DAYS * 86400e3, photos: photos.map((_, i) => `/photo/${r.id}/${i}`), media,
    hasVideo: media.some((m) => m.type === "video"), createdAt: r.created_at
  };
}

function listPublic() {
  return db.prepare("SELECT * FROM products ORDER BY in_stock DESC, created_at DESC").all().filter(isPublic).map(toJSON);
}

const packText = (r) => `${r.pack_qty} ${plural(r.pack_qty, unitOf(r.unit).forms)}`;

module.exports = { importPost, update, remove, get, toJSON, listPublic, isPublic, mediaOf, packText, VIDEO_MAX };
