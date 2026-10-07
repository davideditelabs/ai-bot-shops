// Starter driver: Magento 2. The search page /catalogsearch/result/?q= answers HTML with one product-item block per product: the link
// a.product-item-link (name and address), the id in data-product-id, and the price in span.price as the shop shows it ("1,75 €").
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
function idOf(tile) {
  const m = /data-product-id\s*=\s*["'](\d+)["']/.exec(tile) || /id\s*=\s*["']product-price-(\d+)["']/.exec(tile) || /name\s*=\s*["']product["'][^>]*value\s*=\s*["'](\d+)["']/.exec(tile);
  return m ? m[1] : "";
}
function priceOf(tile) {
  // The final price's own box first (a discounted product also shows an old price), then any price.
  const box = tile.search(/price-final_price|data-price-type\s*=\s*["']finalPrice["']/);
  const from = box >= 0 ? tile.slice(box) : tile;
  const spans = startTags(from, "span", ["price"]);
  if (spans.length) return clean(innerOf(from, spans[0], "span"));
  const amount = /data-price-amount\s*=\s*["']([\d.,]+)["']/.exec(tile);
  return amount ? amount[1] : "";
}
export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + "/catalogsearch/result/?q=" + encodeURIComponent(q) });
  if (r.status !== 200) throw new Error("the shop search answered " + r.status);
  const html = String(r.body);
  const starts = startTags(html, "li|div|article", ["product-item"]);
  const products = [];
  const seen = {};
  for (let i = 0; i < starts.length && products.length < LIMIT; i++) {
    const tile = html.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : starts[i].at + 20000);
    const link = startTags(tile, "a", ["product-item-link"]).filter(function (a) { return a.attrs.href && a.attrs.href.charAt(0) !== "#"; })[0];
    if (!link) continue;
    const id = idOf(tile);
    const name = clean(innerOf(tile, link, "a")) || link.attrs.title || "";
    const price = priceOf(tile);
    const url = absolute(link.attrs.href);
    if (!id || !name || !price || !url || seen[id]) continue;
    seen[id] = true;
    const p = { id: id, name: name, price: price, url: url };
    const img = /<img\b[^>]*>/i.exec(tile.slice(0, 6000));
    const photo = startTags(tile, "img", ["product-image-photo"])[0];
    const src = photo ? photo.attrs["data-src"] || photo.attrs.src : img ? attrsOf(img[0]).src : "";
    if (src) p.image = absolute(src);
    if (/availability[^>]*(OutOfStock|SoldOut|Discontinued)/i.test(tile)) p.available = false;
    else if (/availability[^>]*InStock/i.test(tile)) p.available = true;
    products.push(p);
  }
  return { products: products };
}
