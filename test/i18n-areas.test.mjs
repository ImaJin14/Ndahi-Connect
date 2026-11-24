// Translations by area (#428): shared-app/i18n.js merges one module per area
// under shared-app/i18n/ into the same TRANSLATIONS.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { TRANSLATIONS, t, format } from "../shared-app/i18n.js";

const dir = new URL("../shared-app/i18n/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".js")).sort();
const modules = Object.fromEntries(await Promise.all(files.map(async (f) => [f, await import(new URL(f, dir))])));

test("every area module is listed in i18n.js and exports en and fr with the same keys", () => {
  const source = readFileSync(new URL("../shared-app/i18n.js", import.meta.url), "utf8");
  for (const f of files) {
    assert.match(source, new RegExp(`from "\\./i18n/${f.replace(".", "\\.")}"`), `${f} is imported`);
    const { en, fr } = modules[f];
    assert.equal(typeof en, "object", `${f} exports en`);
    assert.equal(typeof fr, "object", `${f} exports fr`);
    assert.deepEqual(Object.keys(fr).sort(), Object.keys(en).sort(), `${f}: the same keys in English and French`);
  }
});

test("a key lives in one area module only, and TRANSLATIONS is their merge", () => {
  const owner = new Map();
  for (const f of files) for (const key of Object.keys(modules[f].en)) {
    assert.ok(!owner.has(key), `${key} is in both ${owner.get(key)} and ${f}`);
    owner.set(key, f);
  }
  for (const lang of ["en", "fr"]) assert.deepEqual(TRANSLATIONS[lang], Object.assign({}, ...files.map((f) => modules[f][lang])));
  assert.equal(t("uiTabHome", "fr"), "Accueil");
  assert.equal(format("portalPromoLeft", { count: 3 }, "en"), "3 left at this price");
});

// The split itself: the commit that created shared-app/i18n/ has the same
// TRANSLATIONS, key for key in English and French, as the monolithic
// i18n.js in its parent. Both sides come from history, so later string
// changes never affect this. It needs the history (a full clone); a shallow
// checkout skips it.
test("splitting the translations by area changed no string", (t) => {
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  let split;
  try {
    split = git("log", "--diff-filter=A", "--format=%H", "--", "shared-app/i18n/common.js").trim().split("\n").filter(Boolean).at(-1);
    if (split) git("cat-file", "-e", `${split}^:shared-app/i18n.js`);
  } catch { split = null; }
  if (!split) return t.skip("the commit that split the translations isn't in this clone's history");
  const root = mkdtempSync(join(tmpdir(), "ndahi-i18n-split-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "before"));
  mkdirSync(join(root, "after", "i18n"), { recursive: true });
  writeFileSync(join(root, "before", "i18n.js"), git("show", `${split}^:shared-app/i18n.js`));
  writeFileSync(join(root, "after", "i18n.js"), git("show", `${split}:shared-app/i18n.js`));
  for (const f of git("ls-tree", "--name-only", `${split}:shared-app/i18n/`).trim().split("\n")) writeFileSync(join(root, "after", "i18n", f), git("show", `${split}:shared-app/i18n/${f}`));
  return Promise.all(["before", "after"].map((side) => import(pathToFileURL(join(root, side, "i18n.js"))))).then(([before, after]) => {
    assert.deepStrictEqual(after.TRANSLATIONS.en, before.TRANSLATIONS.en);
    assert.deepStrictEqual(after.TRANSLATIONS.fr, before.TRANSLATIONS.fr);
  });
});
