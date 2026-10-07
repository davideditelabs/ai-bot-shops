// Starter driver for a shop whose search page is plain HTML with one block per product (found with shop_observe: the "Repeated block").
//
// How to use: copy this folder to shops/<domain>/, set ORIGIN and SEARCH, then edit TILE, ID, NAME, PRICE and LINK to match the block.
// Check it with   node tools/check.mjs shops/<domain>   and   node tools/probe.mjs shops/<domain>
// Contract version 1 (see CONTRACT.md): export run(action, params, http); only action "search"; GET/HEAD to your own hosts only.

// ORIGIN: the shop's own origin, https only, no trailing slash.
const ORIGIN = "https://www.example.com";
// SEARCH: the shop's own search page address, ending where the search word goes.
const SEARCH = "/search?q=";
const LIMIT = 40;

// The repeated block, and the pieces inside it (regular expressions over the block's HTML; group 1 is the value).
const TILE = /<(?:li|div|article)\b[^>]*class="[^"]*\bproduct-tile\b[^"]*"[^>]*>/gi;
const ID = /data-product-id="([0-9A-Za-z_-]{1,40})"/i;
const NAME = /<[^>]*class="[^"]*\bproduct-name\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i;
const PRICE = /<[^>]*class="[^"]*\bproduct-price\b[^"]*"[^>]*>([\s\S]*?)<\/[a-z0-9]+>/i;
const LINK = /<a\b[^>]*href="([^"#]+)"/i;

const text = (html) => String(html).replace(/<[^>]*>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&euro;/g, "€").replace(/\s+/g, " ").trim();

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
    const name = text((NAME.exec(tile) || [])[1] || "");
    // The price as the shop writes it ("1,75 €"): the product page must show the same text.
    const price = text((PRICE.exec(tile) || [])[1] || "");
    const href = (LINK.exec(tile) || [])[1];
    if (!id || !name || !price || !href || seen[id]) continue;
    let url = "";
    try {
      url = new URL(href, ORIGIN).href;
    } catch (e) {
      continue;
    }
    seen[id] = true;
    products.push({ id: id, name: name, price: price, url: url });
  }
  return { products: products };
}
