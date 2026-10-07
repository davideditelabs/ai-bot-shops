import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO, editJson, makeLib, read, remove, withCode, write } from "./helpers.mjs";
import { buildIndex, readBroken, serialize } from "../tools/index.mjs";

const sha = (dir, name) => createHash("sha256").update(readFileSync(join(dir, name))).digest("hex");

/** Adds a second shop to a temporary library: a copy of shops/example.com for another domain. */
function addShop(root, domain, change) {
  const { dir } = makeLib((d) => {
    editJson(d, "driver.json", (j) => ((j.domain = domain), (j.hosts = [`www.${domain}`, domain])));
    editJson(d, "RESULT.json", (j) => (j.domain = domain));
    change?.(d);
  }, domain);
  mkdirSync(join(root, "shops", domain), { recursive: true });
  for (const f of ["driver.json", "index.mjs", "RESULT.json", "PROVENANCE.json"]) {
    try {
      writeFileSync(join(root, "shops", domain, f), readFileSync(join(dir, f)));
    } catch {
      // not in this folder
    }
  }
}

test("the index of an empty library is empty", () => {
  const { root } = makeLib((d) => remove(d, "."));
  assert.deepEqual(buildIndex({ root }), { contract: 1, commit: null, count: 0, drivers: [] });
});

test("an entry has domain, hosts, contract, actions, file hashes and ownDomainOnly", () => {
  const { root, dir } = makeLib();
  const idx = buildIndex({ root, commit: "abc123" });
  assert.equal(idx.commit, "abc123");
  assert.equal(idx.count, 1);
  const e = idx.drivers[0];
  assert.equal(e.domain, "example.com");
  assert.equal(e.name, "Example");
  assert.deepEqual(e.hosts, ["example.com", "www.example.com"]);
  assert.equal(e.contract, 1);
  assert.deepEqual(e.actions, ["search"]);
  assert.equal(e.ownDomainOnly, true);
  assert.equal(e.broken, false);
  assert.equal(e.files["index.mjs"], sha(dir, "index.mjs"));
  assert.equal(e.files["driver.json"], sha(dir, "driver.json"));
  assert.deepEqual(Object.keys(e.files), ["PROVENANCE.json", "RESULT.json", "driver.json", "index.mjs"]);
});

test("the output is deterministic and sorted by domain", () => {
  const { root } = makeLib();
  addShop(root, "zeta.pt");
  addShop(root, "alpha.pt");
  const a = serialize(buildIndex({ root }));
  const b = serialize(buildIndex({ root }));
  assert.equal(a, b);
  assert.deepEqual(JSON.parse(a).drivers.map((d) => d.domain), ["alpha.pt", "example.com", "zeta.pt"]);
  assert.ok(a.endsWith("}\n"));
});

test("broken.json marks drivers broken, as a list or as a map with reasons", () => {
  const { root } = makeLib();
  addShop(root, "other.pt");
  const list = buildIndex({ root, broken: new Map([["other.pt", ""]]) });
  assert.equal(list.drivers.find((d) => d.domain === "other.pt").broken, true);
  assert.equal(list.drivers.find((d) => d.domain === "example.com").broken, false);
  assert.ok(!("brokenReason" in list.drivers[0]));
  const map = buildIndex({ root, broken: new Map([["example.com", "search answers 404"]]) });
  assert.equal(map.drivers.find((d) => d.domain === "example.com").brokenReason, "search answers 404");
});

test("readBroken reads both shapes, a missing file and refuses others", () => {
  const { root } = makeLib();
  const put = (name, text) => (writeFileSync(join(root, name), text), join(root, name));
  assert.deepEqual([...readBroken(put("a.json", '["x.pt"]'))], [["x.pt", ""]]);
  assert.deepEqual([...readBroken(put("b.json", '{"x.pt":"gone"}'))], [["x.pt", "gone"]]);
  assert.equal(readBroken(join(root, "none.json")).size, 0);
  assert.throws(() => readBroken(put("c.json", "[1]")), /broken\.json must be/);
});

test("a foreign host is carried into the index as ownDomainOnly false", () => {
  const { root } = makeLib((d) => editJson(d, "driver.json", (j) => j.hosts.push("cdn.other.net")));
  assert.equal(buildIndex({ root }).drivers[0].ownDomainOnly, false);
});

test("a folder that fails its check stops the index with the problems listed", () => {
  const { root } = makeLib((d) => withCode(d, "eval('1');"));
  assert.throws(() => buildIndex({ root }), /cannot index a library with problems[\s\S]*eval is not allowed/);
});

test("a failed result is a record of a try and is left out", () => {
  const { root } = makeLib();
  addShop(root, "failed.pt", (d) => {
    remove(d, "driver.json");
    remove(d, "index.mjs");
    write(d, "RESULT.json", JSON.stringify({ job: "j", domain: "failed.pt", status: "failed", attempt: 5, notes: "blocked", files: [] }));
  });
  assert.deepEqual(buildIndex({ root }).drivers.map((d) => d.domain), ["example.com"]);
});

test("a contract version in PROVENANCE.json is carried over", () => {
  const { root } = makeLib();
  assert.equal(buildIndex({ root }).drivers[0].contract, 1);
  assert.equal(read(join(root, "shops", "example.com"), "PROVENANCE.json").includes('"contract": 1'), true);
});

test("cli: --stdout prints the index of the repo's empty library", () => {
  const r = spawnSync(process.execPath, [join(REPO, "tools", "index.mjs"), "--stdout", "--commit", "deadbeef"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { contract: 1, commit: "deadbeef", count: 0, drivers: [] });
});
