// The network is always a stub here: no test reaches a real shop. The driver itself does run for real, in the sandboxed child process.
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { REPO, editJson, makeLib, read, write } from "./helpers.mjs";
import { guardedHttp, isCommonWord, probeDriver } from "../tools/probe.mjs";
import { COMMON_WORDS, imageNotes, ownImage } from "../tools/lib/contract.mjs";

const cap = (w) => w[0].toUpperCase() + w.slice(1);
/** What the stub shop sells for a word: `count` products named after the word, each with a photo on the shop's own domain. */
const item = (i, word = "leite", extra = {}) => ({ id: 100 + i, name: `${cap(word)} Mimosa ${i}`, price: `1,${10 + i} €`, image: `https://www.example.com/img/${100 + i}.jpg`, ...extra });
/**
 * A stub shop: `count` products for the words in `known`, nothing for other words; every product page shows its name and price.
 * `make(word, i)` may change a product. Records every request it receives in `calls`.
 */
function stubNet(calls = [], { known = ["milk", "leite"], count = 6, make = (w, i) => item(i, w) } = {}) {
  return async (req) => {
    calls.push(req);
    const u = new URL(req.url);
    if (u.pathname.startsWith("/p/")) {
      const id = Number(u.pathname.slice(3));
      const its = known.map((w) => make(w, id - 100));
      return { status: 200, headers: { "content-type": "text/html" }, body: `<html>${its.map((it) => `<h1>${it.name}</h1>`).join("")}<span class="price">${its[0].price}</span></html>` };
    }
    const q = u.searchParams.get("q");
    const items = known.includes(q) ? Array.from({ length: count }, (_, k) => make(q, k + 1)) : [];
    return { status: 200, headers: { "content-type": "application/json" }, body: JSON.stringify({ items }) };
  };
}
const searchCalls = (calls) => calls.filter((c) => new URL(c.url).pathname === "/api/search");

test("the common-word list is the gate's AUTO_WORDS", () => {
  assert.deepEqual(COMMON_WORDS, ["arroz", "leite", "aveia", "agua", "rice", "milk", "cafe", "protein"]);
  assert.equal(isCommonWord("Milk"), true);
  assert.equal(isCommonWord("my brand"), false);
});

test("a good driver answers the probe word with valid products", async () => {
  const calls = [];
  const { dir } = makeLib();
  const r = await probeDriver({ dir, net: stubNet(calls) });
  assert.equal(r.ok, true, r.errors.join("\n"));
  assert.equal(r.word, "milk");
  assert.equal(r.products.length, 6);
  assert.ok(calls.every((c) => c.method === "GET"));
  assert.match(searchCalls(calls)[0].url, /^https:\/\/www\.example\.com\/api\/search\?q=milk$/);
  assert.equal(r.quality.imageShare, 1);
});

test("the probe word is the driver's own first, then the rest of the list until one gives 3 products", async () => {
  const { dir } = makeLib((d) => editJson(d, "driver.json", (j) => (j.probe = "arroz")));
  const calls = [];
  const r = await probeDriver({ dir, net: stubNet(calls) });
  assert.equal(r.ok, true);
  assert.equal(r.word, "leite");
  assert.deepEqual(r.tried.slice(0, 2).map((t) => t.word), ["arroz", "leite"]);
  assert.deepEqual(searchCalls(calls).slice(0, 2).map((c) => new URL(c.url).searchParams.get("q")), ["arroz", "leite"]);
});

test("--word uses that word only, and it must be on the list", async () => {
  const { dir } = makeLib();
  const ok = await probeDriver({ dir, word: "leite", net: stubNet() });
  assert.equal(ok.ok, true);
  assert.equal(ok.word, "leite");
  const calls = [];
  const bad = await probeDriver({ dir, word: "my usual brand", net: stubNet(calls) });
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /common-word list/);
  assert.equal(calls.length, 0);
});

test("no word giving products is a failure that lists what was tried", async () => {
  const { dir } = makeLib();
  const r = await probeDriver({ dir, net: async () => ({ status: 200, body: '{"items":[]}' }) });
  assert.equal(r.ok, false);
  assert.equal(r.tried.length, COMMON_WORDS.length);
  assert.match(r.errors.at(-1), /no word on the list/);
});

test("a wrong product shape is reported with the contract's wording", async () => {
  const { dir } = makeLib();
  const r = await probeDriver({ dir, net: async () => ({ status: 200, body: JSON.stringify({ items: [{ id: 1, name: "Milk", price: "free" }] }) }) });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /price "free" has no number/);
});

test("a shop that answers 500 fails the run with the driver's own error", async () => {
  const { dir } = makeLib();
  const r = await probeDriver({ dir, net: async () => ({ status: 500, body: "" }) });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /answered 500/);
});

test("the driver's requests are restricted like the gate's: no forbidden path, no POST, no foreign host, no own-host headers", async () => {
  const cases = [
    ['http({ method: "GET", url: ORIGIN + "/checkout/cart" })', /not allowed for a search/],
    ['http({ method: "POST", url: ORIGIN + "/api/search" })', /only reads/],
    ['http({ method: "GET", url: "https://evil.example.org/x" })', /not in driver\.json hosts/],
    ['http({ method: "GET", url: "http://www.example.com/x" })', /only https/],
    ['http({ method: "GET", url: ORIGIN + "/x", headers: { "x-key": "1" } })', /headers can only be sent/],
    ['http({ method: "GET", url: ORIGIN + "/api?add-to-cart=3" })', /not allowed for a search/],
  ];
  for (const [call, expected] of cases) {
    const { dir } = makeLib((d) => write(d, "index.mjs", read(d, "index.mjs").replace('const r = await http({ method: "GET", url: ORIGIN + "/api/search?q=" + encodeURIComponent(q) });', `const r = await ${call};`)));
    const calls = [];
    const r = await probeDriver({ dir, word: "milk", net: stubNet(calls) });
    assert.equal(r.ok, false, call);
    assert.match(r.errors.join("\n"), expected, call);
    assert.equal(calls.length, 0, `${call} must not reach the network`);
  }
});

test("guardedHttp passes an allowed request and strips headers it never forwards", async () => {
  const manifest = { domain: "example.com", hosts: ["www.example.com", "cdn.other.net"] };
  const calls = [];
  const http = guardedHttp(manifest, async (r) => (calls.push(r), { status: 200, headers: {}, body: "ok" }));
  await http({ url: "https://www.example.com/a", headers: { accept: "application/json" } });
  await http({ method: "head", url: "https://cdn.other.net/a", headers: { Cookie: "x", "x-ok": "1" } });
  assert.deepEqual(calls[0].headers, { accept: "application/json" });
  assert.deepEqual(calls[1].headers, { "x-ok": "1" });
  assert.equal(calls[1].method, "HEAD");
});

test("the driver runs sandboxed: it cannot read files outside its folder", async () => {
  const { dir } = makeLib((d) => write(d, "index.mjs", 'import { readFileSync } from "node:fs";\nexport async function run() { return { products: [{ id: "1", name: readFileSync("/etc/hostname", "utf8"), price: "1 €", url: "https://www.example.com/p/1" }] }; }\n'));
  const r = await probeDriver({ dir, word: "milk", net: stubNet() });
  assert.equal(r.ok, false);
  assert.match(r.errors.join("\n"), /ERR_ACCESS_DENIED|Access to this API has been restricted|permission/i);
});

test("a driver.json that is invalid is reported before anything runs", async () => {
  const { dir } = makeLib((d) => write(d, "driver.json", "{}"));
  const r = await probeDriver({ dir, net: stubNet() });
  assert.equal(r.ok, false);
  assert.match(r.errors[0], /driver\.json/);
});

test("the json-feed and html starters run in the sandbox against stubbed shop answers", async () => {
  const run = async (template, body, contentType) => {
    const root = mkdtempSync(join(tmpdir(), "starter-"));
    const dir = join(root, "shops", "example.com");
    mkdirSync(dir, { recursive: true });
    cpSync(join(REPO, "templates", template), dir, { recursive: true });
    return probeDriver({ dir, word: "milk", quick: true, net: async () => ({ status: 200, headers: { "content-type": contentType }, body }) });
  };
  const feed = await run("json-feed", JSON.stringify({ items: [1, 2, 3].map((i) => ({ id: i, name: `Milk ${i}`, price: i + 0.5, url: `/p/${i}` })) }), "application/json");
  assert.equal(feed.ok, true, feed.errors.join("\n"));
  assert.equal(feed.products[0].price, "1,50 €");
  const html = [1, 2, 3].map((i) => `<li class="product-tile" data-product-id="${i}"><a href="/p/${i}"><span class="product-name">Milk ${i}</span></a><span class="product-price">1,${i}9 &euro;</span></li>`).join("");
  const page = await run("html", `<ul>${html}</ul>`, "text/html");
  assert.equal(page.ok, true, page.errors.join("\n"));
  assert.equal(page.products.length, 3);
});

const shop = { domain: "example.com", hosts: ["www.example.com", "example.com"], probe: "milk", name: "Example" };

test("ownImage keeps an https photo on the shop's domain or a subdomain and nothing else (the gate's safeImage rule)", () => {
  assert.equal(ownImage("https://www.example.com/i/1.jpg", shop), "https://www.example.com/i/1.jpg");
  assert.equal(ownImage("https://files.example.com/i/1.jpg", shop), "https://files.example.com/i/1.jpg");
  assert.equal(ownImage("/i/1.jpg", shop), undefined, "absolute URLs only in a driver's answer");
  assert.equal(ownImage("http://www.example.com/i/1.jpg", shop), undefined);
  assert.equal(ownImage("https://cdn.other.net/i/1.jpg", shop), undefined);
  assert.equal(ownImage("https://notexample.com/i/1.jpg", shop), undefined);
  assert.equal(ownImage("https://u:p@www.example.com/i.jpg", shop), undefined);
  assert.equal(ownImage("https://www.example.com:8443/i.jpg", shop), undefined);
  assert.equal(ownImage(`https://www.example.com/${"a".repeat(500)}`, shop), undefined);
  assert.equal(ownImage(5, shop), undefined);
});

test("imageNotes warns, never fails: no photo at all, some missing, or photos the gate would drop", () => {
  const p = (i, image) => ({ id: String(i), name: `Milk ${i}`, price: "1 €", url: "https://www.example.com/p", ...(image ? { image } : {}) });
  const good = "https://www.example.com/i.jpg";
  assert.deepEqual(imageNotes([p(1, good), p(2, good)], shop), []);
  assert.match(imageNotes([p(1), p(2)], shop).join(" "), /no product has an image.*shop really shows no photos/i);
  assert.match(imageNotes([p(1, good), p(2)], shop).join(" "), /1 of 2 products have no image/);
  const foreign = imageNotes([p(1, "https://cdn.other.net/i.jpg"), p(2, good)], shop).join(" ");
  assert.match(foreign, /1 of 2 images are not on example\.com or a subdomain/);
  assert.match(foreign, /drops them/);
});

test("a driver that returns no images passes the probe with a note; one with own images has none", async () => {
  const { dir } = makeLib();
  const none = await probeDriver({ dir, net: stubNet([], { make: (w, i) => item(i, w, { image: undefined }) }) });
  assert.equal(none.ok, true, none.errors.join("\n"));
  assert.match(none.warnings.join(" "), /no product has an image/);
  const withImages = await probeDriver({ dir, net: stubNet() });
  assert.equal(withImages.ok, true, withImages.errors.join("\n"));
  assert.deepEqual(withImages.warnings, []);
});
