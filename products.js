// products.js — товары: импорт из постов канала, изменения, выдача в API
const db = require("./db");
const { parseCaption } = require("./parse");
const { BY_KEY } = require("./categories");

const NEW_DAYS = 10;
const newId = () => "p_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

function get(id) {
  return db.prepare("SELECT * FROM products WHERE id = ?").get(id);
}

/**
 * Импорт/обновление товара из поста.
 * post = { source, mediaGroupId, caption, photos: [file_id] }
 * Альбом приходит несколькими сообщениями: склеиваем их по media_group_id.
 * Возвращает { product, created, parsed } или null, если это не товар.
 */
function importPost(post) {
  const now = Date.now();
  let row = null;
  if (post.mediaGroupId) row = db.prepare("SELECT * FROM products WHERE media_group_id = ?").get(post.mediaGroupId);
  if (!row && post.source) row = db.prepare("SELECT * FROM products WHERE source = ?").get(post.source);

  if (row) {
    const photos = JSON.parse(row.photos || "[]");
    for (const p of post.photos || []) if (!photos.includes(p)) photos.push(p);
    const caption = post.caption && post.caption.trim() ? post.caption : row.caption;
    const fields = { photos: JSON.stringify(photos.slice(0, 10)), caption, updated_at: now, id: row.id };
    if (post.caption && post.caption.trim() && post.caption !== row.caption) {
      const p = parseCaption(caption);
      Object.assign(fields, {
        name: p.name || row.name, description: p.description, price_per_unit: p.price ?? row.price_per_unit,
        pack_qty: p.pack, sizes: JSON.stringify(p.sizes), colors: JSON.stringify(p.colors), country: p.country,
        category: p.category || row.category
      });
      // hidden: 0 — виден, 1 — скрыт автоматически (не хватает данных), 2 — скрыт админом
      fields.hidden = row.hidden === 2 ? 2 : (fields.category && fields.price_per_unit && photos.length ? 0 : 1);
      db.prepare(`UPDATE products SET name=@name, description=@description, price_per_unit=@price_per_unit, pack_qty=@pack_qty,
        sizes=@sizes, colors=@colors, country=@country, category=@category, photos=@photos, caption=@caption, hidden=@hidden, updated_at=@updated_at WHERE id=@id`).run(fields);
      return { product: get(row.id), created: false, parsed: p, captionChanged: true };
    }
    fields.hidden = row.hidden === 1 && row.category && row.price_per_unit && photos.length ? 0 : row.hidden;
    db.prepare("UPDATE products SET photos=@photos, caption=@caption, hidden=@hidden, updated_at=@updated_at WHERE id=@id").run(fields);
    return { product: get(row.id), created: false, parsed: null, captionChanged: false };
  }

  const caption = post.caption || "";
  const p = parseCaption(caption);
  if (!(post.photos || []).length && !p.price) return null; // ни фото, ни цены — это не товар (объявление и т.п.)
  const id = newId();
  // без категории или без цены товар скрыт, пока админ не поправит
  const hidden = !p.category || !p.price || !(post.photos || []).length ? 1 : 0;
  db.prepare(`INSERT INTO products (id,name,category,description,price_per_unit,pack_qty,sizes,colors,country,in_stock,hidden,photos,source,media_group_id,caption,created_at,updated_at)
    VALUES (@id,@name,@category,@description,@price,@pack,@sizes,@colors,@country,1,@hidden,@photos,@source,@mg,@caption,@now,@now)`).run({
    id, name: p.name || "Товар", category: p.category, description: p.description, price: p.price, pack: p.pack,
    sizes: JSON.stringify(p.sizes), colors: JSON.stringify(p.colors), country: p.country, hidden,
    photos: JSON.stringify((post.photos || []).slice(0, 10)), source: post.source || null, mg: post.mediaGroupId || null, caption, now
  });
  return { product: get(id), created: true, parsed: p };
}

function update(id, fields) {
  const allowed = ["category", "price_per_unit", "pack_qty", "in_stock", "hidden", "name", "admin_msg_id"];
  const sets = Object.keys(fields).filter((k) => allowed.includes(k));
  if (!sets.length) return get(id);
  db.prepare(`UPDATE products SET ${sets.map((k) => `${k}=@${k}`).join(", ")}, updated_at=@u WHERE id=@id`).run({ ...fields, u: Date.now(), id });
  const r = get(id);
  if (r && r.hidden === 1 && r.category && r.price_per_unit && JSON.parse(r.photos || "[]").length) db.prepare("UPDATE products SET hidden=0 WHERE id=?").run(id);
  return get(id);
}

function remove(id) {
  db.prepare("DELETE FROM products WHERE id = ?").run(id);
}

// товар можно показывать покупателям?
const isPublic = (r) => !r.hidden && r.category && BY_KEY[r.category] && r.price_per_unit > 0 && JSON.parse(r.photos || "[]").length > 0;

function toJSON(r) {
  const photos = JSON.parse(r.photos || "[]");
  const c = BY_KEY[r.category];
  return {
    id: r.id, name: r.name, section: c ? c.section : null, category: r.category, description: r.description || "",
    price: r.price_per_unit, pack: r.pack_qty, sizes: JSON.parse(r.sizes || "[]"), colors: JSON.parse(r.colors || "[]"),
    country: r.country || "", inStock: !!r.in_stock, isNew: Date.now() - r.created_at < NEW_DAYS * 86400e3,
    photos: photos.map((_, i) => `/photo/${r.id}/${i}`), createdAt: r.created_at
  };
}

function listPublic() {
  return db.prepare("SELECT * FROM products ORDER BY in_stock DESC, created_at DESC").all().filter(isPublic).map(toJSON);
}

module.exports = { importPost, update, remove, get, toJSON, listPublic, isPublic };
