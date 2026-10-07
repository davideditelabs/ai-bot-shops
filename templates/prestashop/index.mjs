// Starter driver: PrestaShop 1.6 and 1.7 themes. The search page answers HTML with one product-miniature (1.7) or ajax_block_product (1.6)
// block per product: name link (product-title / product-name), id (data-id-product, or in the link) and the current price in span.price.
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
function nameLink(tile) {
  const heads = startTags(tile, "h1|h2|h3|h4|h5|a|p|div|span", ["product-title", "product-name"]);
  for (const h of heads) {
    const tag = /^<([a-z0-9]+)/i.exec(h.tag)[1].toLowerCase();
    if (tag === "a" && h.attrs.href) return { href: h.attrs.href, text: clean(innerOf(tile, h, "a")) || h.attrs.title || "" };
    const inner = innerOf(tile, h, tag);
    const a = /<a\b[^>]*>/i.exec(inner);
    if (a) {
      const attrs = attrsOf(a[0]);
      if (attrs.href) return { href: attrs.href, text: clean(inner) || attrs.title || "" };
    }
  }
  return undefined;
}
export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const w = encodeURIComponent(q);
  const r = await http({ method: "GET", url: ORIGIN + "/index.php?controller=search&s=" + w + "&search_query=" + w });
  if (r.status !== 200) throw new Error("the shop search answered " + r.status);
  const html = String(r.body);
  const starts = startTags(html, "article|li|div", ["product-miniature", "ajax_block_product"]);
  const products = [];
  const seen = {};
  for (let i = 0; i < starts.length && products.length < LIMIT; i++) {
    const tile = html.slice(starts[i].at, i + 1 < starts.length ? starts[i + 1].at : starts[i].at + 20000);
    const link = nameLink(tile);
    const inner = /\bdata-id-product\s*=\s*["']?(\d+)/i.exec(tile);
    const fromLink = link ? /[?&]id_product=(\d+)|\/(\d+)-[^/]*\.html/i.exec(link.href) : null;
    const id = starts[i].attrs["data-id-product"] || (inner && inner[1]) || (fromLink && (fromLink[1] || fromLink[2])) || "";
    const price = startTags(tile, "span", ["price", "product-price"])[0];
    const priceText = price ? clean(innerOf(tile, price, "span")) : "";
    if (!id || !link || !link.text || !priceText || seen[id]) continue;
    const url = absolute(link.href);
    if (!url) continue;
    seen[id] = true;
    const p = { id: id, name: link.text, price: priceText, url: url };
    const img = /<img\b[^>]*>/i.exec(tile);
    if (img) {
      const a = attrsOf(img[0]);
      // A lazy-loading theme keeps the photo in data-src and a placeholder in src.
      const real = [a["data-src"], a.src, a["data-full-size-image-url"]].filter(function (u) { return u && !/^data:|loader|spacer|blank|placeholder/i.test(u); })[0];
      if (real) p.image = absolute(real);
    }
    products.push(p);
  }
  return { products: products };
}
