#!/usr/bin/env node
// Runs a driver's search against the live shop, the way the AI-Bot gate would, and checks the answer's shape.
//   node tools/probe.mjs shops/celeiro.pt [--word arroz] [--json]
// The word comes from the common-word list (never a user's item). Without --word the driver's own probe word is tried first, then the
// rest of the list, until a word gives at least 3 products (the same as the gate's auto driver). The driver runs in its own Node process
// under the permission model; its http() is answered here with the gate's restrictions: only hosts in driver.json, https, GET/HEAD,
// no forbidden paths, no headers to the shop's own host except accept. The network is injectable (`net`) so tests use a stub.
// Plain Node 20+ ESM, no dependencies. Contract version 1 (CONTRACT.md).
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMON_WORDS, NO_PRODUCTS, driverPathRefused, productsOf, readManifest, shopHost } from "./lib/contract.mjs";

const RUNNER = realpathSync(fileURLToPath(new URL("./runner.mjs", import.meta.url)));
const READ_METHODS = new Set(["GET", "HEAD"]);
/** Request headers a driver may not set at all (the gate owns identity and framing). */
const DROP = new Set(["host", "cookie", "authorization", "proxy-authorization", "content-length", "connection", "transfer-encoding"]);
const MIN_PRODUCTS = 3;
const MAX_BODY = 2_000_000;
const MAX_REDIRECTS = 5;

/**
 * The http() a driver is given: checks the request, then asks `net`. `net({ method, url, headers })` answers { status, headers, body }.
 * Throws an Error with a plain reason when the request is not allowed (the driver sees it as a failed http() call).
 */
export function guardedHttp(manifest, net) {
  return async (req) => {
    const method = String(req?.method || "GET").toUpperCase();
    if (!READ_METHODS.has(method)) throw new Error(`a driver only reads: GET or HEAD, not ${method}`);
    let u;
    try {
      u = new URL(String(req?.url));
    } catch {
      throw new Error(`${String(req?.url).slice(0, 80)} is not a URL`);
    }
    const host = u.hostname.toLowerCase();
    if (u.protocol !== "https:") throw new Error("only https requests are allowed");
    if (u.username || u.password) throw new Error("addresses with a user name or password are not allowed");
    if (!manifest.hosts.includes(host)) throw new Error(`${host} is not in driver.json hosts`);
    if (driverPathRefused(u.pathname, u.search)) throw new Error(`${u.pathname} is not allowed for a search (no basket, checkout, payment, order or account pages)`);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers || {})) {
      if (DROP.has(k.toLowerCase())) continue;
      if (shopHost(manifest.domain, host) && k.toLowerCase() !== "accept") throw new Error(`headers can only be sent to other hosts in driver.json, not to ${host} itself`);
      headers[k] = String(v);
    }
    const a = await net({ method, url: u.href, headers });
    return { status: a.status, headers: a.headers || {}, body: String(a.body ?? "").slice(0, MAX_BODY) };
  };
}

/** The real network: global fetch, redirects followed by hand and only to hosts the same checks allow, the body capped. */
export function realNet(manifest, fetchImpl = globalThis.fetch) {
  const check = guardedHttp(manifest, async () => ({ status: 0, body: "" }));
  return async function net({ method, url, headers }) {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetchImpl(current, { method, headers: { "user-agent": "ai-bot-shops-probe/1", ...headers }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        current = new URL(res.headers.get("location"), current).href;
        await check({ method, url: current }); // the same host and path rules apply to where a redirect leads
        continue;
      }
      const text = method === "HEAD" ? "" : (await res.text()).slice(0, MAX_BODY);
      return { status: res.status, headers: { "content-type": res.headers.get("content-type") || "" }, body: text };
    }
    throw new Error("too many redirects");
  };
}

/** `--permission` on Node 23.5 and later, `--experimental-permission` before. */
function permissionFlag() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 5) ? "--permission" : "--experimental-permission";
}

/** Runs run("search", { q }, http) of the driver in `dir` in a sandboxed child; resolves { ok, data } or { ok: false, error, log }. */
export function runSearch(dir, word, http, timeoutMs = 20_000) {
  const real = realpathSync(dir);
  return new Promise((done) => {
    const child = spawn(process.execPath, [permissionFlag(), `--allow-fs-read=${real}`, `--allow-fs-read=${RUNNER}`, "--max-old-space-size=128", "--disable-warning=ExperimentalWarning", RUNNER], { env: {}, stdio: ["pipe", "pipe", "pipe"] });
    let finished = false;
    let buffer = "";
    let log = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (log = (log + c).slice(-2000)));
    const end = (r) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      done(!r.ok && log.trim() ? { ...r, log: log.trim() } : r);
    };
    const timer = setTimeout(() => end({ ok: false, error: `the driver did not answer within ${timeoutMs / 1000} seconds` }), timeoutMs);
    child.on("error", (e) => end({ ok: false, error: `could not start the driver: ${e.message}` }));
    child.on("exit", () => setTimeout(() => end({ ok: false, error: "the driver stopped without an answer" }), 50));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", async (chunk) => {
      buffer += chunk;
      if (buffer.length > 4_000_000) return end({ ok: false, error: "the driver printed too much" });
      let nl;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        let m;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        if (m.type === "result") end(m.ok ? { ok: true, data: m.data } : { ok: false, error: String(m.error) });
        else if (m.type === "http") {
          let reply;
          try {
            reply = { type: "http-result", id: m.id, res: await http(m.req) };
          } catch (e) {
            reply = { type: "http-result", id: m.id, error: e instanceof Error ? e.message : String(e) };
          }
          if (!finished) child.stdin.write(`${JSON.stringify(reply)}\n`);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ type: "start", dir: real, action: "search", params: { q: word } })}\n`);
  });
}

/** Whether the words are ones the probe may use. */
export const isCommonWord = (w) => COMMON_WORDS.includes(String(w).trim().toLowerCase());

/**
 * Probes the driver in `dir`: reads driver.json, tries the words, validates the product shape.
 * @param {{ dir: string, word?: string, net?: Function, fetchImpl?: Function, timeoutMs?: number }} opts
 * @returns {Promise<{ ok: boolean, domain?: string, word?: string, products?: object[], tried: Array<{word: string, outcome: string}>, errors: string[] }>}
 */
export async function probeDriver({ dir, word, net, fetchImpl, timeoutMs }) {
  const errors = [];
  let raw;
  try {
    raw = JSON.parse(readFileSync(join(dir, "driver.json"), "utf8"));
  } catch {
    return { ok: false, tried: [], errors: ["driver.json is missing or is not valid JSON (run node tools/check.mjs first)"] };
  }
  const read = readManifest(raw);
  if (read.problems) return { ok: false, tried: [], errors: read.problems.map((p) => `driver.json: ${p.message}. ${p.fix}`) };
  const { manifest } = read;
  if (word !== undefined && !isCommonWord(word)) return { ok: false, domain: manifest.domain, tried: [], errors: [`the probe word must come from the common-word list (${COMMON_WORDS.join(", ")}), never a user's item`] };
  const words = word !== undefined ? [word.trim().toLowerCase()] : [manifest.probe, ...COMMON_WORDS.filter((w) => w !== manifest.probe)];
  const http = guardedHttp(manifest, net ?? realNet(manifest, fetchImpl));
  const tried = [];
  for (const w of words) {
    const r = await runSearch(dir, w, http, timeoutMs);
    if (!r.ok) {
      tried.push({ word: w, outcome: "run failed" });
      errors.push(`the driver failed on "${w}": ${r.error}${r.log ? `\n  its last output: ${r.log}` : ""}`);
      return { ok: false, domain: manifest.domain, tried, errors };
    }
    const c = productsOf(r.data, manifest);
    if (!c.ok) {
      if (c.errors.length === 1 && c.errors[0].startsWith(NO_PRODUCTS)) {
        tried.push({ word: w, outcome: "no products" });
        continue;
      }
      tried.push({ word: w, outcome: "wrong shape" });
      errors.push(...c.errors.map((e) => `"${w}": ${e}`));
      return { ok: false, domain: manifest.domain, tried, errors };
    }
    tried.push({ word: w, outcome: `${c.products.length} products` });
    if (c.products.length >= MIN_PRODUCTS || word !== undefined) return { ok: true, domain: manifest.domain, word: w, products: c.products, tried, errors };
  }
  errors.push(`no word on the list gave ${MIN_PRODUCTS} products or more (tried: ${tried.map((t) => `${t.word}: ${t.outcome}`).join(", ")})`);
  return { ok: false, domain: manifest.domain, tried, errors };
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const wi = argv.indexOf("--word");
  const word = wi >= 0 ? argv[wi + 1] : undefined;
  const dirs = argv.filter((a, i) => !a.startsWith("--") && !(wi >= 0 && i === wi + 1));
  if (dirs.length !== 1) {
    console.error("usage: node tools/probe.mjs shops/<domain> [--word w] [--json]");
    process.exitCode = 2;
    return;
  }
  const r = await probeDriver({ dir: resolve(dirs[0]), ...(word !== undefined ? { word } : {}) });
  if (json) console.log(JSON.stringify(r, null, 2));
  else if (r.ok) {
    console.log(`OK: ${dirs[0]} answered "${r.word}" with ${r.products.length} products`);
    for (const p of r.products.slice(0, 3)) console.log(`  ${p.id}  ${p.name}  ${p.price}  ${p.url}`);
  } else {
    console.log(`FAILED: ${dirs[0]}`);
    for (const e of r.errors) console.log(`  - ${e}`);
    for (const t of r.tried) console.log(`  tried "${t.word}": ${t.outcome}`);
  }
  process.exitCode = r.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
