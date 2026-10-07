// Starter driver: WooCommerce. The public Store API /wp-json/wc/store/v1/products?search= answers JSON with the price in minor units plus the
// separators and currency sign the shop writes it with, so the price text is built exactly as the product page shows it.
//
// How to use: copy this folder to shops/<domain>/, replace ORIGIN with the shop's own origin, edit driver.json, and run
//   node tools/check.mjs shops/<domain>   then   node tools/probe.mjs shops/<domain>
// Contract version 1 (see CONTRACT.md): export run(action, params, http); only action "search"; http() reads the shop with GET/HEAD only.
// This file is a port of the platform driver the AI-Bot gate stages for this platform; keep it self-contained (one file, no imports).
// ORIGIN: the shop's own origin, https only, no trailing slash.
const ORIGIN = "https://www.example.com";
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
function money(prices) {
  if (!prices || prices.price === undefined || prices.price === null || prices.price === "") return "";
  let minor = Number(prices.currency_minor_unit);
  if (!isFinite(minor) || minor < 0 || minor > 4) minor = 2;
  const digits = String(prices.price).replace(/[^0-9]/g, "");
  if (!digits) return "";
  const padded = digits.length <= minor ? new Array(minor - digits.length + 2).join("0") + digits : digits;
  const whole = (minor ? padded.slice(0, padded.length - minor) : padded).replace(/^0+(?=\d)/, "");
  const frac = minor ? padded.slice(padded.length - minor) : "";
  const thousand = prices.currency_thousand_separator === undefined ? "" : String(prices.currency_thousand_separator);
  const decimal = prices.currency_decimal_separator === undefined ? "," : String(prices.currency_decimal_separator);
  const grouped = thousand ? whole.replace(/\B(?=(\d{3})+(?!\d))/g, thousand) : whole;
  return String(prices.currency_prefix || "") + grouped + (frac ? decimal + frac : "") + String(prices.currency_suffix || "");
}
export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + "/wp-json/wc/store/v1/products?per_page=20&search=" + encodeURIComponent(q) });
  if (r.status !== 200) throw new Error("the shop's product list answered " + r.status);
  let list;
  try {
    list = JSON.parse(String(r.body));
  } catch (e) {
    throw new Error("the shop's product list is not JSON");
  }
  if (!Array.isArray(list)) throw new Error("the shop's product list is not a list");
  const products = [];
  for (const item of list) {
    if (products.length >= LIMIT || !item || typeof item !== "object") continue;
    const name = clean(item.name || "");
    const price = money(item.prices);
    const url = absolute(item.permalink || "");
    if (item.id === undefined || !name || !price || !url) continue;
    const p = { id: String(item.id), name: name, price: price, url: url };
    const brand = Array.isArray(item.brands) && item.brands[0] && typeof item.brands[0].name === "string" ? clean(item.brands[0].name) : "";
    if (brand) p.brand = brand;
    const photo = Array.isArray(item.images) && item.images[0] ? item.images[0].thumbnail || item.images[0].src : "";
    if (photo) p.image = absolute(photo);
    if (typeof item.is_in_stock === "boolean") p.available = item.is_in_stock;
    products.push(p);
  }
  return { products: products };
}
