// Radio Popular search driver (plain HTML, one <article> per product). Contract version 1.
const ORIGIN = "https://www.radiopopular.pt";
const SEARCH = "/pesquisa/";
const LIMIT = 40;

const TILE = /<article\b[^>]*itemprop="itemListElement"[^>]*>/gi;
const ID = /<meta\b[^>]*itemprop="sku"[^>]*content="([0-9A-Za-z_-]{1,40})"/i;
const NAME = /<meta\b[^>]*itemprop="name"[^>]*content="([^"]*)"/i;
const PRICE = /<div\b[^>]*itemprop="price"[^>]*>([\s\S]*?)<\/div>/i;
const LINK = /itemprop="url"[^>]*content="([^"#]+)"/i;
const LINK2 = /href="([^"#]*\/produto\/[^"#]*)"/i;

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

export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + SEARCH + encodeURIComponent(q) });
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
    const name = decode((NAME.exec(tile) || [])[1] || "").replace(/\s+/g, " ").trim();
    const raw = (PRICE.exec(tile) || [])[1];
    const num = raw ? decode(raw.replace(/<[^>]*>/g, "")).replace(/\s+/g, " ").trim() : "";
    const price = num ? num + " €" : "";
    const href = decode((LINK.exec(tile) || LINK2.exec(tile) || [])[1] || "");
    if (!id || !name || !price || !href || seen[id]) continue;
    let url = "";
    try {
      const u = new URL(href, ORIGIN);
      if (u.protocol !== "https:" || u.hostname !== "www.radiopopular.pt") continue;
      url = u.href;
    } catch (e) {
      continue;
    }
    seen[id] = true;
    products.push({ id: id, name: name, price: price, url: url });
  }
  return { products: products };
}
