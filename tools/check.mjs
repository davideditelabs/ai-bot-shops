#!/usr/bin/env node
// The library's gatekeeper. Usage:
//   node tools/check.mjs                      check every folder under shops/ (an empty shops/ passes)
//   node tools/check.mjs shops/celeiro.pt     check these folders (templates/<name> works too)
//   git diff --name-only origin/main...HEAD | node tools/check.mjs --diff-names
//                                             a PR may touch shops/<one-domain>/** and nothing else
//   --json                                    print the result as JSON (includes ownDomainOnly per folder)
// Exit code 0: clean. Non-zero: every problem is listed, each with a plain-language fix.
// Plain Node 20+ ESM, no dependencies. Contract version 1 (CONTRACT.md).
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONTRACT_VERSION, FORBIDDEN_PATH, driverPathRefused, publicHost, readManifest, shopHost } from "./lib/contract.mjs";

export const MAX_FILE_BYTES = 60 * 1024;
export const MAX_DRIVER_FILES = 2;
export const DRIVER_FILES = ["driver.json", "index.mjs"];
export const META_FILES = ["PROVENANCE.json", "RESULT.json"];
export const ALLOWED_FILES = [...DRIVER_FILES, ...META_FILES];
/** The one file outside shops/ a PR may change, and only on its own (the shop builder's Claude Code subagent). */
export const BUILDER_AGENT_FILE = ".claude/agents/driver-builder.md";
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/;

/** @typedef {{ file: string, code: string, message: string, fix: string }} Problem */

// ---------------------------------------------------------------- the static scan (same rules as the gate's scanCode)

// Re-implementation of gate/src/abilities/scan.ts RULES: the patterns are copied exactly; the third column is this tool's plain-language fix.
const SCAN_RULES = [
  [/\beval\s*\(/, "eval is not allowed", "Remove eval. Read values with JSON.parse or plain code."],
  [/\bnew\s+Function\b|(^|[^.\w])Function\s*\(/, "building code from text is not allowed", "Remove new Function(...). Write the logic as normal code."],
  [/\bimport\s*\(/, "dynamic import is not allowed", "Remove import(...). A driver is one self-contained file."],
  [/\brequire\s*\(/, "require is not allowed", "Remove require(...). A driver uses only the http() it is given."],
  [/^\s*(?:import|export)\s[^;]*from\s*["'](?!\.\/)[^"']*["']|^\s*import\s*["'](?!\.\/)/m, "only imports of your own files (./x.mjs) are allowed", "Remove the import of an outside module (node:..., packages, URLs). Copy the few lines you need into index.mjs."],
  [/\bprocess\s*[.[]/, "process is not available to skills", "Remove every use of process. A driver gets its input from the params of run()."],
  [/\bglobalThis\b/, "globalThis is not allowed", "Remove globalThis."],
  [/\bWebAssembly\b/, "WebAssembly is not allowed", "Remove WebAssembly."],
  [/\bfetch\s*\(/, "use the http() you are given, not fetch", "Replace fetch(...) with the http({ method: \"GET\", url }) that run() receives."],
  [/[A-Za-z0-9+/]{200,}={0,2}/, "long encoded blobs are not allowed", "Remove the long encoded text (200+ letters and digits in a row). Write the data out or fetch it from the shop."],
];

/**
 * The scanCode equivalent: a list of { file, message, fix } over every .mjs file of the given Map(name -> Buffer|string); empty means clean.
 * @param {Map<string, Buffer|string>} files
 */
export function scanCode(files) {
  const out = [];
  for (const [file, bytes] of files) {
    if (!file.endsWith(".mjs")) continue;
    const src = typeof bytes === "string" ? bytes : bytes.toString("utf8");
    for (const [re, message, fix] of SCAN_RULES) if (re.test(src)) out.push({ file, message, fix });
  }
  return out;
}

// ---------------------------------------------------------------- string literals (for the forbidden-path scan)

const KEYWORDS_BEFORE_REGEX = new Set(["return", "typeof", "case", "in", "of", "delete", "void", "throw", "else", "do", "new", "yield", "await"]);

/** The string literals of some JavaScript with their line numbers; comments and regular expressions are skipped. Not a parser: a careful scanner. */
export function stringLiterals(src) {
  const out = [];
  let i = 0;
  let line = 1;
  let prev = "";
  let word = "";
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === "\n") {
      line++;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) {
        if (src[i] === "\n") line++;
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      const start = line;
      let value = "";
      i++;
      while (i < n && src[i] !== c && (c === "`" || src[i] !== "\n")) {
        if (src[i] === "\\") {
          value += src[i] + (src[i + 1] ?? "");
          if (src[i + 1] === "\n") line++;
          i += 2;
          continue;
        }
        if (src[i] === "\n") line++;
        value += src[i++];
      }
      i++;
      out.push({ value, line: start });
      prev = c;
      word = "";
      continue;
    }
    if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || KEYWORDS_BEFORE_REGEX.has(word))) {
      i++;
      let inClass = false;
      while (i < n && src[i] !== "\n") {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "[") (inClass = true), i++;
        else if (src[i] === "]") (inClass = false), i++;
        else if (src[i] === "/" && !inClass) break;
        else i++;
      }
      i++;
      while (i < n && /[a-z]/i.test(src[i])) i++;
      prev = ")";
      word = "";
      continue;
    }
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let w = "";
      while (i < n && /[\w$]/.test(src[i])) w += src[i++];
      word = w;
      prev = "a";
      continue;
    }
    word = "";
    prev = c;
    i++;
  }
  return out;
}

/** Strings in the code that name a page a driver must never touch: "/cart", "https://shop/checkout", "/search?add-to-cart=". */
export function forbiddenPathsIn(src) {
  const hits = [];
  for (const { value, line } of stringLiterals(src)) {
    const m = /^(?:https?:\/\/[^/?#\s]+)?(\/[^?#\s]*)?(?:\?([^#\s]*))?/.exec(value);
    const isUrl = /^https?:\/\//.test(value);
    if (!m || !(isUrl || (value.startsWith("/") && !value.startsWith("//") && /^\/[^\s]*$/.test(value)))) continue;
    if (driverPathRefused(m[1] ?? "", m[2] ?? "")) hits.push({ line, value: value.slice(0, 80) });
  }
  return hits;
}

// ---------------------------------------------------------------- no personal data

const mask = (v) => (v.length <= 6 ? "***" : `${v.slice(0, 3)}... (${v.length} characters)`);
const IMAGE_TLD = /\.(?:png|jpe?g|gif|webp|svg|avif)$/i;
const BASE64ISH = /[A-Za-z0-9+]{32,}={0,2}/g;
const URL_IN_TEXT = /https?:\/\/[^\s"'`<>\\)]+/g;

/** Each rule: a name, a finder over one line (returns the matches), and the fix. */
const PERSONAL_RULES = [
  ["email", (line) => [...line.matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g)].map((m) => m[0]).filter((v) => !IMAGE_TLD.test(v)), "Remove the e-mail address. The library holds no personal data; a shop's public contact address is not needed by a driver."],
  ["phone number", (line) => [...line.matchAll(/\+\d[\d ().-]{7,}\d|(?<![\w.,/-])\(?\d{2,4}\)?[ -]\d{3,4}[ -]\d{3,4}(?!\w)|(?<![\w.,/-])\d{9,15}(?!\w)/g)].map((m) => m[0]), "Remove the phone number. If this is a shop id, read it from the page at run time instead of pasting a long number."],
  ["IBAN", (line) => [...line.matchAll(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g)].map((m) => m[0]), "Remove the bank account number."],
  [
    "URL with query values",
    (line) =>
      [...line.matchAll(URL_IN_TEXT)]
        .map((m) => m[0])
        .filter((u) => {
          const q = u.split("#")[0].split("?").slice(1).join("?");
          return q.split("&").some((pair) => pair.includes("=") && pair.slice(pair.indexOf("=") + 1).length > 0);
        })
        .map((u) => u.split("?")[0] + "?..."),
    "Remove the values from the address query (keep the key and end with =, then add the search word in code). Values can carry ids, tokens or tracking data.",
  ],
  [
    "long token",
    (line) => {
      const found = [];
      for (const m of line.matchAll(/\b[0-9a-fA-F]{32,}\b/g)) found.push(m[0]);
      for (const m of line.matchAll(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g)) found.push(m[0]);
      for (const m of line.matchAll(BASE64ISH)) if (/\d/.test(m[0]) && /[A-Za-z]/.test(m[0]) && !found.some((f) => f.includes(m[0]))) found.push(m[0]);
      for (const m of line.matchAll(/[A-Za-z0-9_-]{40,}/g)) if (/[a-z]/.test(m[0]) && /[A-Z]/.test(m[0]) && /\d/.test(m[0]) && !found.some((f) => f.includes(m[0]))) found.push(m[0]);
      return found;
    },
    "Remove the long hex or encoded value; it looks like a key, token or session id. A driver must not carry secrets.",
  ],
  ["cookie or authorization word", (line) => [...line.matchAll(/(?<![A-Za-z])(set-cookie|cookie|authorization|session)/gi)].map((m) => m[0]), "Remove it. A driver never sets or reads cookies, sessions or authorization: the gate owns identity, and the library holds no one's login."],
];

/**
 * Scans text for personal data, line by line. The matched value is never repeated in full (CI logs are public).
 * @returns {Array<{ line: number, kind: string, shown: string, fix: string }>}
 */
export function personalDataIn(text) {
  const hits = [];
  text.split(/\r?\n/).forEach((lineText, idx) => {
    for (const [kind, find, fix] of PERSONAL_RULES) for (const v of find(lineText)) hits.push({ line: idx + 1, kind, shown: kind === "cookie or authorization word" ? v : mask(v), fix });
  });
  return hits;
}

// ---------------------------------------------------------------- RESULT.json and PROVENANCE.json

const JOB = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const RESULT_KEYS = ["job", "domain", "status", "attempt", "notes", "files"];
const PROVENANCE_KEYS = ["contract", "builder", "engine", "platform", "template", "builtAt", "source"];
const isObj = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

/** RESULT.json: { job, domain, status: "built"|"failed", attempt, notes, files } (CONTRACT.md "RESULT.json"). Returns problems as { code, message, fix }. */
export function validateResult(raw, domain, present) {
  const out = [];
  const add = (code, message, fix) => out.push({ code, message, fix });
  if (!isObj(raw)) return [{ code: "result-shape", message: "RESULT.json must be an object", fix: 'Write it as { "job": "...", "domain": "...", "status": "built", "attempt": 1, "notes": "...", "files": ["driver.json", "index.mjs"] }.' }];
  for (const k of Object.keys(raw)) if (!RESULT_KEYS.includes(k)) add("result-field", `unknown field "${k.slice(0, 40)}"`, `Remove it. RESULT.json only has: ${RESULT_KEYS.join(", ")}.`);
  if (typeof raw.job !== "string" || !JOB.test(raw.job)) add("result-job", "job must be the job id: 1 to 80 letters, digits or . _ : -", 'Set "job" to the id of the build job that produced this folder.');
  if (domain && raw.domain !== domain) add("result-domain", `domain must be "${domain}", the folder's shop`, `Set "domain" to "${domain}".`);
  if (raw.status !== "built" && raw.status !== "failed") add("result-status", 'status must be "built" or "failed"', 'Set "status" to "built" when the driver passed its own checks, otherwise "failed".');
  if (!Number.isInteger(raw.attempt) || raw.attempt < 1 || raw.attempt > 99) add("result-attempt", "attempt must be a whole number from 1 to 99", 'Set "attempt" to the number of the try that produced this folder (1 for the first).');
  if (typeof raw.notes !== "string" || raw.notes.length > 2000) add("result-notes", "notes must be text of at most 2000 characters", 'Set "notes" to a short plain description of what was built or why it failed (may be an empty string).');
  if (!Array.isArray(raw.files) || raw.files.length > ALLOWED_FILES.length || raw.files.some((f) => typeof f !== "string" || !ALLOWED_FILES.includes(f)) || new Set(raw.files).size !== raw.files.length) {
    add("result-files", `files must list file names from: ${ALLOWED_FILES.join(", ")}, each once`, 'Set "files" to the files in this folder, for example ["driver.json", "index.mjs"].');
  } else {
    for (const f of raw.files) if (!present.includes(f)) add("result-files", `files lists ${f}, which is not in the folder`, `Add ${f} or remove it from "files".`);
    if (raw.status === "built") for (const f of DRIVER_FILES) if (!raw.files.includes(f)) add("result-files", `a built result must list ${f}`, `Add "${f}" to "files".`);
  }
  return out;
}

/** PROVENANCE.json: where the driver came from. All fields optional. */
export function validateProvenance(raw) {
  const out = [];
  const add = (code, message, fix) => out.push({ code, message, fix });
  if (!isObj(raw)) return [{ code: "provenance-shape", message: "PROVENANCE.json must be an object", fix: 'Write it as { "contract": 1, "builder": "routine", "platform": "shopify", "builtAt": "2026-10-07" }.' }];
  for (const k of Object.keys(raw)) if (!PROVENANCE_KEYS.includes(k)) add("provenance-field", `unknown field "${k.slice(0, 40)}"`, `Remove it. PROVENANCE.json only has: ${PROVENANCE_KEYS.join(", ")}.`);
  if (raw.contract !== undefined && (!Number.isInteger(raw.contract) || raw.contract < 1 || raw.contract > CONTRACT_VERSION)) add("provenance-contract", `contract must be a whole number from 1 to ${CONTRACT_VERSION}`, `Set "contract" to ${CONTRACT_VERSION}.`);
  for (const k of ["builder", "engine", "platform", "template"]) if (raw[k] !== undefined && (typeof raw[k] !== "string" || !/^[A-Za-z0-9 ._:-]{1,80}$/.test(raw[k]))) add("provenance-text", `${k} must be 1 to 80 letters, digits or . _ : - and spaces`, `Shorten "${k}" to a plain label.`);
  if (raw.builtAt !== undefined && (typeof raw.builtAt !== "string" || !/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z)?$/.test(raw.builtAt))) add("provenance-date", "builtAt must be a date like 2026-10-07 or 2026-10-07T09:30:00Z", 'Set "builtAt" to the build date.');
  if (raw.source !== undefined && (typeof raw.source !== "string" || !/^https:\/\/[^\s?#]{1,200}$/.test(raw.source))) add("provenance-source", "source must be an https address without ? or #", 'Set "source" to the public page the driver was derived from, without a query.');
  return out;
}

// ---------------------------------------------------------------- one folder

/**
 * Checks one driver folder. The folder name must be the shop's domain when it sits directly under a folder called "shops".
 * @returns {{ folder: string, domain: string|null, ownDomainOnly: boolean|null, hosts: string[], files: string[], status: string, problems: Problem[], warnings: string[] }}
 */
export function checkFolder(dir, label = dir) {
  const problems = [];
  const warnings = [];
  const add = (file, code, message, fix) => problems.push({ file, code, message, fix });
  const result = (extra = {}) => ({ folder: label, domain: null, ownDomainOnly: null, hosts: [], files: [], status: "built", problems, warnings, ...extra });
  const name = basename(resolve(dir));
  const underShops = basename(dirname(resolve(dir))) === "shops";

  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) {
    add(".", "folder-missing", `${label} is not a folder`, "Give the path of a driver folder, for example shops/celeiro.pt.");
    return result();
  }
  if (underShops && (!publicHost(name) || name.startsWith("www."))) {
    add(".", "folder-name", `the folder name "${name.slice(0, 80)}" is not a shop domain`, "Name the folder after the shop's domain in lower case without www, for example shops/celeiro.pt.");
  }

  // Files: names, kinds, sizes.
  const files = new Map();
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const f = entry.name;
    const odd = !SAFE_NAME.test(f) || f.includes("..");
    if (odd) {
      add(f.slice(0, 80), "file-name", `odd file name "${f.slice(0, 80)}"`, "Remove it. Only driver.json, index.mjs, PROVENANCE.json and RESULT.json are allowed, with plain names.");
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isFile()) {
      add(f, "file-kind", `${f} is a ${entry.isSymbolicLink() ? "link" : "folder"}, not a plain file`, "Remove it. A driver folder holds plain files only: no folders, no links.");
      continue;
    }
    if (!ALLOWED_FILES.includes(f)) {
      add(f, "extra-file", `${f} is not allowed: a driver is at most ${MAX_DRIVER_FILES} files (driver.json and index.mjs), plus PROVENANCE.json and RESULT.json`, `Remove ${f}. Put all the code in index.mjs.`);
      continue;
    }
    const bytes = readFileSync(join(dir, f));
    if (bytes.length > MAX_FILE_BYTES) add(f, "file-size", `${f} is ${Math.ceil(bytes.length / 1024)} KB; the limit is ${MAX_FILE_BYTES / 1024} KB`, `Make ${f} smaller: remove unused code and long data.`);
    files.set(f, bytes);
  }
  const present = [...files.keys()];

  // RESULT.json first: a failed result may leave out the driver files.
  let resultRaw;
  let failed = false;
  if (files.has("RESULT.json")) {
    try {
      resultRaw = JSON.parse(files.get("RESULT.json").toString("utf8"));
    } catch {
      add("RESULT.json", "result-json", "RESULT.json is not valid JSON", "Fix the JSON: matching quotes, commas between fields, no trailing comma.");
    }
    if (resultRaw !== undefined) {
      for (const p of validateResult(resultRaw, underShops ? name : null, present)) add("RESULT.json", p.code, p.message, p.fix);
      failed = isObj(resultRaw) && resultRaw.status === "failed";
    }
  }
  if (files.has("PROVENANCE.json")) {
    let raw;
    try {
      raw = JSON.parse(files.get("PROVENANCE.json").toString("utf8"));
    } catch {
      add("PROVENANCE.json", "provenance-json", "PROVENANCE.json is not valid JSON", "Fix the JSON: matching quotes, commas between fields, no trailing comma.");
    }
    if (raw !== undefined) for (const p of validateProvenance(raw)) add("PROVENANCE.json", p.code, p.message, p.fix);
  }

  // The manifest.
  let manifest;
  if (!files.has("driver.json")) {
    if (!failed) add("driver.json", "missing-file", "driver.json is missing", 'Add driver.json, for example { "domain": "celeiro.pt", "name": "Celeiro", "hosts": ["www.celeiro.pt", "celeiro.pt"], "probe": "arroz" }.');
  } else {
    let raw;
    try {
      raw = JSON.parse(files.get("driver.json").toString("utf8"));
    } catch {
      add("driver.json", "manifest-json", "driver.json is not valid JSON", "Fix the JSON: matching quotes, commas between fields, no trailing comma.");
    }
    if (raw !== undefined) {
      const read = readManifest(raw);
      if (read.problems) for (const p of read.problems) add("driver.json", p.code, p.message, p.fix);
      else {
        manifest = read.manifest;
        for (const w of read.warnings) warnings.push(w);
        if (underShops && manifest.domain !== name) add("driver.json", "manifest-folder", `domain "${manifest.domain}" does not match the folder name "${name}"`, `Rename the folder to shops/${manifest.domain} or set "domain" to "${name}".`);
      }
    }
  }

  // The code.
  if (!files.has("index.mjs")) {
    if (!failed) add("index.mjs", "missing-file", "index.mjs is missing", "Add index.mjs exporting async function run(action, params, http).");
  } else {
    const src = files.get("index.mjs").toString("utf8");
    for (const p of scanCode(new Map([["index.mjs", src]]))) add("index.mjs", "scan", p.message, p.fix);
    if (!/export\s+(?:async\s+)?function\s+run\b|export\s+const\s+run\b|export\s*\{[^}]*\brun\b[^}]*\}/.test(src)) add("index.mjs", "no-run", "index.mjs must export a function named run", "Export async function run(action, params, http) { ... } and return { products: [...] } for action \"search\".");
    if (!/\bimage\b/.test(src)) warnings.push("index.mjs never sets product.image. If the shop's search page shows product photos, read them (absolute https address on the shop's own domain) so the app can draw them; if it shows none, ignore this note");
    for (const h of forbiddenPathsIn(src)) add("index.mjs", "forbidden-path", `line ${h.line}: "${h.value}" names a basket, checkout, payment, order, account or login page`, "Remove it. A driver only reads search and product pages: never a basket, checkout, payment, order, account or login address, and never ?add-to-cart style queries.");
  }

  // No personal data, in every file of the folder.
  for (const [f, bytes] of files) {
    for (const h of personalDataIn(bytes.toString("utf8"))) add(f, "personal-data", `line ${h.line}: ${h.kind} (${h.shown})`, h.fix);
  }

  // Hosts: own domain only, or flagged.
  const domain = manifest?.domain ?? null;
  const hosts = manifest?.hosts ?? [];
  const ownDomainOnly = manifest ? hosts.every((h) => shopHost(manifest.domain, h)) : null;
  if (manifest && ownDomainOnly === false) warnings.push(`hosts lists a host outside ${manifest.domain} (${hosts.filter((h) => !shopHost(manifest.domain, h)).join(", ")}): ownDomainOnly is false, so this driver is never merged automatically`);

  return result({ domain, ownDomainOnly, hosts, files: present, status: failed ? "failed" : "built" });
}

// ---------------------------------------------------------------- what a PR may touch

/**
 * The names a PR changed (from `git diff --name-only`): all must be shops/<one-domain>/<file>, the file one of the four allowed names.
 * @param {string[]} names
 */
export function checkDiffNames(names) {
  // A maintainer PR that changes only the builder's subagent definition is not a shop PR: it is allowed alone, and never next to shop files.
  const listed = names.map((n) => n.replace(/\r$/, "")).filter((n) => n.trim());
  if (listed.length === 1 && listed[0] === BUILDER_AGENT_FILE) return { ok: true, domains: [], problems: [] };
  const problems = [];
  const add = (file, code, message, fix) => problems.push({ file, code, message, fix });
  const domains = new Set();
  for (const raw of names) {
    const n = raw.replace(/\r$/, "");
    if (!n.trim()) continue;
    const parts = n.split("/");
    if (n.startsWith("/") || n.includes("\\") || n.includes("\0") || parts.some((p) => p === ".." || p === "." || p === "") || n.startsWith('"')) {
      add(n.slice(0, 120), "diff-odd", `"${n.slice(0, 120)}" is not an ordinary relative file name`, "Remove it from the PR.");
      continue;
    }
    if (parts[0] !== "shops" || parts.length !== 3) {
      add(n, "diff-outside", `${n} is outside shops/<domain>/`, "A shop PR may only add, change or remove files directly inside one folder shops/<domain>/. Move this change to a separate PR for the library's maintainers.");
      continue;
    }
    const [, domain, file] = parts;
    if (!publicHost(domain) || domain.startsWith("www.")) add(n, "diff-domain", `${domain} is not a shop domain`, "Name the folder after the shop's domain in lower case without www.");
    else domains.add(domain);
    if (!ALLOWED_FILES.includes(file)) add(n, "diff-file", `${file} is not an allowed file name`, `Only ${ALLOWED_FILES.join(", ")} may be in a shop folder.`);
  }
  if (domains.size > 1) add("shops/", "diff-many", `this PR touches ${domains.size} shops (${[...domains].sort().join(", ")})`, "Open one PR per shop: split the change so each PR touches one folder shops/<domain>/.");
  return { ok: problems.length === 0, domains: [...domains].sort(), problems };
}

// ---------------------------------------------------------------- the whole library

/** Every folder under shops/ (sorted); stray files other than .gitkeep become problems of their own. */
export function shopFolders(root) {
  const shops = join(root, "shops");
  const folders = [];
  const stray = [];
  if (!existsSync(shops)) return { folders, stray };
  for (const entry of readdirSync(shops, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) folders.push(join(shops, entry.name));
    else if (entry.name !== ".gitkeep") stray.push(entry.name);
  }
  return { folders, stray };
}

function format(report) {
  const lines = [];
  for (const f of report.folders) {
    if (f.problems.length) {
      lines.push(`${f.folder}: ${f.problems.length} problem${f.problems.length === 1 ? "" : "s"}`);
      for (const p of f.problems) lines.push(`  - ${p.file}: ${p.message}`, `      fix: ${p.fix}`);
    }
    for (const w of f.warnings) lines.push(`${f.folder}: note: ${w}`);
  }
  if (report.diff) {
    if (report.diff.problems.length) lines.push(`changed files: ${report.diff.problems.length} problem${report.diff.problems.length === 1 ? "" : "s"}`);
    for (const p of report.diff.problems) lines.push(`  - ${p.file}: ${p.message}`, `      fix: ${p.fix}`);
  }
  for (const s of report.stray) lines.push(`shops/${s}: only driver folders belong in shops/`, "      fix: remove it; each shop is a folder shops/<domain>/.");
  const bad = report.folders.reduce((n, f) => n + f.problems.length, 0) + (report.diff?.problems.length ?? 0) + report.stray.length;
  if (!report.mode.diff) lines.push(bad ? `FAILED: ${bad} problem${bad === 1 ? "" : "s"} in ${report.folders.filter((f) => f.problems.length).length + (report.stray.length ? 1 : 0)} place(s)` : `OK: ${report.folders.length} folder${report.folders.length === 1 ? "" : "s"} checked${report.folders.length ? "" : " (shops/ is empty)"}`);
  else lines.push(bad ? `FAILED: ${bad} problem${bad === 1 ? "" : "s"} in the changed files` : `OK: the changed files stay inside ${report.diff.domains.length ? `shops/${report.diff.domains[0]}/` : "shops/ (nothing changed)"}`);
  return lines.join("\n");
}

/** The whole run as data; `args` are the paths, `names` the diff names when in that mode. */
export function run({ root, cwd = root, paths = [], diffNames }) {
  const report = { ok: true, mode: { diff: diffNames !== undefined }, folders: [], stray: [], diff: undefined };
  if (diffNames !== undefined) report.diff = checkDiffNames(diffNames);
  else if (paths.length) report.folders = paths.map((p) => checkFolder(resolve(cwd, p), p));
  else {
    const { folders, stray } = shopFolders(root);
    report.stray = stray;
    report.folders = folders.map((p) => checkFolder(p, `shops/${basename(p)}`));
  }
  report.ok = report.folders.every((f) => !f.problems.length) && !report.stray.length && (report.diff?.ok ?? true);
  return report;
}

async function main() {
  const argv = process.argv.slice(2);
  const json = argv.includes("--json");
  const diff = argv.includes("--diff-names");
  const paths = argv.filter((a) => !a.startsWith("--"));
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let names;
  if (diff) {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    names = Buffer.concat(chunks).toString("utf8").split("\n");
  }
  const report = run({ root, cwd: process.cwd(), paths, diffNames: names });
  if (json) console.log(JSON.stringify(report, null, 2));
  else console.log(format(report));
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
