// Shared by the tests: builds a temporary library root with shops/example.com copied from test/fixtures, then lets a test change it.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = join(REPO, "test", "fixtures", "example.com");

/** A temporary root with shops/<domain>/ holding the good fixture. `change(dir)` may edit the folder. Returns { root, dir }. */
export function makeLib(change, domain = "example.com") {
  const root = mkdtempSync(join(tmpdir(), "shops-test-"));
  const dir = join(root, "shops", domain);
  mkdirSync(dir, { recursive: true });
  cpSync(FIXTURE, dir, { recursive: true });
  renameSync(join(dir, "index.mjs.txt"), join(dir, "index.mjs"));
  if (change) change(dir);
  return { root, dir };
}

export const write = (dir, name, text) => writeFileSync(join(dir, name), text);
export const read = (dir, name) => readFileSync(join(dir, name), "utf8");
export const remove = (dir, name) => rmSync(join(dir, name), { recursive: true, force: true });
export const editJson = (dir, name, fn) => {
  const j = JSON.parse(read(dir, name));
  fn(j);
  write(dir, name, JSON.stringify(j, null, 2));
};
/** The code of the good fixture with a line added after the ORIGIN constant. */
export const withCode = (dir, extra) => write(dir, "index.mjs", read(dir, "index.mjs").replace('const ORIGIN = "https://www.example.com";', `const ORIGIN = "https://www.example.com";\n${extra}`));
