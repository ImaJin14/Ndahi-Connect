// The automatic syntax check (#428): a new file is checked without editing
// package.json, and a broken one fails `npm run check`.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sourceFiles } from "../scripts/check-syntax.mjs";

const script = fileURLToPath(new URL("../scripts/check-syntax.mjs", import.meta.url));
const repo = fileURLToPath(new URL("..", import.meta.url));

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), "ndahi-syntax-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

test("a broken new file in admin-app-v2/ fails the check, with no list to edit", (t) => {
  // "type": "module" as in the repository: outside such a package, Node 22's
  // --check passes a broken file that uses export (module syntax detection).
  const root = tree({ "package.json": '{"type":"module"}', "admin-app-v2/fine.js": "export const ok = 1;\n", "admin-app-v2/new-screen.js": "export function broken( {\n", "server.mjs": "export {};\n" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /admin-app-v2\/new-screen\.js/);
  assert.match(run.stderr, /Syntax check failed: 1 of 3 files/);
  writeFileSync(join(root, "admin-app-v2/new-screen.js"), "export function fixed() {}\n");
  const again = spawnSync(process.execPath, [script, "--root", root], { encoding: "utf8" });
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /Syntax check: 3 files/);
});

test("it finds every app's scripts and skips node_modules and dot folders", (t) => {
  const root = tree({ "customer-app-v2/a.js": "", "lib/b.mjs": "", "shared-app/i18n/c.js": "", "node_modules/x/d.js": "",
    "lib/node_modules/e.js": "", ".claude/f.mjs": "", "store-app/.cache/g.js": "", "docs/h.js": "", "static-server.mjs": "" });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.deepEqual(sourceFiles(root), ["customer-app-v2/a.js", "lib/b.mjs", "shared-app/i18n/c.js", "static-server.mjs"]);
});

test("npm run check runs it and no longer lists files by hand", () => {
  const { scripts } = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  assert.match(scripts.check, /^node scripts\/check-syntax\.mjs && /);
  assert.doesNotMatch(scripts.check, /node --check/);
  const listed = sourceFiles(repo);
  for (const file of ["server.mjs", "lib/store-promotions.mjs", "admin-app-v2/app.js", "customer-app-v2/app.js", "store-app/app.js", "shared-app/i18n/admin.js", "scripts/check-syntax.mjs"])
    assert.ok(listed.includes(file), file);
});
