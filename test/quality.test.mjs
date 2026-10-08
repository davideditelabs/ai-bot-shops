// The quality bar: pure checks (tools/lib/quality.mjs, truth.mjs) and the probe's use of them against a stub shop. No real shop is reached.
import assert from "node:assert/strict";
import { test } from "node:test";
import { makeLib } from "./helpers.mjs";
import { probeDriver } from "../tools/probe.mjs";
import { COMMON_WORDS } from "../tools/lib/contract.mjs";
import { heldOutWords, judgeQuality, nameMatches, photosShown, priceNumber } from "../tools/lib/quality.mjs";
import { checkProductPage, pageHasName } from "../tools/lib/truth.mjs";

const shop = { domain: "example.com", hosts: ["www.example.com"], probe: "leite", name: "Example" };
const P = (i, name, extra = {}) => ({ id: `sku${i}`, name, price: "1,25 €", url: `https://www.example.com/p/sku${i}`, image: `https://www.example.com/i/${i}.jpg`, ...extra });
const list = (n, word = "leite", extra = {}) => Array.from({ length: n }, (_, i) => P(i + 1, `${word} Mimosa ${i + 1}`, extra));
const run = (word, products) => ({ word, products });

test("held-out words: two others of the same language, chosen by the domain, stable and never the probe word", () => {
  for (const probe of COMMON_WORDS) {
    const held = heldOutWords("celeiro.pt", probe);
    assert.equal(held.length, 2);
    assert.ok(!held.includes(probe));
    assert.ok(held.every((w) => COMMON_WORDS.includes(w)));
    assert.deepEqual(held, heldOutWords("celeiro.pt", probe));
    const group = COMMON_WORDS.indexOf(probe) < 4 ? COMMON_WORDS.slice(0, 4) : COMMON_WORDS.slice(4);
    assert.ok(held.every((w) => group.includes(w)), `${probe}: ${held}`);
  }
  const sets = new Set(["a.pt", "b.pt", "c.pt", "d.pt", "e.pt", "f.pt"].map((d) => heldOutWords(d, "arroz").join()));
  assert.ok(sets.size > 1, "the domain changes the pick");
});

test("nameMatches ignores accents, case and plurals", () => {
  assert.equal(nameMatches("Água das Pedras 1,5L", "agua"), true);
  assert.equal(nameMatches("ARROZ Agulha", "arroz"), true);
  assert.equal(nameMatches("Arrozes variados", "arroz"), true);
  assert.equal(nameMatches("Café Delta", "cafe"), true);
  assert.equal(nameMatches("Proteína de soro", "protein"), true);
  assert.equal(nameMatches("Sumo de laranja", "leite"), false);
  assert.equal(nameMatches("anything", ""), false);
});

test("priceNumber reads the shop's own price text", () => {
  assert.equal(priceNumber("1,75 €"), 1.75);
  assert.equal(priceNumber("€1.299,00"), 1299);
  assert.equal(priceNumber("12.99 AED"), 12.99);
  assert.equal(priceNumber("free"), undefined);
});

test("a complete, relevant, priced answer with photos passes", () => {
  const r = judgeQuality([run("leite", list(8)), run("arroz", list(6, "arroz")), run("agua", [])], shop);
  assert.deepEqual(r.failures, []);
  assert.deepEqual(r.score.productsPerProbe.map((x) => x.products), [8, 6, 0]);
  assert.equal(r.score.imageShare, 1);
  assert.equal(r.score.relevanceShare, 1);
});

test("completeness: fewer than 5 products for every probe word fails, 5 for one word is enough", () => {
  const few = judgeQuality([run("leite", list(3)), run("arroz", list(2, "arroz")), run("agua", [])], shop);
  assert.match(few.failures.join(" "), /products: the most the driver found.* is 3, under 5/);
  assert.deepEqual(judgeQuality([run("leite", list(5)), run("arroz", []), run("agua", [])], shop).failures, []);
});

test("every product has a price above zero with a currency, and an id that is not a position", () => {
  const zero = judgeQuality([run("leite", [...list(5), P(9, "Leite zero", { price: "0,00 €" })])], shop).failures.join(" ");
  assert.match(zero, /price: product 6 for "leite".*not a price above zero/);
  const noCurrency = judgeQuality([run("leite", list(6, "leite", { price: "1,25" }))], shop).failures.join(" ");
  assert.match(noCurrency, /price: .*no currency/);
  assert.deepEqual(judgeQuality([run("leite", list(6, "leite", { price: "12.99 AED" }))], shop).failures, []);
  const positions = list(6).map((p, i) => ({ ...p, id: String(i + 1) }));
  assert.match(judgeQuality([run("leite", positions)], shop).failures.join(" "), /id: .*positions/);
});

test("relevance: a driver that returns menus or related items is named, with the share", () => {
  const menu = ["Home", "Ofertas", "Contactos", "Leite A", "Frescos", "Ajuda", "Leite B", "Marcas"].map((n, i) => P(i + 1, n));
  const f = judgeQuality([run("leite", menu)], shop).failures.join(" ");
  assert.match(f, /name: only 2 of 8 product names for "leite" contain the word/);
  const none = judgeQuality([run("leite", list(6, "Sumo")), run("arroz", [])], shop).failures.join(" ");
  assert.match(none, /name: none of the product names contain the search word/);
  // 4 of 5 is exactly 80%: passes
  assert.deepEqual(judgeQuality([run("leite", [...list(4), P(9, "Sumo de laranja")])], shop).failures, []);
  // a word the shop has fewer than 5 products for is not judged for relevance (the shop's own fuzzy fallback)
  assert.deepEqual(judgeQuality([run("leite", list(6)), run("arroz", [P(20, "Panela"), P(21, "Tacho")])], shop).failures, []);
});

test("photos: when the shop's answer shows a photo beside the products, the products must carry one", () => {
  const body = list(6).map((p) => `<li><img src="/media/${p.id}.jpg"><a>${p.name}</a></li>`).join("");
  const bare = list(6, "leite", { image: undefined });
  assert.equal(photosShown([body], bare), true);
  const f = judgeQuality([run("leite", bare)], shop, [body]).failures.join(" ");
  assert.match(f, /image: the shop shows a photo for its products, but only 0 of 6 products have a valid image/);
  assert.deepEqual(judgeQuality([run("leite", bare)], shop, ["<li>Leite Mimosa 1</li><img src='/logo.jpg'>"]).failures, [], "a page with no product photos asks for none");
  assert.deepEqual(judgeQuality([run("leite", bare)], shop, [body.replaceAll(".jpg", ".svg")]).failures, [], "icons are not photos");
  // photos on a foreign host do not count: the gate drops them
  const foreign = list(6, "leite", { image: "https://cdn.other.net/a.jpg" });
  assert.match(judgeQuality([run("leite", foreign)], shop, [body]).failures.join(" "), /image: .*only 0 of 6/);
  // the driver giving photos is itself proof the shop shows them
  const some = list(6).map((p, i) => (i < 2 ? p : { ...p, image: undefined }));
  assert.match(judgeQuality([run("leite", some)], shop, []).failures.join(" "), /only 2 of 6/);
});

test("truth: a product page shows the name and the price, or the failure says which", () => {
  const p = { id: "sku1", name: "Leite Mimosa Meio Gordo 1L", price: "1,25 €" };
  const page = (price) => `<h1>Leite Mimosa Meio Gordo 1L</h1><span class="p">${price}</span>`;
  assert.equal(checkProductPage(page("1,25 €"), p).ok, true);
  const wrong = checkProductPage(page("2,50 €"), p);
  assert.equal(wrong.ok, false);
  assert.match(wrong.reason, /shows 2\.5 but not the price "1,25 €"/);
  assert.equal(checkProductPage("<h1>Other</h1><span>1,25 €</span>", p).ok, false);
  assert.equal(checkProductPage("<h1>Leite Mimosa</h1><script>draw()</script>", p).ok, null, "no price on the page: it is drawn in the browser, so no failure here");
  assert.equal(pageHasName("<p>Leite Mimosa Meio Gordo</p>", "Leite Mimosa Meio Gordo 1L"), true);
});

// ---- the probe, against a stub shop

const stub = ({ count = 6, name = (w, i) => `${w[0].toUpperCase()}${w.slice(1)} Mimosa ${i}`, price = (i) => `1,${10 + i} €`, page = null, searchOnly = ["milk", "leite", "arroz"] } = {}) => async (req) => {
  const u = new URL(req.url);
  if (u.pathname.startsWith("/p/")) {
    const i = Number(u.pathname.slice(3)) - 100;
    return { status: 200, headers: {}, body: page ? page(i) : `<h1>${[...searchOnly].map((w) => name(w, i)).join("</h1><h1>")}</h1><b>${price(i)}</b>` };
  }
  const q = u.searchParams.get("q");
  const items = searchOnly.includes(q) ? Array.from({ length: count }, (_, k) => ({ id: 101 + k, name: name(q, k + 1), price: price(k + 1), image: `https://www.example.com/i/${k}.jpg` })) : [];
  return { status: 200, headers: {}, body: JSON.stringify({ items }) };
};

test("the probe runs the held-out words and reports a quality score", async () => {
  const { dir } = makeLib();
  const seen = [];
  const net = stub();
  const r = await probeDriver({ dir, net: async (req) => (seen.push(req.url), net(req)) });
  assert.equal(r.ok, true, r.errors.join("\n"));
  const words = [...new Set(seen.filter((u) => u.includes("/api/search")).map((u) => new URL(u).searchParams.get("q")))];
  assert.equal(words.length, 3, words.join());
  assert.deepEqual(words.slice(1), heldOutWords("example.com", words[0]));
  assert.equal(seen.filter((u) => u.includes("/p/")).length, 2, "two product pages are opened");
  assert.equal(r.quality.productsPerProbe.length, 3);
});

test("the probe fails a driver that gives a short list, with the field named", async () => {
  const { dir } = makeLib();
  const r = await probeDriver({ dir, net: stub({ count: 3 }) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /products: the most the driver found/);
});

test("the probe fails a driver whose prices differ from the product page, naming the product", async () => {
  const { dir } = makeLib();
  const r = await probeDriver({ dir, net: stub({ page: (i) => `<h1>Milk Mimosa ${i}</h1><h1>Leite Mimosa ${i}</h1><b>9,99 €</b>` }) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(" "), /product 101: its page shows 9\.99 but not the price/);
});

test("the probe says so when it was run --quick, so a quick pass is never mistaken for a full one", async () => {
  const { dir } = makeLib();
  const r = await probeDriver({ dir, quick: true, net: stub({ count: 3 }) });
  assert.equal(r.ok, true);
  assert.match(r.warnings.join(" "), /quality bar .* NOT checked/);
});
