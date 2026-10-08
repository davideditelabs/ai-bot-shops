import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { REPO, editJson, makeLib, read, remove, withCode, write } from "./helpers.mjs";
import { checkDiffNames, checkFolder, forbiddenPathsIn, personalDataIn, run, scanCode, stringLiterals } from "../tools/check.mjs";

const codes = (r) => r.problems.map((p) => p.code);
const check = (change) => {
  const { dir } = makeLib(change);
  return checkFolder(dir, "shops/example.com");
};

test("the good fixture passes, with no problems and its own domain only", () => {
  const r = check();
  assert.deepEqual(r.problems, []);
  assert.equal(r.ownDomainOnly, true);
  assert.equal(r.domain, "example.com");
  assert.deepEqual(r.files, ["PROVENANCE.json", "RESULT.json", "driver.json", "index.mjs"]);
});

test("the fixture also passes with only the two driver files", () => {
  const r = check((d) => (remove(d, "RESULT.json"), remove(d, "PROVENANCE.json")));
  assert.deepEqual(r.problems, []);
});

test("every problem comes with a plain-language fix", () => {
  const r = check((d) => (editJson(d, "driver.json", (j) => (j.hosts = "nope")), withCode(d, "eval('1');")));
  assert.ok(r.problems.length >= 2);
  for (const p of r.problems) assert.ok(p.fix.length > 10, p.code);
});

for (const [label, change, code] of [
  ["a driver.json that is not JSON", (d) => write(d, "driver.json", "{ nope"), "manifest-json"],
  ["a driver.json that is not an object", (d) => write(d, "driver.json", "[]"), "manifest-shape"],
  ["a missing domain", (d) => editJson(d, "driver.json", (j) => delete j.domain), "manifest-domain"],
  ["a private domain", (d) => editJson(d, "driver.json", (j) => (j.domain = "shop.local")), "manifest-domain"],
  ["a missing name", (d) => editJson(d, "driver.json", (j) => delete j.name), "manifest-name"],
  ["hosts that is not a list", (d) => editJson(d, "driver.json", (j) => (j.hosts = "www.example.com")), "manifest-hosts"],
  ["too many hosts", (d) => editJson(d, "driver.json", (j) => (j.hosts = ["a.example.com", "b.example.com", "c.example.com", "d.example.com", "e.example.com", "f.example.com"])), "manifest-hosts"],
  ["an IP address as a host", (d) => editJson(d, "driver.json", (j) => j.hosts.push("10.0.0.1")), "manifest-hosts"],
  ["hosts with no host on the domain", (d) => editJson(d, "driver.json", (j) => (j.hosts = ["other.org"])), "manifest-hosts"],
  ["a missing probe", (d) => editJson(d, "driver.json", (j) => delete j.probe), "manifest-probe"],
  ["a probe word that is not on the common-word list", (d) => editJson(d, "driver.json", (j) => (j.probe = "my usual brand")), "probe-word"],
  ["recorded tests", (d) => editJson(d, "driver.json", (j) => (j.tests = [{ params: { q: "milk" }, http: [] }])), "manifest-tests"],
  ["a domain that does not match the folder", (d) => editJson(d, "driver.json", (j) => ((j.domain = "other.com"), (j.hosts = ["www.other.com"]))), "manifest-folder"],
  ["a missing driver.json", (d) => remove(d, "driver.json"), "missing-file"],
  ["a missing index.mjs", (d) => remove(d, "index.mjs"), "missing-file"],
  ["an index.mjs with no run", (d) => write(d, "index.mjs", "export const nothing = 1;\n"), "no-run"],
]) {
  test(`bad manifest or shape: ${label}`, () => {
    const r = check(change);
    assert.ok(codes(r).includes(code), `${code} expected, got ${codes(r)}`);
    assert.ok(r.problems.length > 0);
  });
}

for (const [label, snippet] of [
  ["eval", "eval('1');"],
  ["new Function", "const f = new Function('return 1');"],
  ["dynamic import", "const m = await import('node:fs');"],
  ["require", "const fs = require('node:fs');"],
  ["process", "const e = process.env;"],
  ["globalThis", "const g = globalThis;"],
  ["WebAssembly", "const w = WebAssembly;"],
  ["fetch", "const r = await fetch('https://www.example.com/');"],
  ["a long encoded blob", `const b = "${"A1b2".repeat(60)}";`],
]) {
  test(`scan hit: ${label}`, () => {
    const r = check((d) => withCode(d, snippet));
    assert.ok(codes(r).includes("scan"), `scan expected, got ${codes(r)}`);
  });
}

test("scan hit: an import of an outside module, but not of a ./ file", () => {
  assert.ok(codes(check((d) => write(d, "index.mjs", `import fs from "node:fs";\n${read(d, "index.mjs")}`))).includes("scan"));
  assert.equal(scanCode(new Map([["index.mjs", 'import { x } from "./helper.mjs";\n']])).length, 0);
});

test("scanCode only looks at .mjs files and names the file", () => {
  const hits = scanCode(new Map([["driver.json", "eval("], ["index.mjs", "eval(1)"]]));
  assert.deepEqual(hits.map((h) => h.file), ["index.mjs"]);
});

for (const path of ["/checkout/cart", "/cart", "/pt/account/login", "/conta", "/encomendas", "/pagamento", "/shop/wishlist", "/logout", "/search?add-to-cart=12", "/index.php?controller=cart", "/index.php?route=checkout/cart"]) {
  test(`forbidden path in code: ${path}`, () => {
    const r = check((d) => withCode(d, `const NEXT = "${path}";`));
    assert.ok(codes(r).includes("forbidden-path"), `forbidden-path expected for ${path}, got ${codes(r)}`);
  });
}

test("a full address to a forbidden page is found; harmless paths and comments are not", () => {
  assert.equal(forbiddenPathsIn('const a = "https://www.example.com/checkout";').length, 1);
  assert.equal(forbiddenPathsIn('const a = "/search?q=" + x; const b = "/products/"; const c = "/wp-json/wc/store/v1/products?per_page=20&search=";').length, 0);
  assert.equal(forbiddenPathsIn("// the shop's /checkout page is not touched\nconst a = 1;").length, 0);
  assert.equal(forbiddenPathsIn("const re = /data-id=[\"'](\\d+)[\"']/; const a = \"/ok\";").length, 0);
  assert.equal(forbiddenPathsIn("/* \"/cart\" */ const a = 1;").length, 0);
});

test("stringLiterals sees strings and templates with their lines, not comments or regexes", () => {
  const got = stringLiterals('// "no"\nconst a = "one";\nconst b = `two`;\nconst r = /"x"/g;\nconst c = \'three\';');
  assert.deepEqual(got.map((g) => [g.value, g.line]), [["one", 2], ["two", 3], ["three", 5]]);
});

test("three files: a third driver file is refused", () => {
  const r = check((d) => write(d, "helper.mjs", "export const x = 1;\n"));
  assert.ok(codes(r).includes("extra-file"));
  assert.match(r.problems.find((p) => p.code === "extra-file").message, /at most 2 files/);
});

test("a folder, a link and an odd file name are refused", () => {
  const { dir } = makeLib((d) => {
    mkdirSync(join(d, "sub"));
    symlinkSync("/etc/hostname", join(d, "link.json"));
    writeFileSync(join(d, "evil name.mjs"), "x");
    writeFileSync(join(d, "..hidden"), "x");
    writeFileSync(join(d, ".DS_Store"), "x");
  });
  const r = checkFolder(dir);
  assert.ok(codes(r).includes("file-kind"));
  assert.ok(codes(r).filter((c) => c === "file-name").length >= 3);
});

test("a 61 KB file is refused, a file just under 60 KB is not", () => {
  const filler = (kb) => `\n// ${"lorem ipsum ".repeat(Math.ceil((kb * 1024) / 12))}\n`;
  const big = check((d) => write(d, "index.mjs", read(d, "index.mjs") + filler(61)));
  assert.ok(codes(big).includes("file-size"));
  assert.match(big.problems.find((p) => p.code === "file-size").message, /limit is 60 KB/);
  const ok = check((d) => write(d, "index.mjs", read(d, "index.mjs") + filler(40)));
  assert.deepEqual(ok.problems, []);
});

for (const [label, text, kind] of [
  ["an e-mail address", "// contact: maria.silva@gmail.com", "email"],
  ["a phone number with a country code", "// call +351 912 345 678", "phone number"],
  ["a phone number in groups", "// call 912 345 678", "phone number"],
  ["a long run of digits", "const n = 351912345678;", "phone number"],
  ["an IBAN", "// pay to PT50 0002 0123 1234 5678 9015 4", "IBAN"],
  ["an IBAN without spaces", "// pay to PT50000201231234567890154", "IBAN"],
  ["a URL with a query value", 'const u = "https://www.example.com/p?utm_source=newsletter&id=7";', "URL with query values"],
  ["a long hex string", 'const k = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";', "long token"],
  ["a UUID", 'const k = "123e4567-e89b-12d3-a456-426614174000";', "long token"],
  ["a base64 token", 'const k = "dGhpc0lzQVNlY3JldFRva2VuMTIzNDU2Nzg5MA";', "long token"],
  ["the word cookie", "// sets a cookie", "cookie or authorization word"],
  ["the word set-cookie", 'const h = "Set-Cookie";', "cookie or authorization word"],
  ["the word authorization", 'const h = { Authorization: "x" };', "cookie or authorization word"],
  ["the word session", "const session = 1;", "cookie or authorization word"],
]) {
  test(`personal data: ${label}`, () => {
    const r = check((d) => withCode(d, text));
    const hit = r.problems.find((p) => p.code === "personal-data" && p.message.includes(kind));
    assert.ok(hit, `${kind} expected, got ${r.problems.map((p) => p.message)}`);
    // The value itself is never repeated in the report.
    assert.ok(!hit.message.includes("maria.silva@gmail.com") && !hit.message.includes("912 345 678") && !hit.message.includes("9f86d081884c7d659a2f"));
  });
}

test("personal data is also found in the metadata files", () => {
  const r = check((d) => editJson(d, "RESULT.json", (j) => (j.notes = "asked maria@example.org for the login")));
  assert.ok(r.problems.some((p) => p.file === "RESULT.json" && p.code === "personal-data"));
});

test("ordinary driver text is not personal data", () => {
  const text = [
    'const p = { price: "1.299,00 €", size: "1,5 L" };',
    'const U = "/wp-json/wc/store/v1/products?per_page=20&search=";',
    "const LIMIT = 40; // up to 10.000 items",
    'const image = "logo@2x.png";',
    'const slug = "leite-meio-gordo-mimosa-1l-embalagem-familiar-2";',
    "// a possession of the shop",
  ].join("\n");
  assert.deepEqual(personalDataIn(text), []);
});

test("a foreign host is allowed but flagged ownDomainOnly false", () => {
  const r = check((d) => editJson(d, "driver.json", (j) => j.hosts.push("cdn.other-site.net")));
  assert.deepEqual(r.problems, []);
  assert.equal(r.ownDomainOnly, false);
  assert.match(r.warnings.join(" "), /ownDomainOnly is false/);
});

test("a subdomain of the shop counts as its own domain", () => {
  const r = check((d) => editJson(d, "driver.json", (j) => j.hosts.push("api.example.com")));
  assert.equal(r.ownDomainOnly, true);
});

test("RESULT.json is validated when present", () => {
  const bad = (fn) => codes(check((d) => editJson(d, "RESULT.json", fn)));
  assert.ok(bad((j) => (j.status = "maybe")).includes("result-status"));
  assert.ok(bad((j) => (j.attempt = 0)).includes("result-attempt"));
  assert.ok(bad((j) => (j.attempt = "1")).includes("result-attempt"));
  assert.ok(bad((j) => delete j.job).includes("result-job"));
  assert.ok(bad((j) => (j.domain = "other.com")).includes("result-domain"));
  assert.ok(bad((j) => (j.notes = 5)).includes("result-notes"));
  assert.ok(bad((j) => (j.files = ["driver.json", "evil.sh"])).includes("result-files"));
  assert.ok(bad((j) => (j.files = ["driver.json"])).includes("result-files"));
  assert.ok(bad((j) => (j.extra = 1)).includes("result-field"));
  assert.ok(codes(check((d) => write(d, "RESULT.json", "nope"))).includes("result-json"));
});

test("a failed RESULT.json may stand alone, without driver files", () => {
  const r = check((d) => {
    remove(d, "driver.json");
    remove(d, "index.mjs");
    remove(d, "PROVENANCE.json");
    write(d, "RESULT.json", JSON.stringify({ job: "job-2", domain: "example.com", status: "failed", attempt: 5, notes: "The shop shows a bot check.", files: [] }));
  });
  assert.deepEqual(r.problems, []);
  assert.equal(r.status, "failed");
});

test("PROVENANCE.json is validated when present", () => {
  const bad = (fn) => codes(check((d) => editJson(d, "PROVENANCE.json", fn)));
  assert.ok(bad((j) => (j.contract = 2)).includes("provenance-contract"));
  assert.ok(bad((j) => (j.builtAt = "yesterday")).includes("provenance-date"));
  assert.ok(bad((j) => (j.source = "http://x.org/?a=b")).includes("provenance-source"));
  assert.ok(bad((j) => (j.secret = "x")).includes("provenance-field"));
});

test("the folder name under shops/ must be a shop domain", () => {
  const { dir } = makeLib(undefined, "www.example.com");
  assert.ok(codes(checkFolder(dir)).includes("folder-name"));
  const { dir: d2 } = makeLib(undefined, "Example_Shop");
  assert.ok(codes(checkFolder(d2)).includes("folder-name"));
});

test("a shops/ with only .gitkeep passes; a stray file in shops/ does not", () => {
  const { root } = makeLib((d) => remove(d, "."), "example.com");
  mkdirSync(join(root, "shops"), { recursive: true });
  writeFileSync(join(root, "shops", ".gitkeep"), "");
  const empty = run({ root });
  assert.equal(empty.ok, true);
  assert.equal(empty.folders.length, 0);
  writeFileSync(join(root, "shops", "notes.txt"), "x");
  assert.equal(run({ root }).ok, false);
});

test("run() with no paths checks every folder and reports each problem", () => {
  const { root } = makeLib((d) => withCode(d, "eval('1');"));
  const r = run({ root });
  assert.equal(r.ok, false);
  assert.equal(r.folders.length, 1);
  assert.equal(r.folders[0].folder, "shops/example.com");
});

// ---- --diff-names

test("diff names: files inside one shop folder pass", () => {
  const r = checkDiffNames(["shops/example.com/driver.json", "shops/example.com/index.mjs", "shops/example.com/RESULT.json"]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.domains, ["example.com"]);
  assert.equal(checkDiffNames([]).ok, true);
});

test("diff names: the builder's subagent file passes on its own, and only on its own", () => {
  const agent = ".claude/agents/driver-builder.md";
  assert.equal(checkDiffNames([agent]).ok, true);
  assert.equal(checkDiffNames([agent, ""]).ok, true);
  for (const names of [[agent, "shops/example.com/index.mjs"], [agent, "README.md"], [".claude/agents/other.md"], [".claude/settings.json"], [agent, agent + "x"]]) {
    const r = checkDiffNames(names);
    assert.equal(r.ok, false, names.join(","));
    assert.ok(r.problems.some((p) => p.code === "diff-outside"));
  }
});

test("the builder's subagent file: Sonnet 5.5, the tools it needs, no way to publish", () => {
  const src = readFileSync(join(REPO, ".claude", "agents", "driver-builder.md"), "utf8");
  const [, front, body] = src.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  const field = (k) => front.match(new RegExp(`^${k}:\\s*(.+)$`, "m"))?.[1].trim();
  assert.equal(field("name"), "driver-builder");
  assert.equal(field("model"), "claude-sonnet-5-5");
  assert.ok(field("description").length > 20);
  assert.deepEqual(field("tools").split(/\s*,\s*/), ["Read", "Edit", "Write", "Bash", "Glob", "Grep", "WebFetch"]);
  for (const must of ["node tools/check.mjs shops/<domain>", "node tools/probe.mjs shops/<domain>", "untrusted", "CONTRACT.md"]) assert.ok(body.includes(must), must);
});

for (const [label, names, code] of [
  ["a top-level change", ["shops/example.com/index.mjs", "README.md"], "diff-outside"],
  ["a workflow change", ["shops/example.com/index.mjs", ".github/workflows/ci.yml"], "diff-outside"],
  ["a tools change", ["tools/check.mjs"], "diff-outside"],
  ["the index", ["index.json"], "diff-outside"],
  ["two shops", ["shops/example.com/index.mjs", "shops/other.org/index.mjs"], "diff-many"],
  ["a file placed in shops/ itself", ["shops/x.mjs"], "diff-outside"],
  ["a nested file", ["shops/example.com/sub/index.mjs"], "diff-outside"],
  ["a file name that is not allowed", ["shops/example.com/helper.mjs"], "diff-file"],
  ["path traversal", ["shops/example.com/../../etc/passwd"], "diff-odd"],
  ["an absolute path", ["/etc/passwd"], "diff-odd"],
  ["a backslash path", ["shops\\example.com\\index.mjs"], "diff-odd"],
  ["a quoted odd name from git", ['"shops/example.com/caf\\303\\251.mjs"'], "diff-odd"],
  ["a www folder", ["shops/www.example.com/index.mjs"], "diff-domain"],
]) {
  test(`diff names: ${label} is refused`, () => {
    const r = checkDiffNames(names);
    assert.equal(r.ok, false);
    assert.ok(r.problems.some((p) => p.code === code), `${code} expected, got ${r.problems.map((p) => p.code)}`);
    assert.ok(r.problems.every((p) => p.fix.length > 10));
  });
}

// ---- the command line

const cli = (args, opts = {}) => spawnSync(process.execPath, [join(REPO, "tools", "check.mjs"), ...args], { encoding: "utf8", ...opts });

test("cli: no arguments passes on the repo's own shops/, however many drivers it holds", () => {
  const r = cli([], { cwd: REPO });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const n = existsSync(join(REPO, "shops")) ? readdirSync(join(REPO, "shops"), { withFileTypes: true }).filter((e) => e.isDirectory()).length : 0;
  assert.match(r.stdout, new RegExp(`OK: ${n} folders? checked`));
});

test("cli: a bad folder exits non-zero, lists every problem with its fix, and --json reports ownDomainOnly", () => {
  const { root } = makeLib((d) => (withCode(d, "eval('1');\n// mail a@b.org"), editJson(d, "driver.json", (j) => j.hosts.push("cdn.other.net"))));
  const text = cli(["shops/example.com"], { cwd: root });
  assert.equal(text.status, 1);
  assert.match(text.stdout, /eval is not allowed/);
  assert.match(text.stdout, /email/);
  assert.match(text.stdout, /fix: /);
  const json = JSON.parse(cli(["shops/example.com", "--json"], { cwd: root }).stdout);
  assert.equal(json.ok, false);
  assert.equal(json.folders[0].ownDomainOnly, false);
});

test("cli: --json of a good folder says ownDomainOnly true", () => {
  const { root } = makeLib();
  const r = cli(["shops/example.com", "--json"], { cwd: root });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).folders[0].ownDomainOnly, true);
});

test("cli: --diff-names reads names on stdin", () => {
  const ok = cli(["--diff-names"], { input: "shops/example.com/index.mjs\nshops/example.com/driver.json\n" });
  assert.equal(ok.status, 0, ok.stdout);
  const bad = cli(["--diff-names"], { input: "shops/example.com/index.mjs\nREADME.md\n" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /outside shops/);
  assert.equal(cli(["--diff-names"], { input: "" }).status, 0);
});

test("every template passes the check", () => {
  const names = ["shopify", "magento", "woocommerce", "prestashop", "maf", "json-feed", "html"];
  for (const n of names) {
    const r = checkFolder(join(REPO, "templates", n), `templates/${n}`);
    assert.deepEqual(r.problems, [], n);
    assert.equal(r.ownDomainOnly, true, n);
  }
});
