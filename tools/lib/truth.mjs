// The truth check, library side (CONTRACT.md section 6): does the product's own page show its name and its price? The same rules as the gate's
// driver-truth.ts, minus the browser fallback: a page that draws its price in the browser is "cannot tell" here, never a failure.
// Plain Node 20+ ESM, no dependencies.
import { fold, priceNumber } from "./quality.mjs";

const NAMED = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", euro: "€", pound: "£" };
const decode = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });

const LD_JSON = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const ANY_SCRIPT = /<script\b[\s\S]*?<\/script>/gi;
const ANY_STYLE = /<style\b[\s\S]*?<\/style>/gi;
const TEXT_PRICE = /(?<![\d.,])(?:\d{1,3}(?:[.\s]\d{3})+|\d+)[.,]\d{2}(?!\d)|(?<![\d.,])\d+(?![.,]?\d)\s*(?:€|EUR\b)|(?:€|\bEUR)\s*\d+(?![.,]?\d)/g;
const PRICE_ATTR = /data-price-amount\s*=\s*["']([^"']+)["']/gi;
const ITEMPROP_PRICE = [/<[^>]*\bitemprop\s*=\s*["']price["'][^>]*\bcontent\s*=\s*["']([^"']+)["']/gi, /<[^>]*\bcontent\s*=\s*["']([^"']+)["'][^>]*\bitemprop\s*=\s*["']price["']/gi, /<[^>]*\bitemprop\s*=\s*["']price["'][^>]*>\s*([\d.,\s]+)\s*</gi];
const LD_PRICE = /"price"\s*:\s*"?([\d.,]+)"?/gi;

function visibleText(html) {
  return decode(html.replace(ANY_STYLE, " ").replace(ANY_SCRIPT, (m) => (/type\s*=\s*["']application\/ld\+json["']/i.test(m.slice(0, m.indexOf(">"))) ? m : " ")).replace(/<[^>]+>/g, " ")).replace(/ /g, " ");
}

/** Every price the page shows in the three places the truth check reads (visible text, price attributes, JSON-LD), as numbers. */
export function pagePrices(html) {
  const out = [];
  const add = (t) => {
    const v = priceNumber(t);
    if (v !== undefined) out.push(v);
  };
  for (const m of visibleText(html).matchAll(TEXT_PRICE)) add(m[0].replace(/€|EUR/g, ""));
  for (const re of [PRICE_ATTR, ...ITEMPROP_PRICE]) for (const m of html.matchAll(re)) add(m[1]);
  for (const block of html.matchAll(LD_JSON)) for (const m of block[1].matchAll(LD_PRICE)) add(m[1]);
  return out;
}

/** Whether the page carries at least 60% of the name's words of 3 letters or more (accents and case folded). */
export function pageHasName(html, name) {
  const page = fold(decode(html.replace(/<[^>]+>/g, " ")));
  const words = fold(name).split(/[^\p{L}\p{N}]+/u).filter((w) => w.length >= 3);
  if (!words.length) return page.includes(fold(name).trim());
  return words.filter((w) => page.includes(w)).length / words.length >= 0.6;
}

/**
 * Checks one product against its page. { ok: true } | { ok: false, reason } | { ok: null, reason } when it cannot tell (no price on the page at all:
 * the shop draws it in the browser, and the gate will open the page for real).
 */
export function checkProductPage(html, product) {
  const want = priceNumber(product.price);
  const prices = pagePrices(html);
  const hasName = pageHasName(html, product.name);
  if (want !== undefined && prices.some((v) => Math.abs(v - want) < 0.005) && hasName) return { ok: true };
  if (!prices.length) return { ok: null, reason: `the page of product ${product.id} shows no price in its text, a price attribute or JSON-LD (the shop may draw it in the browser; the gate opens such pages for real)` };
  if (!hasName) return { ok: false, reason: `product ${product.id}: its page does not show the name "${String(product.name).replace(/\s+/g, " ").slice(0, 60)}". Read the name from the product tile as the page shows it` };
  return { ok: false, reason: `product ${product.id}: its page shows ${prices.slice(0, 3).join(", ")} but not the price "${String(product.price).slice(0, 30)}". Read the price the page shows (not a list price, an old price or a price per unit)` };
}
