// Starter driver for a shop whose search answers JSON (found with shop_observe: an XHR/Fetch request returning a list of products).
//
// How to use: copy this folder to shops/<domain>/, set ORIGIN and SEARCH, then edit the three marked places (list, one product, price).
// Check it with   node tools/check.mjs shops/<domain>   and   node tools/probe.mjs shops/<domain>
// Contract version 1 (see CONTRACT.md): export run(action, params, http); only action "search"; GET/HEAD to your own hosts only.

// ORIGIN: the shop's own origin, https only, no trailing slash.
const ORIGIN = "https://www.example.com";
// SEARCH: the path and query the shop's own search page loads, ending where the search word goes.
const SEARCH = "/api/search?q=";
const LIMIT = 40;

// 1. Where the product list is inside the answer (change to match the real JSON).
const listOf = (data) => (data && Array.isArray(data.items) ? data.items : []);

// 2. The price exactly as the shop's product page writes it, for example "1,75 €". Never invent or convert a price.
function priceOf(item) {
  if (typeof item.priceText === "string") return item.priceText.trim();
  const n = Number(item.price);
  return Number.isFinite(n) && n > 0 ? n.toFixed(2).replace(".", ",") + " €" : "";
}

export async function run(action, params, http) {
  if (action !== "search") throw new Error("this driver only searches");
  const q = String(params.q || "").trim();
  if (!q) throw new Error("no search word");
  const r = await http({ method: "GET", url: ORIGIN + SEARCH + encodeURIComponent(q) });
  if (r.status !== 200) throw new Error("the shop's search answered " + r.status);
  let data;
  try {
    data = JSON.parse(String(r.body));
  } catch (e) {
    throw new Error("the shop's search is not JSON");
  }
  const products = [];
  for (const item of listOf(data)) {
    if (products.length >= LIMIT || !item || typeof item !== "object") continue;
    // 3. One product: the shop's own id (never a position), name, price and product page address (https, on the shop's own domain).
    const name = String(item.name || "").trim();
    const price = priceOf(item);
    let url = "";
    try {
      url = new URL(String(item.url || ""), ORIGIN).href;
    } catch (e) {
      url = "";
    }
    if (item.id === undefined || !name || !price || !url) continue;
    const p = { id: String(item.id), name: name, price: price, url: url };
    if (item.brand) p.brand = String(item.brand);
    if (item.image) p.image = new URL(String(item.image), ORIGIN).href;
    if (typeof item.available === "boolean") p.available = item.available;
    products.push(p);
  }
  return { products: products };
}
