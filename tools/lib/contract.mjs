// The driver contract, version 1, as code. Ported from the AI-Bot gate (gate/src/shops/driver-manifest.ts, driver-contract.ts and
// recipe.ts FORBIDDEN_PATH). CONTRACT.md is the human text; when the two disagree, CONTRACT.md is wrong, fix it.
// Plain Node 20+ ESM, no dependencies.

export const CONTRACT_VERSION = 1;

/** The only action in contract version 1. */
export const ACTIONS = ["search"];

/** Common words a probe may use: the same list as AUTO_WORDS in the gate (gate/src/shops/platform/auto.ts), in the same order. */
export const COMMON_WORDS = ["arroz", "leite", "aveia", "agua", "rice", "milk", "cafe", "protein"];

export const MAX_HOSTS = 5;
export const MAX_PRODUCTS = 60;
/** How an empty answer is worded: a search that finds nothing is "no match", not a broken driver. */
export const NO_PRODUCTS = "no products for the search";

const HOST = /^(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRIVATE_SUFFIXES = [".local", ".localhost", ".internal", ".lan", ".home.arpa", ".ts.net"];
const NAME = /^[\p{L}\p{N} .&'-]{1,60}$/u;
const PROBE = /^[\p{L}\p{N} .'-]{1,40}$/u;

const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** A public DNS name: no IPs, no local or tailnet names, no wildcard pattern. */
export function publicHost(host) {
  return typeof host === "string" && HOST.test(host) && !host.startsWith("*.") && !PRIVATE_SUFFIXES.some((s) => host.endsWith(s)) && host.split(".").length >= 2;
}

/** Whether `host` is the shop's domain or one of its subdomains. */
export const shopHost = (domain, host) => host === domain || host.endsWith(`.${domain}`);

/** The first label of a domain, capitalised ("celeiro.pt" is "Celeiro"). */
export function derivedNameOf(domain) {
  const label = domain.replace(/^www\./, "").split(".")[0] || domain;
  return label.charAt(0).toUpperCase() + label.slice(1);
}

// ---------------------------------------------------------------- forbidden paths

/** Never near the money or the account (also in the other languages the shops use). Copied from the gate's recipe.ts FORBIDDEN_PATH. */
export const FORBIDDEN_PATH = /(checkout|payment|pagamento|order|encomenda|login|signin|account|conta)/i;
/** Path segments that are a basket, a wishlist or a sign-out: whole segments only, so "/carrinho-de-bebe-xyz.html" is a product. */
const REFUSED_SEGMENTS = new Set(["cart", "carrinho", "cesto", "basket", "bag", "wishlist", "favoritos", "logout", "log-out", "signout", "sign-out", "sair"]);
/** Query keys that change a basket, a wishlist or a session on a plain GET (WooCommerce ?add-to-cart=12, ?remove_item=..., ?customer-logout). */
const ACTION_KEY = /^(add[-_]?to[-_]?(cart|basket|wishlist)|remove[-_]?item|undo[-_]?item|empty[-_]?cart|clear[-_]?cart|(customer[-_]?)?log[-_]?out)$/i;
/** Query keys that name the page a front controller shows (PrestaShop ?controller=cart, OpenCart ?route=checkout/cart). */
const ROUTE_KEY = /^(controller|action|route|page|fc|module|view)$/i;

/** A path (and query) a driver must never request or name as a product page. Same rules as the gate's driverPathRefused. */
export function driverPathRefused(pathname, search = "") {
  if (FORBIDDEN_PATH.test(pathname) || pathname.split("/").some((seg) => REFUSED_SEGMENTS.has(seg.toLowerCase()))) return true;
  for (const [k, v] of new URLSearchParams(search)) {
    if (ACTION_KEY.test(k)) return true;
    if (ROUTE_KEY.test(k) && (FORBIDDEN_PATH.test(v) || v.toLowerCase().split(/[/.]/).some((seg) => REFUSED_SEGMENTS.has(seg)))) return true;
  }
  return false;
}

// ---------------------------------------------------------------- driver.json

/**
 * Reads a driver.json the way the gate does (gate/src/shops/driver-manifest.ts), but stricter where the library cannot guess: name, hosts
 * and probe must be written out (the gate fills them in from the domain and from the bot's last look at the shop). Every problem is
 * listed at once as { code, message, fix }.
 * @returns {{ manifest: { domain: string, name: string, hosts: string[], probe: string }, warnings: string[] } | { problems: Array<{code: string, message: string, fix: string}> }}
 */
export function readManifest(raw) {
  const problems = [];
  const add = (code, message, fix) => problems.push({ code, message, fix });
  const warnings = [];
  if (!isObj(raw)) return { problems: [{ code: "manifest-shape", message: "driver.json must be an object", fix: 'Write it as { "domain": "celeiro.pt", "name": "Celeiro", "hosts": ["www.celeiro.pt", "celeiro.pt"], "probe": "arroz" }.' }] };
  for (const k of Object.keys(raw)) {
    if (!["domain", "name", "hosts", "probe", "tests"].includes(k)) warnings.push(`driver.json: unknown field "${k.slice(0, 40)}" is ignored by the gate (it only takes domain, name, hosts, probe)`);
  }
  const domain = typeof raw.domain === "string" ? raw.domain.trim().toLowerCase().replace(/^www\./, "") : "";
  const domainOk = publicHost(domain);
  if (!domainOk) add("manifest-domain", "domain must be the shop's public domain", 'Set "domain" to the shop\'s own domain without www, for example "celeiro.pt".');

  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!NAME.test(name)) add("manifest-name", "name must be the shop's name, 1 to 60 letters, digits, spaces or . & ' -", `Set "name" to the shop's name, for example "${domainOk ? derivedNameOf(domain) : "Celeiro"}".`);

  const example = domainOk ? `"www.${domain}", "${domain}"` : '"www.celeiro.pt", "celeiro.pt"';
  const hosts = [];
  if (!Array.isArray(raw.hosts) || raw.hosts.length < 1 || raw.hosts.length > MAX_HOSTS) {
    add("manifest-hosts", `hosts must list 1 to ${MAX_HOSTS} host names`, `Set "hosts" to the shop's own host names, for example [${example}].`);
  } else {
    for (const h of raw.hosts) {
      const v = typeof h === "string" ? h.trim().toLowerCase() : "";
      if (!publicHost(v)) add("manifest-hosts", `hosts: "${String(h).slice(0, 80)}" is not a public host name`, `Use plain public host names such as ${example}: no IP addresses, no wildcards, no addresses with a path.`);
      else hosts.push(v);
    }
    if (domainOk && hosts.length && !hosts.some((h) => shopHost(domain, h))) add("manifest-hosts", `hosts must include at least one host on ${domain}`, `Add the shop's own host, for example "www.${domain}".`);
  }

  const probe = typeof raw.probe === "string" ? raw.probe.trim() : "";
  if (!PROBE.test(probe)) add("manifest-probe", "probe must be one common search word (letters, digits, spaces or . ' -, at most 40)", `Set "probe" to one word from the common-word list: ${COMMON_WORDS.join(", ")}.`);
  else if (!COMMON_WORDS.includes(probe.toLowerCase())) add("probe-word", `probe "${probe.slice(0, 40)}" is not on the common-word list`, `The probe word must never be a user's item. Use one of: ${COMMON_WORDS.join(", ")}.`);

  if (raw.tests !== undefined && !(Array.isArray(raw.tests) && raw.tests.length === 0)) {
    add("manifest-tests", "tests must be absent or empty in the library", 'Remove "tests". Recordings come from a user\'s signed-in browser and stay local; the gate records its own live run.');
  }
  return problems.length ? { problems } : { manifest: { domain, name, hosts, probe }, warnings };
}

// ---------------------------------------------------------------- products

const ID = /^[0-9A-Za-z_-]{1,40}$/;
const FIELDS = ["id", "name", "price", "url", "brand", "size", "unitPrice", "image", "available"];
const short = (v, max) => typeof v === "string" && v.trim().length >= 1 && v.length <= max;

/**
 * What a search must answer: { products: [...] } with 1 to 60 products. Same checks, same wording as the gate's productsOf.
 * @returns {{ ok: true, products: object[] } | { ok: false, errors: string[] }}
 */
export function productsOf(data, manifest) {
  if (!isObj(data) || !Array.isArray(data.products)) return { ok: false, errors: ["search must return { products: [...] }"] };
  const list = data.products;
  if (!list.length) return { ok: false, errors: [`${NO_PRODUCTS} (try the probe word "${manifest.probe}" on the shop yourself)`] };
  if (list.length > MAX_PRODUCTS) return { ok: false, errors: [`at most ${MAX_PRODUCTS} products per search`] };
  const errors = [];
  const seen = new Set();
  const products = [];
  list.forEach((raw, i) => {
    const at = `product ${i + 1}`;
    const before = errors.length;
    if (!isObj(raw)) return void errors.push(`${at}: must be an object`);
    for (const k of Object.keys(raw)) if (!FIELDS.includes(k)) errors.push(`${at}: unknown field "${k.slice(0, 40)}"`);
    const id = typeof raw.id === "number" ? String(raw.id) : raw.id;
    if (typeof id !== "string" || !ID.test(id)) errors.push(`${at}: id "${String(id).slice(0, 60)}" must be letters, digits, _ or -, at most 40`);
    else if (seen.has(id)) errors.push(`${at}: id "${id}" appears twice`);
    else seen.add(id);
    if (!short(raw.name, 200)) errors.push(`${at}: name must be 1 to 200 characters`);
    if (!short(raw.price, 30)) errors.push(`${at}: price must be the price as the shop writes it, like "1,75 €"`);
    else if (!/\d/.test(raw.price)) errors.push(`${at}: price "${raw.price}" has no number`);
    let url;
    try {
      url = typeof raw.url === "string" ? new URL(raw.url) : undefined;
    } catch {
      url = undefined;
    }
    if (!url || url.protocol !== "https:" || url.username || url.password || !shopHost(manifest.domain, url.hostname.toLowerCase())) errors.push(`${at}: url must be an https page on ${manifest.domain}`);
    else if (driverPathRefused(url.pathname, url.search)) errors.push(`${at}: url ${url.pathname.slice(0, 80)} is not a product page (no basket, checkout, order or account pages)`);
    for (const k of ["brand", "size", "unitPrice"]) if (raw[k] !== undefined && !short(raw[k], 80)) errors.push(`${at}: ${k} must be 1 to 80 characters when given`);
    if (raw.image !== undefined && typeof raw.image !== "string") errors.push(`${at}: image must be a URL when given`);
    if (raw.available !== undefined && typeof raw.available !== "boolean") errors.push(`${at}: available must be true or false when given`);
    if (errors.length === before) products.push({ ...raw, id });
  });
  return errors.length ? { ok: false, errors: errors.slice(0, 12) } : { ok: true, products };
}

// ---------------------------------------------------------------- product photos

const MAX_IMAGE_URL = 500;

/**
 * The product photo the gate would keep (gate/src/shops/sfcc.ts safeImage): an absolute https URL of at most 500 characters, no user name,
 * password or port, on the shop's domain or one of its subdomains. Anything else is dropped by the gate and the app draws its placeholder.
 * The app fetches the photo itself; the gate never does, which is why the rule is "own domain" and a foreign CDN is not accepted.
 * @returns {string|undefined} the URL when it would be kept
 */
export function ownImage(raw, manifest) {
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (!t || t.length > MAX_IMAGE_URL) return undefined;
  let u;
  try {
    u = new URL(t);
  } catch {
    return undefined;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port) return undefined;
  return shopHost(manifest.domain, u.hostname.toLowerCase()) ? u.href : undefined;
}

/**
 * Notes (never failures) about the photos of a valid answer: none at all, some missing, or some the gate would drop.
 * A shop that really shows no photos can ignore the first two.
 * @returns {string[]}
 */
export function imageNotes(products, manifest) {
  const notes = [];
  const total = products.length;
  const given = products.filter((p) => typeof p.image === "string" && p.image.trim());
  if (!given.length) {
    notes.push("no product has an image. If the shop's search page shows product photos, read them (the tile's img, og:image or JSON-LD image) so the app can draw them instead of a placeholder. If the shop really shows no photos, ignore this note.");
    return notes;
  }
  if (given.length < total) notes.push(`${total - given.length} of ${total} products have no image. If the shop shows a photo for them, read it too.`);
  const foreign = given.filter((p) => !ownImage(p.image, manifest)).length;
  if (foreign) notes.push(`${foreign} of ${given.length} images are not on ${manifest.domain} or a subdomain (https, absolute, no port, at most ${MAX_IMAGE_URL} characters): the gate drops them and the app draws a placeholder. Use the shop's own photo address, or leave image out.`);
  return notes;
}
