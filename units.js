// units.js — единицы, за которые указана цена (шт, коробка, набор, пара)
const UNITS = {
  pcs: { label: "шт", per: "за штуку", forms: ["шт", "шт", "шт"] },
  box: { label: "коробка", per: "за коробку", forms: ["коробка", "коробки", "коробок"] },
  set: { label: "набор", per: "за набор", forms: ["набор", "набора", "наборов"] },
  pair: { label: "пара", per: "за пару", forms: ["пара", "пары", "пар"] }
};
const ORDER = ["pcs", "box", "set", "pair"];
const plural = (n, [a, b, c]) => (n % 10 === 1 && n % 100 !== 11 ? a : [2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100) ? b : c);
const unitOf = (k) => UNITS[k] || UNITS.pcs;

// единица по тексту поста: сначала строка цены («650тг / шт», «за коробку»), потом название
function detectUnit(priceLine, name) {
  const m = (priceLine || "").toLowerCase().match(/(?:за|\/)\s*(?:\d+\s*)?(коробк|набор|пар|шт|штук)/);
  if (m) return m[1].startsWith("коробк") ? "box" : m[1] === "набор" ? "set" : m[1] === "пар" ? "pair" : "pcs";
  const n = (name || "").toLowerCase();
  if (/коробк/.test(n)) return "box";
  if (/(^|\s)набор/.test(n)) return "set";
  return "pcs";
}

module.exports = { UNITS, ORDER, plural, unitOf, detectUnit };
