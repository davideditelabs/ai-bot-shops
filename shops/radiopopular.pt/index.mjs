// Radio Popular driver. Contract version 1: only action "search"; one GET to the shop's own host.
const ORIGIN = "https://www.radiopopular.pt";
const SEARCH = "/pesquisa/";
const LIMIT = 60;

// Product tiles are <article ... itemtype=".../Product">; breadcrumb <li> items are not matched.
const TILE = /<article\b[^>]*itemtype="[^"]*schema\.org\/Product"[^>]*>/gi;
const ID = /<meta\b[^>]*itemprop="sku"[^>]*content="([0-9A-Za-z_-]{1,40})"/i;
const NAME = /<meta\b[^>]*itemprop="name"[^>]*content="([^"]*)"/i;
const PRICE = /<div\b[^>]*class="[^"]*\bprice\b[^"]*"[^>]*itemprop="price"[^>]*>([\s\S]*?)<\/div>/i;
const URLATTR = /itemprop="url"[^>]*content="([^"]+)"/i;
const LINK = /<a\b[^>]*href="([^"#]*\/produto\/[^"#]*)"/i;
const IMG = /<img\b[^>]*itemprop="image"[^>]*content="([^"]+)"/i;

const decode = (s) =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&euro;/g, "€")
    .replace(/&amp;/g, "&");
const clean = (s) => decode(s).replace(/\s+/g, " ").trim();
const text = (html) => clean(String(html).replace(/<[^>]*>/g, ""));
const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function relevant(name, word) {
  const n = fold(name);
  const w = fold(word).trim();
  if (!w) return true;
  if (n.indexOf(w) !== -1) return true;
  for (const suf of ["es", "s"]) {
    if (w.length > suf.length && w.slice(-suf.length) === suf) {
      const stem = w.slice(0, -suf.length);
      if (stem.length >= 3 && n.indexOf(stem) !== -1) return true;
    }
  }
  return false;
}

export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + SEARCH + encodeURIComponent(q), headers: { accept: "text/html" } });
  if (r.status !== 200) throw new Error("the shop search answered " + r.status);
  const html = String(r.body);
  const starts = [];
  let m;
  while ((m = TILE.exec(html))) starts.push(m.index);
  const products = [];
  const seen = {};
  for (let i = 0; i < starts.length && products.length < LIMIT; i++) {
    const tile = html.slice(starts[i], i + 1 < starts.length ? starts[i + 1] : starts[i] + 20000);
    const id = (ID.exec(tile) || [])[1];
    const name = clean((NAME.exec(tile) || [])[1] || "");
    const pm = PRICE.exec(tile);
    const priceText = pm ? text(pm[1]) : "";
    const href = (URLATTR.exec(tile) || LINK.exec(tile) || [])[1];
    if (!id || !name || !priceText || !href || seen[id]) continue;
    if (!relevant(name, q)) continue;
    let url = "";
    try {
      const u = new URL(decode(href), ORIGIN);
      if (u.protocol !== "https:" || u.hostname !== "www.radiopopular.pt") continue;
      url = u.href;
    } catch (e) {
      continue;
    }
    seen[id] = true;
    const p = { id: id, name: name, price: priceText + " €", url: url };
    const img = (IMG.exec(tile) || [])[1];
    if (img) {
      try {
        const u = new URL(decode(img), ORIGIN);
        if (u.protocol === "https:" && (u.hostname === "radiopopular.pt" || u.hostname.endsWith(".radiopopular.pt"))) p.image = u.href;
      } catch (e) {}
    }
    products.push(p);
  }
  return { products: products };
}
