// The quality bar for a driver (CONTRACT.md "Quality"): checks that go beyond the shape of the answer, run by tools/probe.mjs and mirrored by the
// AI-Bot gate (gate/src/shops/driver-quality.ts) before it accepts a driver. Pure functions over what the driver returned; no network here.
// Plain Node 20+ ESM, no dependencies.
import { COMMON_WORDS, ownImage } from "./contract.mjs";

/** At least this many products for at least one probe word: a driver that never reaches it reads a menu or a suggestion box, not the results. */
export const MIN_COMPLETE = 5;
/** Of the product names for a word the shop knows, at least this share contains the word (or a close form). */
export const MIN_RELEVANT = 0.8;
/** When the shop's answer shows photos next to the products, at least this share of the products carries a valid image. */
export const MIN_IMAGES = 0.8;

const ENGLISH_FROM = 4; // COMMON_WORDS[0..3] are Portuguese, [4..7] English
export const fold = (s) => String(s).normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
const trimmed = (s, n = 40) => String(s).replace(/\s+/g, " ").trim().slice(0, n);

/**
 * The two held-out probe words for a driver: other words of the same language group as its own probe word, picked by the domain (so the
 * builder cannot tune the driver to them in advance, and the same driver always gets the same two).
 */
export function heldOutWords(domain, probe) {
  const p = COMMON_WORDS.indexOf(String(probe).toLowerCase());
  const from = p >= ENGLISH_FROM ? ENGLISH_FROM : 0;
  const group = COMMON_WORDS.slice(from, from + 4).filter((w) => w !== String(probe).toLowerCase());
  let h = 0;
  for (const c of String(domain)) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const skip = h % group.length;
  return group.filter((_, i) => i !== skip).slice(0, 2);
}

/** Whether a product name contains the search word or a close form of it (accents, case and plurals do not matter: "água" and "Aguas" match "agua"). */
export function nameMatches(name, word) {
  const w = fold(word).trim();
  return w.length > 0 && fold(name).includes(w);
}

const IMG_URL = /(?:https?:)?\/\/[^"'\s,)<>\\]+\.(?:jpe?g|png|webp|avif)\b|\/[^"'\s,)<>\\/][^"'\s,)<>\\]*\.(?:jpe?g|png|webp|avif)\b/gi;
const NOT_PHOTO = /logo|sprite|icon|banner|favicon|placeholder|blank|spacer|loader|flag|badge|payment|social/i;
const WINDOW = 2500;

/**
 * Whether the shop's own answers (the pages or JSON the driver read) show a photo next to the products: for each returned product, a photo
 * address within a short distance of its name. Shows photos when it holds for at least 3 products or half of those found in the answers.
 * Lenient on purpose: a name the answer writes differently is simply not counted.
 */
export function photosShown(bodies, products) {
  let found = 0;
  let near = 0;
  for (const p of products) {
    const key = trimmed(p.name, 30);
    if (!key) continue;
    let seen = false;
    let withPhoto = false;
    for (const body of bodies) {
      const at = String(body).indexOf(key);
      if (at < 0) continue;
      seen = true;
      const around = String(body).slice(Math.max(0, at - WINDOW), at + key.length + WINDOW);
      if ((around.match(IMG_URL) || []).some((u) => !NOT_PHOTO.test(u))) withPhoto = true;
    }
    if (seen) found++;
    if (withPhoto) near++;
  }
  return near >= 3 || (found > 0 && near / found >= 0.5);
}

const CURRENCY = /[€$£¥₹₩₪₺₽]|\p{Sc}|\b[A-Z]{3}\b|\b(?:eur|euro|euros|usd|gbp|aed|sar|egp|kwd|bhd|qar|omr)\b/iu;

/** "1,75 €" -> 1.75, "€1.299,00" -> 1299, "12.47 AED" -> 12.47; undefined when there is no number. */
export function priceNumber(price) {
  const m = /(\d{1,3}(?:[.\s ]\d{3})+|\d+)(?:[.,](\d{1,2}))?/.exec(String(price));
  if (!m) return undefined;
  const whole = Number(m[1].replace(/[.\s ]/g, ""));
  return m[2] ? whole + Number(m[2].padEnd(2, "0")) / 100 : whole;
}

const SHARE = (n, d) => (d ? Math.round((n / d) * 100) / 100 : 0);

/**
 * Judges the runs of a driver: `runs` is [{ word, products }] (the driver's own probe word and the held-out words; an empty list is a word the
 * shop has nothing for), `bodies` the answers the driver read for its probe word. Returns { failures, score }; failures name the field in plain words.
 */
export function judgeQuality(runs, manifest, bodies = []) {
  const failures = [];
  const all = runs.flatMap((r) => r.products);
  const per = runs.map((r) => ({ word: r.word, products: r.products.length }));

  // 1. Completeness: at least one word gives a real list.
  const best = Math.max(0, ...runs.map((r) => r.products.length));
  if (best < MIN_COMPLETE) failures.push(`products: the most the driver found for any of ${runs.map((r) => `"${r.word}"`).join(", ")} is ${best}, under ${MIN_COMPLETE}. A shop's search page lists more: read every product on the results page, not a suggestion box or the first few.`);

  // 2. Every product: price above zero with a currency, an id that is not a position.
  let badFields = 0;
  for (const r of runs) {
    r.products.forEach((p, i) => {
      if (badFields >= 4) return;
      const at = `product ${i + 1} for "${r.word}" ("${trimmed(p.name)}")`;
      const n = priceNumber(p.price);
      if (n === undefined || n <= 0) (badFields++, failures.push(`price: ${at} has price "${trimmed(p.price, 30)}", which is not a price above zero. Skip products without a real price.`));
      else if (!CURRENCY.test(String(p.price))) (badFields++, failures.push(`price: ${at} has price "${trimmed(p.price, 30)}" with no currency. Write it as the shop does ("1,75 €", "12.99 AED").`));
    });
    if (r.products.length >= 3 && r.products.every((p, i) => String(p.id) === String(i) || String(p.id) === String(i + 1))) failures.push(`id: the ids for "${r.word}" are 1, 2, 3 ... in order, so they are positions. Use the shop's own product id (the sku or the number in the product address).`);
  }

  // 3. Relevance: the products are the search results, not menus or related items.
  const counted = per.length ? runs.filter((r) => r.products.length >= MIN_COMPLETE && r.products.some((p) => nameMatches(p.name, r.word))) : [];
  let relevant = 0;
  let relevantOf = 0;
  for (const r of counted) {
    const hits = r.products.filter((p) => nameMatches(p.name, r.word)).length;
    relevant += hits;
    relevantOf += r.products.length;
    if (hits / r.products.length < MIN_RELEVANT) failures.push(`name: only ${hits} of ${r.products.length} product names for "${r.word}" contain the word. The driver may be returning menu items, ads or related products. Keep only the products of the search results list; if the shop itself pads the list with unrelated products for this word, keep only those whose name contains it.`);
  }
  if (!counted.length && best >= MIN_COMPLETE) failures.push(`name: none of the product names contain the search word for any of ${runs.map((r) => `"${r.word}"`).join(", ")}. The driver may be returning menu items, ads or related products instead of the search results.`);

  // 4. Images: when the shop shows photos next to the products, the products carry them.
  const main = runs[0]?.products ?? [];
  const withImage = main.filter((p) => ownImage(p.image, manifest)).length;
  const shown = photosShown(bodies, main) || withImage > 0;
  if (shown && main.length && withImage / main.length < MIN_IMAGES) failures.push(`image: the shop shows a photo for its products, but only ${withImage} of ${main.length} products have a valid image. Read each tile's photo (an absolute https address on ${manifest.domain} or a subdomain).`);

  const score = { productsPerProbe: per, imageShare: SHARE(withImage, main.length), relevanceShare: SHARE(relevant, relevantOf), photosShown: shown };
  return { failures, score, total: all.length };
}
