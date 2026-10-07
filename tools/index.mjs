#!/usr/bin/env node
// Generates index.json, the library's catalogue: one entry per driver folder that passes tools/check.mjs.
//   node tools/index.mjs [--out index.json] [--broken broken.json] [--commit <sha>] [--stdout]
// broken.json (optional): either ["celeiro.pt", ...] or { "celeiro.pt": "search answers 404" }; those drivers get broken: true.
// The commit comes from --commit or the GITHUB_SHA variable; otherwise it is null. Output is deterministic: sorted, no timestamps.
// Plain Node 20+ ESM, no dependencies. Contract version 1 (CONTRACT.md).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkFolder, shopFolders } from "./check.mjs";
import { ACTIONS, CONTRACT_VERSION } from "./lib/contract.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));

/** Reads broken.json into a Map(domain -> reason|""). Throws a plain Error when it is not one of the two shapes. */
export function readBroken(path) {
  const out = new Map();
  if (!path || !existsSync(path)) return out;
  const raw = readJson(path);
  if (Array.isArray(raw) && raw.every((d) => typeof d === "string")) for (const d of raw) out.set(d, "");
  else if (raw && typeof raw === "object" && !Array.isArray(raw) && Object.values(raw).every((v) => typeof v === "string")) for (const [d, why] of Object.entries(raw)) out.set(d, why);
  else throw new Error('broken.json must be ["domain", ...] or { "domain": "reason" }');
  return out;
}

/**
 * The index as an object. Throws an Error listing the problems when a folder fails its check (the library must be clean to be indexed).
 * Folders whose RESULT.json says "failed" are left out: they are records of a try, not drivers.
 */
export function buildIndex({ root, broken = new Map(), commit = null }) {
  const drivers = [];
  const problems = [];
  const { folders } = shopFolders(root);
  for (const dir of folders) {
    const label = `shops/${basename(dir)}`;
    const c = checkFolder(dir, label);
    if (c.problems.length) {
      problems.push(...c.problems.map((p) => `${label}/${p.file}: ${p.message}`));
      continue;
    }
    if (c.status === "failed") continue;
    const manifest = readJson(join(dir, "driver.json"));
    let contract = CONTRACT_VERSION;
    if (existsSync(join(dir, "PROVENANCE.json"))) contract = readJson(join(dir, "PROVENANCE.json")).contract ?? contract;
    const files = {};
    for (const f of [...c.files].sort()) files[f] = sha256(readFileSync(join(dir, f)));
    const domain = c.domain;
    drivers.push({
      domain,
      name: String(manifest.name).trim(),
      hosts: [...c.hosts].sort(),
      contract,
      actions: ACTIONS,
      files,
      ownDomainOnly: c.ownDomainOnly,
      broken: broken.has(domain),
      ...(broken.get(domain) ? { brokenReason: broken.get(domain) } : {}),
    });
  }
  if (problems.length) throw new Error(`cannot index a library with problems:\n- ${problems.join("\n- ")}`);
  drivers.sort((a, b) => (a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0));
  return { contract: CONTRACT_VERSION, commit, count: drivers.length, drivers };
}

export const serialize = (index) => `${JSON.stringify(index, null, 2)}\n`;

function main() {
  const argv = process.argv.slice(2);
  const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  try {
    const index = buildIndex({ root, broken: readBroken(arg("--broken") ?? join(root, "broken.json")), commit: arg("--commit") ?? process.env.GITHUB_SHA ?? null });
    if (argv.includes("--stdout")) process.stdout.write(serialize(index));
    else {
      const out = resolve(arg("--out") ?? join(root, "index.json"));
      writeFileSync(out, serialize(index));
      console.log(`wrote ${out}: ${index.count} driver${index.count === 1 ? "" : "s"}`);
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
