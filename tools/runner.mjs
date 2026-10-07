// Runs inside the probe's child process (started by tools/probe.mjs under Node's permission model: it can read only the driver folder and
// this file, and has no network, child processes or workers). It imports the driver's index.mjs, calls run(action, params, http) and
// speaks JSON lines on stdio: http() becomes a message the parent answers. A simplified mirror of the AI-Bot gate's connector runner.
import { createInterface } from "node:readline";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const pending = new Map();
let next = 0;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
// The protocol owns stdout; anything the driver prints goes to stderr.
console.log = (...a) => process.stderr.write(`${a.map(String).join(" ")}\n`);

const finish = (m) => process.stdout.write(`${JSON.stringify({ type: "result", ...m })}\n`, () => process.stderr.write("", () => process.exit(0)));

createInterface({ input: process.stdin }).on("line", (line) => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (m.type === "http-result" && typeof m.id === "number") {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (!p) return;
    if (m.error) p.reject(new Error(m.error));
    else p.resolve(m.res);
    return;
  }
  if (m.type === "start" && typeof m.dir === "string") void start(m.dir, String(m.action), m.params);
});

async function start(dir, action, params) {
  const http = (req) =>
    new Promise((resolve, reject) => {
      const id = ++next;
      pending.set(id, { resolve, reject });
      send({ type: "http", id, req });
    });
  try {
    const mod = await import(pathToFileURL(join(dir, "index.mjs")).href);
    if (typeof mod.run !== "function") return finish({ ok: false, error: "index.mjs must export async function run(action, params, http)" });
    const data = await mod.run(action, params ?? {}, http);
    finish({ ok: true, data: data === undefined ? null : data });
  } catch (err) {
    finish({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
