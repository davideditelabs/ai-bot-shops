// Radio Popular: the search page is HTML; the product tiles come after a very large menu, so we slice from the results area first.
const ORIGIN = "https://www.radiopopular.pt";
const LIMIT = 60;

const ID = /itemprop="sku"\s+content="([0-9A-Za-z_-]{1,40})"/i;
const NAME = /itemprop="name"\s+content="([^"]{1,300})"/i;
const PRICE = /itemprop="price"[^>]*>([^<]{1,12}(?:<sup>[^<]{1,6}<\/sup>)?)/i;
const URL_META = /itemprop="url"\s+content="([^"]+)"/i;
const LINK = /href="([^"]*\/produto\/[^"]*)"/i;
const IMG = /itemprop="image"\s+content="([^"]+)"/i;

const fold = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

function decode(s) {
  return String(s)
    .replace(/&#(\d{1,6});/g, (m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (m, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&euro;/g, "€")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function ownHost(h, root) {
  return h === root || h.endsWith("." + root);
}

function stem(w) {
  if (w.length >= 5 && w.endsWith("es")) return w.slice(0, -2);
  if (w.length >= 4 && w.endsWith("s")) return w.slice(0, -1);
  return w;
}

export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String((params && params.q) || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + "/pesquisa/" + encodeURIComponent(q), headers: { accept: "text/html" } });
  if (r.status !== 200) throw new Error("the shop search answered " + r.status);
  const body = String(r.body);
  let from = body.indexOf('<section class="products grid"');
  if (from < 0) from = body.indexOf('itemtype="http://schema.org/Product"');
  if (from < 0) return { products: [] };
  const html = body.slice(from);

  const words = fold(q).split(/[^a-z0-9]+/).filter(Boolean).map(stem);
  const starts = [];
  let at = 0;
  while (starts.length < 200) {
    const i = html.indexOf("<article", at);
    if (i < 0) break;
    starts.push(i);
    at = i + 8;
  }

  const products = [];
  const seen = {};
  for (let i = 0; i < starts.length && products.length < LIMIT; i++) {
    const tile = html.slice(starts[i], Math.min(i + 1 < starts.length ? starts[i + 1] : starts[i] + 15000, starts[i] + 15000));
    if (tile.indexOf("schema.org/Product") < 0) continue;
    const id = (ID.exec(tile) || [])[1];
    const name = decode((NAME.exec(tile) || [])[1] || "");
    const pm = PRICE.exec(tile);
    const num = pm ? decode(pm[1].replace(/<[^>]*>/g, "")) : "";
    if (!id || !name || !/\d/.test(num) || seen[id]) continue;
    const f = fold(name);
    if (!words.every((w) => f.indexOf(w) >= 0)) continue;
    const href = (URL_META.exec(tile) || LINK.exec(tile) || [])[1];
    let url = "";
    try {
      const u = new URL(decode(href || ""), ORIGIN);
      if (u.protocol !== "https:" || u.hostname !== "www.radiopopular.pt") continue;
      url = u.href;
    } catch (e) {
      continue;
    }
    seen[id] = true;
    const p = { id: id, name: name, price: num + " €", url: url };
    const img = (IMG.exec(tile) || [])[1];
    if (img) {
      try {
        const u = new URL(decode(img), ORIGIN);
        if (u.protocol === "https:" && ownHost(u.hostname, "radiopopular.pt") && u.href.length <= 500) p.image = u.href;
      } catch (e) {}
    }
    products.push(p);
  }
  return { products: products };
}
