// Starter driver: Majid Al Futtaim's Carrefour sites (one Next.js storefront in about 15 countries). The search page /<store>/<lang>/search?keyword=
// carries its products in the page's escaped Next.js payload (productId, productName, sellingPrice, currency, productUrl, imageUrl).
// Set STORE and LANG to the store path the home page links to (for example "mafuae" and "en").
//
// How to use: copy this folder to shops/<domain>/, replace ORIGIN with the shop's own origin, edit driver.json, and run
//   node tools/check.mjs shops/<domain>   then   node tools/probe.mjs shops/<domain>
// Contract version 1 (see CONTRACT.md): export run(action, params, http); only action "search"; http() reads the shop with GET/HEAD only.
// This file is a port of the platform driver the AI-Bot gate stages for this platform; keep it self-contained (one file, no imports).
// ORIGIN: the shop's own origin, https only, no trailing slash.
const ORIGIN = "https://www.carrefouruae.com";
// STORE and LANG: the first two path segments of the shop's own pages, e.g. https://www.carrefouruae.com/mafuae/en/...
const STORE = "mafuae";
const LANG = "en";
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
/** The text of a string written inside the page's payload: the script's own escapes, then the JSON's (a name with a quote has both). */
function unwrap(s) {
  let t = String(s);
  for (let i = 0; i < 2; i++) {
    try {
      t = JSON.parse('"' + t + '"');
    } catch (e) {
      break;
    }
  }
  return t;
}
function field(win, name, valueRe) {
  const m = new RegExp('\\\\"' + name + '\\\\":' + valueRe).exec(win);
  return m ? m[1] : "";
}
export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + "/" + STORE + "/" + LANG + "/search?keyword=" + encodeURIComponent(q) });
  if (r.status !== 200) throw new Error("the shop search answered " + r.status);
  const html = String(r.body);
  const starts = [];
  const re = /\\"productId\\":\\"([0-9A-Za-z_-]{1,40})\\"/g;
  let m;
  while ((m = re.exec(html))) starts.push({ id: m[1], at: m.index });
  const products = [];
  const seen = {};
  for (let i = 0; i < starts.length && products.length < LIMIT; i++) {
    const id = starts[i].id;
    if (seen[id]) continue;
    const win = html.slice(starts[i].at, Math.min(i + 1 < starts.length ? starts[i + 1].at : starts[i].at + 4000, starts[i].at + 4000));
    const before = html.slice(Math.max(0, starts[i].at - 1500), starts[i].at);
    const name = clean(unwrap(field(win, "productName", '\\\\"(.*?)\\\\",\\\\"')));
    const amount = Number(field(win, "sellingPrice", "(\\d+(?:\\.\\d+)?)"));
    const currency = field(win, "currency", '\\\\"([A-Z]{3})\\\\"');
    const path = unwrap(field(win, "productUrl", '\\\\"(.*?)\\\\"'));
    if (!name || !(amount > 0) || !currency || !path || path.charAt(0) !== "/") continue;
    const url = absolute(path);
    if (!url) continue;
    seen[id] = true;
    const p = { id: id, name: name, price: amount.toFixed(2) + " " + currency, url: url };
    const images = before.match(/\\"imageUrl\\":\\"(.*?)\\"/g);
    const image = images ? /\\"imageUrl\\":\\"(.*?)\\"/.exec(images[images.length - 1]) : null;
    if (image) p.image = absolute(unwrap(image[1]));
    const stock = before.match(/\\"stockLevelStatus\\":\\"(\w+)\\"/g);
    const level = stock ? /\\"stockLevelStatus\\":\\"(\w+)\\"/.exec(stock[stock.length - 1]) : null;
    if (level) p.available = !/out/i.test(level[1]);
    products.push(p);
  }
  return { products: products };
}
