// The local redesign preview (scripts/redesign-preview.mjs): its screen list
// points at real canvas files and at UI the apps really render, and the canvas
// stand-in runtime parses and keeps its template helpers safe.
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import { SCREENS, DEMO, FIXTURES, expectations, rejections } from "../scripts/redesign-preview.mjs";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");
// An open step: a selector to click, or a field to fill with a value.
const isStep = (step) => typeof step === "string" || (step && typeof step.fill === "string" && typeof step.value === "string" && Object.keys(step).length === 2);

test("every preview screen pairs real canvas artboards with a page of the app", async () => {
  const canvas = JSON.parse(await read("docs/redesign/screens/canvas.json"));
  assert.ok(SCREENS.length >= 5);
  assert.equal(new Set(SCREENS.map((s) => s.id)).size, SCREENS.length, "screen ids are unique (they name the PNGs)");
  for (const screen of SCREENS) {
    for (const board of [screen.phone, screen.desktop].filter(Boolean)) {
      await access(join(root, "docs/redesign/screens", `${board}.dc.html`));
      assert.ok(canvas.boards[`${board}.dc.html`], `${board} is on the canvas`);
    }
    for (const step of [].concat(screen.open || [])) assert.ok(isStep(step), `${screen.id}: ${JSON.stringify(step)} is a click selector or { fill, value }`);
    for (const [, name] of screen.path.matchAll(/\{(\w+)\}/g)) assert.ok(FIXTURES.includes(name), `${screen.id}: {${name}} is a seeded fixture`);
    if (screen.hash) assert.doesNotThrow(() => new RegExp(screen.hash), `${screen.id}: hash is a valid pattern`);
    if (screen.app === "portal" || screen.app === "store") {
      assert.match(screen.path, /^\/[\w.#/?=&%{}-]*$/, "a page of the app");
      if (screen.tab) assert.match(screen.tab, /^(home|internet|shop|activity|account)$/, "captures wait for this tab");
    } else {
      assert.equal(screen.app, "admin");
      assert.match(screen.path, /^\/(dashboard#[a-z-]+|login|home-routers\.html)$/);
    }
  }
  // Every admin artboard except the shared side menu has a preview entry.
  const adminBoards = Object.keys(canvas.boards).filter((name) => name.startsWith("Admin") && name !== "AdminSide.dc.html");
  assert.deepEqual(SCREENS.filter((s) => s.app === "admin").map((s) => `${s.desktop}.dc.html`).sort(), adminBoards.sort());
  // Every customer and store artboard except the shared tab bar has one too.
  const customerBoards = Object.keys(canvas.boards).filter((name) => !name.startsWith("Admin") && name !== "TabBar.dc.html");
  assert.deepEqual([...new Set(SCREENS.filter((s) => s.app !== "admin").flatMap((s) => [s.phone, s.desktop]).filter(Boolean).map((b) => `${b}.dc.html`))].sort(), customerBoards.sort());
  assert.match(DEMO.pin, /^\d{4}$/);
});

test("no build capture can count without checking for its own UI", () => {
  for (const screen of SCREENS) {
    const wanted = expectations(screen);
    assert.ok(wanted.length > 0, `${screen.id} checks at least one selector`);
    // Blocked screens show something else; expect must prove they show that.
    if (screen.blocked) assert.ok([].concat(screen.expect || []).length > 0, `${screen.id} is blocked, so it says what it shows instead`);
  }
  // Screens reached by clicking through to a sub-address pin that address.
  for (const id of ["product", "checkout", "order", "guest-product", "guest-checkout", "admin-bundle-edit", "admin-voucher-print", "admin-product-edit", "admin-customer-detail"]) {
    assert.ok(SCREENS.find((s) => s.id === id).hash, `${id} pins its final address`);
  }
  for (const screen of SCREENS.filter((s) => s.app === "store")) {
    assert.ok(rejections(screen).includes("#message:not(:empty)"), `${screen.id} rejects the store's error line`);
    assert.ok(rejections(screen).includes("#view > p:only-child"), `${screen.id} rejects the store's loading text`);
    assert.ok(screen.hash, `${screen.id} pins its hash route`);
  }
});

// Ids, classes and data attributes a selector relies on, so drift in the apps shows up here.
function hooks(selector) {
  const bare = selector.replace(/:not\([^)]*\)/g, "").replace(/\[(open|disabled|hidden)\]/g, "");
  return [
    ...[...bare.matchAll(/#([\w-]+)/g)].map(([, id]) => ({ kind: "id", name: id })),
    ...[...bare.matchAll(/\.([\w-]+)/g)].map(([, name]) => ({ kind: "class", name })),
    ...[...bare.matchAll(/\[(data-[\w-]+)/g)].map(([, name]) => ({ kind: "data", name })),
  ];
}
// A string matched literally inside a RegExp: every pattern character,
// backslash included, is escaped (not just the hyphens hooks use today).
const escapeRegExp = (text) => String(text).replace(/[\\^$.*+?()[\]{}|\/-]/g, "\\$&");
function rendered(source, hook) {
  const name = escapeRegExp(hook.name);
  if (hook.kind === "id") return new RegExp(`\\bid=\\\\?["']?${name}\\b`).test(source);
  if (hook.kind === "class") return new RegExp(`\\bclass=\\\\?["'][^"']*\\b${name}(?![\\w-])`).test(source);
  const camel = hook.name.slice(5).replace(/-(\w)/g, (all, c) => c.toUpperCase());
  return new RegExp(`\\b${name}=|\\bdataset\\.${camel}\\b`).test(source);
}

test("hook names are matched literally, backslashes and pattern characters included", () => {
  for (const name of ["order-page", "a.b", "a\\b", "a\\", "x*y+z?", "(g)[h]{2}|^$", "p/q", "tail\\-"]) {
    const pattern = new RegExp(`^${escapeRegExp(name)}$`);
    assert.ok(pattern.test(name), `${JSON.stringify(name)} matches itself`);
  }
  assert.equal(escapeRegExp("a\\b"), "a\\\\b", "a backslash is escaped once, as \\\\");
  assert.ok(!new RegExp(`^${escapeRegExp("a.b")}$`).test("axb"), "a dot is literal");
  assert.ok(!new RegExp(`^${escapeRegExp("a\\b")}$`).test("a\b"), "\\b is not a word boundary or backspace");
  assert.ok(!new RegExp(`^${escapeRegExp("a\\")}$`).test("a"), "a trailing backslash does not escape the anchor");
  assert.ok(rendered('<p class="x a.b">', { kind: "class", name: "a.b" }));
  assert.ok(!rendered('<p class="x aXb">', { kind: "class", name: "a.b" }));
});

test("the guest store selectors match the full-page store (product page, checkout dialog, order page)", async () => {
  const source = (await read("store-app/index.html")) + (await read("store-app/app.js"));
  const store = SCREENS.filter((s) => s.app === "store");
  assert.deepEqual(store.map((s) => s.id), ["guest-shop", "guest-product", "guest-checkout", "guest-order"]);
  for (const screen of store) {
    for (const selector of [...expectations(screen), ...rejections(screen), ...[].concat(screen.open || []).filter((s) => typeof s === "string")]) {
      for (const hook of hooks(selector)) assert.ok(rendered(source, hook), `${screen.id}: ${hook.kind} "${hook.name}" (from ${selector}) is rendered by store-app`);
    }
  }
  // The product dialog is gone (bb1f908); .order-card is the Orders list, not one order.
  const all = JSON.stringify(store);
  assert.doesNotMatch(all, /productDialog/);
  assert.doesNotMatch(all, /order-card/);
  assert.doesNotMatch(source, /id="productDialog"/);
  const byId = Object.fromEntries(store.map((s) => [s.id, s]));
  assert.match("#product/abc", new RegExp(byId["guest-product"].hash));
  assert.doesNotMatch("#shop", new RegExp(byId["guest-product"].hash));
  assert.match("#order/o1/t1", new RegExp(byId["guest-order"].hash));
  assert.doesNotMatch("#order/o1", new RegExp(byId["guest-order"].hash), "a guest order needs its private token");
  assert.match("", new RegExp(byId["guest-shop"].hash));
  assert.match("#shop", new RegExp(byId["guest-shop"].hash));
  assert.doesNotMatch("#orders", new RegExp(byId["guest-shop"].hash));
});

test("the portal shop selectors match customer-app-v2", async () => {
  const source = (await read("customer-app-v2/portal-shop.js")) + (await read("customer-app-v2/portal-activity.js"));
  for (const screen of SCREENS.filter((s) => ["shop", "product", "checkout", "order"].includes(s.id))) {
    for (const selector of [...[].concat(screen.expect || []), ...[].concat(screen.open || []), ...[].concat(screen.reject || [])]) {
      for (const hook of hooks(selector)) assert.ok(rendered(source, hook), `${screen.id}: ${hook.kind} "${hook.name}" (from ${selector}) is rendered by the portal shop`);
    }
  }
});

test("the canvas stand-in runtime is valid script and only renders, never posts", async () => {
  const source = await read("scripts/redesign-preview-canvas.js");
  assert.doesNotThrow(() => new Function(source));
  assert.doesNotMatch(source, /method:\s*["']POST|XMLHttpRequest|sendBeacon/);
  // Readiness is only ever "" (ready) or "error", and both are set in one place.
  assert.equal(source.match(/setAttribute\("data-dc-ready"/g).length, 2);
  assert.match(source, /addEventListener\("error"/);
  assert.match(source, /addEventListener\("unhandledrejection"/);
});

test("the canvas helpers fill holes safely and read props from the address", async () => {
  const window = {};
  vm.runInNewContext(await read("scripts/redesign-preview-canvas.js"), { window, URLSearchParams });
  const c = window.__ndahiCanvas;
  assert.ok(c, "helpers load without a DOM");
  // Holes.
  assert.equal(c.evaluate("{{ user.name }}", [{ user: { name: "Amina" } }]), "Amina");
  assert.equal(c.evaluate("Hi {{user.name}}!", [{ user: { name: "Amina" } }]), "Hi Amina!");
  assert.equal(c.evaluate("{{ count }}", [{ count: 0 }]), 0);
  assert.equal(c.evaluate("n={{ count }}", [{ count: 0 }]), "n=0");
  assert.equal(c.evaluate("[{{ missing }}]", [{}]), "[]");
  assert.equal(c.evaluate("[{{ off }}]", [{ off: false }]), "[]");
  // Inner scopes win; only own keys start a path; prototypes are never walked.
  assert.equal(c.lookup("item", [{ item: "inner" }, { item: "outer" }]), "inner");
  assert.equal(c.lookup("toString", [{}]), undefined);
  assert.equal(c.lookup("__proto__", [{}]), undefined);
  assert.equal(c.lookup("a.__proto__", [{ a: {} }]), undefined);
  assert.equal(c.lookup("a.constructor", [{ a: {} }]), undefined);
  assert.equal(c.lookup("'x'", []), "x");
  assert.equal(c.lookup("-2.5", []), -2.5);
  // Address props.
  const props = c.queryProps("?guest=true&paid=false&name=A&$preview=1&__proto__=x&constructor=y");
  assert.deepEqual(JSON.parse(JSON.stringify(props)), { guest: true, paid: false, name: "A" });
  const merged = c.mergeProps({ guest: false, size: 1 }, props);
  assert.equal(merged.guest, true);
  assert.equal(merged.size, 1);
  const hostile = JSON.parse('{"__proto__":{"polluted":true},"ok":1}');
  const safe = c.mergeProps({}, hostile);
  assert.equal(safe.ok, 1);
  assert.equal(safe.polluted, undefined, "a __proto__ prop never becomes the prototype");
  assert.equal({}.polluted, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(c.propDefaults('{"guest":{"default":true},"$meta":{"default":1},"plain":3}'))), { guest: true });
  assert.throws(() => c.propDefaults("{not json"));
  // Props are prototype-free dictionaries; screens still read them by name.
  for (const dict of [props, merged, safe, c.propDefaults('{"guest":{"default":true}}')]) assert.equal(Object.getPrototypeOf(dict), null);
  assert.deepEqual(Object.keys(merged).sort(), ["guest", "name", "paid", "size"]);
  assert.equal(merged.toString, undefined, "no inherited members to shadow or call");
  // Markup becomes XML: void tags closed, bare attributes given a value.
  assert.equal(c.xmlify('<input disabled><br><img src="a.png">'), '<input disabled=""/><br/><img src="a.png"/>');
  assert.equal(c.xmlify("<div hidden>x</div>"), '<div hidden="">x</div>');
});

test("address and default props never run a setter on Object.prototype", async () => {
  // A realm whose Object.prototype has a setter for "trap" (and logs any
  // __proto__ assignment): a plain {} dictionary would call it on props.trap = …
  const hits = [];
  const context = vm.createContext({ window: {}, URLSearchParams, hits });
  vm.runInContext(`
    Object.defineProperty(Object.prototype, "trap", { configurable: true, set(value) { hits.push(["trap", value]); }, get() { return "inherited"; } });
    const proto = Object.getOwnPropertyDescriptor(Object.prototype, "__proto__");
    Object.defineProperty(Object.prototype, "__proto__", { configurable: true, get: proto.get, set(value) { hits.push(["__proto__", value]); return proto.set.call(this, value); } });
  `, context);
  vm.runInContext(await read("scripts/redesign-preview-canvas.js"), context);
  const c = context.window.__ndahiCanvas;

  const fromQuery = c.queryProps("?trap=1&__proto__=x&ok=yes");
  assert.equal(fromQuery.trap, "1", "an own value, not the inherited getter");
  assert.equal(fromQuery.ok, "yes");
  assert.equal(Object.prototype.hasOwnProperty.call(fromQuery, "__proto__"), false);

  const defaults = c.propDefaults('{"trap":{"default":2},"__proto__":{"default":{"polluted":true}}}');
  assert.equal(defaults.trap, 2);
  assert.equal(Object.prototype.hasOwnProperty.call(defaults, "__proto__"), false);

  const merged = c.mergeProps(defaults, fromQuery);
  assert.equal(merged.trap, "1", "query props win over defaults");
  assert.equal(merged.ok, "yes");
  assert.equal(merged.polluted, undefined);

  assert.deepEqual(hits, [], "no prototype setter was reached");
  assert.equal(vm.runInContext("({}).polluted", context), undefined);
});
