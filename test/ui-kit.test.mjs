// Design kit (redesign Phase 1): tokens, browser floor, strings and serving.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createStaticServer } from "../static-server.mjs";
import { TRANSLATIONS, format, t as translate } from "../shared-app/i18n.js";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
const kitDir = "shared-app/ui";
const kitScripts = async () => (await readdir(join(root, kitDir))).filter((name) => name.endsWith(".js")).map((name) => `${kitDir}/${name}`);

async function tokens() {
  const css = await read(`${kitDir}/tokens.css`), values = new Map();
  for (const [, name, value] of css.matchAll(/(--nd-[\w-]+)\s*:\s*([^;]+);/g)) values.set(name, value.trim());
  const resolve = (name) => {
    const value = values.get(name);
    const alias = /^var\((--nd-[\w-]+)\)$/.exec(value || "");
    return alias ? resolve(alias[1]) : value;
  };
  return { values, resolve };
}

function contrast(foreground, background) {
  const luminance = (hex) => {
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (light + 0.05) / (dark + 0.05);
}

test("every kit module loads and exports its documented API", async () => {
  const expected = {
    "dom.js": ["h", "append", "clear", "currentLanguage", "setDocumentLanguage", "localize", "announce"],
    "icons.js": ["ICONS", "icon", "renderIcons"],
    "field.js": ["setFieldError", "clearFieldError", "focusFirstError", "enhancePinToggles", "setBusy"],
    "choice.js": ["enhanceChoiceGroup", "enhanceTabs"],
    "navigation.js": ["renderBrand", "renderTabBar", "renderPortalHeader", "renderNetworkStatus", "notificationsLabel", "renderAdminMenu", "renderBackButton", "PORTAL_TABS", "ADMIN_MENU"],
    "progress.js": ["renderSteps", "renderStepper", "stepCount", "renderMeter", "setMeter"],
    "states.js": ["renderState", "focusState"],
  };
  assert.deepEqual((await kitScripts()).map((path) => path.split("/").pop()).sort(), Object.keys(expected).sort(), "a new kit module needs a row here");
  for (const [file, names] of Object.entries(expected)) {
    const module = await import(`../${kitDir}/${file}`);
    for (const name of names) assert.ok(name in module, `${file} exports ${name}`);
  }
});

test("kit code stays inside the Chrome 73 / Safari 12.1 floor", async () => {
  for (const path of [...await kitScripts(), "customer-app-v2/ui-kit.js"]) {
    const source = (await read(path)).replace(/\/\/.*$/gm, "");
    for (const [pattern, name] of [[/\?\.[\w([]/, "optional chaining"], [/\?\?/, "nullish coalescing"], [/\.replaceAll\(/, "replaceAll"], [/\.at\(/, "Array#at"], [/structuredClone/, "structuredClone"], [/#[a-z]\w*\s*[=(;]/, "private fields"]]) {
      assert.doesNotMatch(source, pattern, `${path} uses ${name}`);
    }
  }
  for (const path of [`${kitDir}/tokens.css`, `${kitDir}/components.css`, "customer-app-v2/ui-kit.css"]) {
    const css = (await read(path)).replace(/\/\*[\s\S]*?\*\//g, "");
    // One unsupported selector or at-rule drops the whole rule on old browsers.
    for (const [pattern, name] of [[/@layer/, "@layer"], [/:is\(/, ":is()"], [/:where\(/, ":where()"], [/:has\(/, ":has()"], [/(^|[;{\s])inset\s*:/, "inset"], [/@container/, "@container"]]) {
      assert.doesNotMatch(css, pattern, `${path} uses ${name}`);
    }
    // :focus-visible must sit in its own rule, so browsers without it keep the plain :focus ring.
    for (const [, selectors] of css.matchAll(/([^{}]+)\{/g)) {
      if (selectors.includes(":focus-visible")) {
        for (const selector of selectors.split(",")) assert.match(selector, /:focus-visible/, `${path}: "${selector.trim()}" shares a rule with :focus-visible`);
      }
    }
  }
});

test("every --nd-* variable the kit uses is defined in tokens.css", async () => {
  const { values } = await tokens();
  for (const path of [`${kitDir}/components.css`, "customer-app-v2/ui-kit.css", "customer-app-v2/ui-kit.js"]) {
    for (const [, name] of (await read(path)).matchAll(/var\((--nd-[\w-]+)/g)) {
      // The reference page builds some names from the lists checked below.
      if (!name.endsWith("-")) assert.ok(values.has(name), `${path} uses undefined ${name}`);
    }
  }
  const page = await read("customer-app-v2/ui-kit.js");
  for (const [list, prefix] of [["COLOURS", "--nd-"], ["SPACES", "--nd-space-"], ["RADII", "--nd-radius-"]]) {
    const items = new RegExp(`const ${list} = \\[([\\s\\S]*?)\\];`).exec(page)[1];
    for (const [, name] of items.matchAll(/"?([\w-]+)"?/g)) assert.ok(values.has(prefix + name), `${list}: ${prefix}${name}`);
  }
});

test("text colour pairs used by the components meet 4.5:1", async () => {
  const { resolve } = await tokens();
  const pairs = [
    ["ink", "ivory"], ["ink", "paper"], ["muted", "ivory"], ["muted", "paper"], ["muted", "white"], ["muted", "sage"],
    ["ink-soft", "sage"], ["ink-soft", "paper"], ["forest", "sage"], ["forest", "paper"], ["forest", "white"], ["forest", "sage-strong"],
    ["lime-text", "paper"], ["lime-text", "ivory"], ["lime-ink", "lime"], ["lime-ink", "lime-hover"], ["white", "forest"], ["lime", "forest"],
    ["on-forest-soft", "forest"], ["on-forest-muted", "forest"], ["on-forest-faint", "forest"],
    ["success-fg", "success-bg"], ["warning-fg", "warning-bg"], ["danger-fg", "danger-bg"], ["info-fg", "info-bg"], ["neutral-fg", "neutral-bg"],
    ["danger", "paper"], ["danger", "white"], ["danger-fg", "danger-soft"], ["white", "danger"], ["white", "danger-fg"], ["white", "forest-deep"],
    ["white", "info-fg"], ["muted", "neutral-bg"],
  ];
  for (const [foreground, background] of pairs) {
    const ratio = contrast(resolve(`--nd-${foreground}`), resolve(`--nd-${background}`));
    assert.ok(ratio >= 4.5, `${foreground} on ${background} is ${ratio.toFixed(2)}:1`);
  }
  // The focus ring needs 3:1 against the surfaces it sits on.
  for (const [ring, surface] of [["forest", "ivory"], ["forest", "paper"], ["forest", "lime"], ["lime", "forest"]]) {
    assert.ok(contrast(resolve(`--nd-${ring}`), resolve(`--nd-${surface}`)) >= 3, `${ring} focus ring on ${surface}`);
  }
});

test("kit strings exist in English and French, and format() fills placeholders", async () => {
  const uiKeys = (lang) => Object.keys(TRANSLATIONS[lang]).filter((key) => /^ui[A-Z]/.test(key)).sort();
  assert.deepEqual(uiKeys("fr"), uiKeys("en"));
  for (const key of uiKeys("en")) {
    assert.ok(TRANSLATIONS.en[key].trim() && TRANSLATIONS.fr[key].trim(), key);
    const slots = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort().join();
    assert.equal(slots(TRANSLATIONS.fr[key]), slots(TRANSLATIONS.en[key]), `${key} placeholders`);
  }
  for (const path of await kitScripts()) {
    const source = await read(path);
    for (const [, key] of source.matchAll(/"(ui[A-Z]\w*)"/g)) assert.ok(key in TRANSLATIONS.en && key in TRANSLATIONS.fr, `${path}: ${key}`);
  }
  // Network status labels reuse the existing dictionary keys.
  for (const key of ["networkOnline", "networkDegraded", "networkOffline", "maintenance", "unavailable"]) assert.ok(TRANSLATIONS.fr[key], key);
  assert.equal(format("uiStepCount", { current: 2, total: 3 }, "en"), "Step 2 of 3");
  assert.equal(format("uiStepCount", { current: 2, total: 3 }, "fr"), "Étape 2 sur 3");
  assert.equal(format("uiStepCount", { current: 2 }, "en"), "Step 2 of {total}");
  assert.equal(format("uiAttention", { count: "<b>" }, "en"), "<b> need attention", "format returns text; callers set it with textContent");
  assert.equal(translate("uiTabShop", "fr"), "Boutique");
});

test("the kit page is CSP-safe, v2-only sample content, translated and unlinked", async () => {
  const html = await read("customer-app-v2/ui-kit.html");
  const page = await read("customer-app-v2/ui-kit.js");
  assert.match(html, /<html lang="en" data-ui-variant="v2">/);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
  assert.doesNotMatch(html, /\sstyle=/, "inline style attributes are blocked by the CSP");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)[^>]*>/, "inline scripts are blocked by the CSP");
  assert.doesNotMatch(html, /\son[a-z]+=/i, "inline handlers are blocked by the CSP");
  assert.doesNotMatch(page, /\/api\/|fetch\(|XMLHttpRequest/, "the reference page calls no API");
  const french = new Set([...page.matchAll(/^\s+(kit\w+):/gm)].map((match) => match[1]));
  const keys = [...html.matchAll(/data-i18n(?:-[\w-]+)?="(\w+)"/g)].map((match) => match[1]);
  assert.ok(keys.length > 80);
  for (const key of keys) {
    if (key.startsWith("kit")) assert.ok(french.has(key), `French copy for ${key}`);
    else assert.ok(key in TRANSLATIONS.en && key in TRANSLATIONS.fr, `shared key ${key}`);
  }
  for (const folder of ["customer-app", "customer-app-v2", "admin-app", "admin-app-v2", "store-app"]) {
    for (const name of await readdir(join(root, folder))) {
      if (!/\.(html|js|css)$/.test(name) || name.startsWith("ui-kit.")) continue;
      assert.doesNotMatch(await read(`${folder}/${name}`), /ui-kit/, `${folder}/${name} links the kit page`);
    }
  }
});

test("v1 pages do not load the kit, so production defaults are unchanged", async () => {
  for (const folder of ["customer-app", "admin-app", "store-app"]) {
    for (const name of await readdir(join(root, folder))) {
      if (!/\.(html|js|css)$/.test(name)) continue;
      assert.doesNotMatch(await read(`${folder}/${name}`), /\/shared\/ui\/|shared-app\/ui\//, `${folder}/${name}`);
    }
  }
});

test("the static server serves the kit to v2 only and versions its files", async (t) => {
  const server = createStaticServer("customer", { apiUrl: "https://api.test" });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = (path, cookie) => fetch(base + path, { redirect: "manual", headers: cookie ? { cookie } : {} });

  assert.equal((await get("/ui-kit.html")).status, 404, "v1 visitors (the default) have no kit page");
  const response = await get("/ui-kit.html", "ndahi_ui=v2");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(response.headers.get("content-security-policy"), /script-src 'self'/);
  for (const file of ["/shared/ui/tokens.css", "/shared/ui/components.css", "/ui-kit.css", "/ui-kit.js"]) {
    const versioned = new RegExp(`/static${file.replace(/\.(css|js)$/, "")}\\.[0-9a-f]{20}\\.(css|js)`).exec(html);
    assert.ok(versioned, `${file} is content-versioned in the page`);
    const asset = await get(versioned[0], "ndahi_ui=v2");
    assert.equal(asset.status, 200, versioned[0]);
    assert.match(asset.headers.get("cache-control"), /immutable/);
  }
  const script = await (await get(/\/static\/ui-kit\.[0-9a-f]{20}\.js/.exec(html)[0], "ndahi_ui=v2")).text();
  assert.match(script, /from "\/static\/shared\/ui\/dom\.[0-9a-f]{20}\.js"/, "kit imports are rewritten to versioned files");
  const field = await (await get("/shared/ui/field.js", "ndahi_ui=v2")).text();
  assert.match(field, /from "\/static\/shared\/i18n\.[0-9a-f]{20}\.js"/, "relative imports inside shared-app/ui resolve");
});
