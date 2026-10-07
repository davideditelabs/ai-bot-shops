// Starter driver: Shopify storefronts. The storefront's own predictive search, /search/suggest.json, answers JSON with the products
// (title, handle, price as "3.49", vendor, availability). The price has no currency sign, so this driver adds the one the home page
// declares (Shopify.currency): set CURRENCY below ("EUR" gives "3,49 €").
//
// How to use: copy this folder to shops/<domain>/, replace ORIGIN with the shop's own origin, edit driver.json, and run
//   node tools/check.mjs shops/<domain>   then   node tools/probe.mjs shops/<domain>
// Contract version 1 (see CONTRACT.md): export run(action, params, http); only action "search"; http() reads the shop with GET/HEAD only.
// This file is a port of the platform driver the AI-Bot gate stages for this platform; keep it self-contained (one file, no imports).
// ORIGIN: the shop's own origin, https only, no trailing slash.
const ORIGIN = "https://www.example.com";
// CURRENCY: the ISO code the shop's home page declares in Shopify.currency (EUR, GBP, USD, ...). "" leaves the bare number.
const CURRENCY = "EUR";
// ---- helpers shared by every starter (decode HTML text, read tags and attributes, make absolute addresses) ----
const LIMIT = 40;
const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", pound: "£", cent: "¢", hellip: "…", ndash: "–", mdash: "—", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", times: "×", deg: "°", middot: "·", bull: "•",
  agrave: "à", aacute: "á", acirc: "â", atilde: "ã", auml: "ä", eacute: "é", egrave: "è", ecirc: "ê", iacute: "í", icirc: "î", oacute: "ó", ocirc: "ô", otilde: "õ", ouml: "ö", uacute: "ú", ucirc: "û", uuml: "ü", ccedil: "ç", ntilde: "ñ",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Eacute: "É", Ecirc: "Ê", Iacute: "Í", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Uacute: "Ú", Ccedil: "Ç" };
function decode(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-zA-Z]+);/g, function (m, e) {
    if (e.charAt(0) === "#") {
      const n = e.charAt(1) === "x" || e.charAt(1) === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED, e) ? NAMED[e] : m;
  });
}
/** The text of some HTML: tags dropped, entities decoded, one line. */
function clean(html) {
  return decode(String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}
/** The attributes of a start tag's text, names lower case, values decoded. */
function attrsOf(tag) {
  const out = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  const body = tag.replace(/^<[a-zA-Z][a-zA-Z0-9]*/, "").replace(/\/?>$/, "");
  let m;
  while ((m = re.exec(body))) {
    const k = m[1].toLowerCase();
    if (!(k in out)) out[k] = decode(m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : "");
  }
  return out;
}
function hasToken(attrs, token) {
  return (attrs["class"] || "").split(/\s+/).indexOf(token) >= 0;
}
/** Every start tag among these tag names whose class has one of the tokens, with where it begins and ends and its attributes. */
function startTags(html, names, tokens) {
  const out = [];
  const re = new RegExp("<(?:" + names + ")\\b(?:\"[^\"]*\"|'[^']*'|[^>\"'])*>", "gi");
  let m;
  while ((m = re.exec(html))) {
    const attrs = attrsOf(m[0]);
    if (tokens.some(function (t) { return hasToken(attrs, t); })) out.push({ at: m.index, end: m.index + m[0].length, attrs: attrs, tag: m[0] });
  }
  return out;
}
/** The tag's own text up to its closing tag (no nesting of the same tag is expected: names, prices and links). */
function innerOf(html, start, name) {
  const close = html.toLowerCase().indexOf("</" + name, start.end);
  return close < 0 ? "" : html.slice(start.end, close);
}
function absolute(href) {
  try {
    return new URL(String(href).trim(), ORIGIN).href;
  } catch (e) {
    return "";
  }
}
// ---- this platform's search ----
function money(raw) {
  const n = String(raw === undefined || raw === null ? "" : raw).trim();
  if (!/^\d+(\.\d+)?$/.test(n) || Number(n) === 0) return "";
  if (CURRENCY === "EUR") return n.replace(".", ",") + " €";
  if (CURRENCY === "GBP") return "£" + n;
  if (CURRENCY === "USD") return "$" + n;
  return CURRENCY ? n + " " + CURRENCY : n;
}
export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + "/search/suggest.json?q=" + encodeURIComponent(q) + "&resources%5Btype%5D=product&resources%5Blimit%5D=10" });
  if (r.status !== 200) throw new Error("the shop's search answered " + r.status);
  let data;
  try {
    data = JSON.parse(String(r.body));
  } catch (e) {
    throw new Error("the shop's search is not JSON");
  }
  const list = data && data.resources && data.resources.results && data.resources.results.products;
  if (!Array.isArray(list)) throw new Error("the shop's search has no product list");
  const products = [];
  for (const item of list) {
    if (products.length >= LIMIT || !item || typeof item !== "object") continue;
    const name = clean(item.title || "");
    const price = money(item.price);
    const url = item.handle ? absolute("/products/" + encodeURIComponent(String(item.handle))) : "";
    if (item.id === undefined || !name || !price || !url) continue;
    const p = { id: String(item.id), name: name, price: price, url: url };
    const vendor = clean(item.vendor || "");
    if (vendor) p.brand = vendor;
    const photo = item.image || (item.featured_image && item.featured_image.url) || "";
    if (photo) p.image = absolute(photo);
    if (typeof item.available === "boolean") p.available = item.available;
    products.push(p);
  }
  return { products: products };
}
