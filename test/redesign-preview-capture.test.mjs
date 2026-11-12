// Capture readiness in the redesign preview (scripts/redesign-preview.mjs):
// a gallery PNG is only taken when the page is the screen's page, shows the
// screen's own UI, shows no error or loading UI, and still does once it has
// settled. Driven by a scripted stand-in for Playwright: no browser, no
// servers, no network; only mock data.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, access, lstat, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import {
  SCREENS, CaptureError, captureBuild, captureDesign, capture, captureDir, confirmShown, expectations, rejections,
  readManifest, resolvePath, routeProblem, summarize, writeManifest,
} from "../scripts/redesign-preview.mjs";

const port = (name, fallback) => Number(process.env[name] || fallback);
const PORTAL = `http://localhost:${port("PREVIEW_PORTAL_PORT", 8080)}`;
const STORE = `http://localhost:${port("PREVIEW_STORE_PORT", 8083)}`;
const DESIGN = `http://localhost:${port("PREVIEW_DESIGN_PORT", 8090)}`;
const FIXTURES = { guestOrderId: "order-1", guestOrderToken: "tok/1", paymentId: "pay-1" };
const screen = (id) => SCREENS.find((s) => s.id === id);
const exists = (path) => access(path).then(() => true, () => false);

// A page that does what the test scripts: `onGoto(url, state)` decides where the
// page lands and what it shows; `clicks[selector](state, value)` runs steps;
// `onSettle(state)` changes the page while the capture waits for it to settle.
function fakePage({ onGoto, clicks = {}, onSettle, attrs = {}, drawn = true, scroll = false } = {}) {
  const state = { href: "about:blank", status: 200, shown: new Set(), texts: {}, shots: [], visits: [] };
  const element = (selector) => ({
    async waitFor({ timeout }) { if (!state.shown.has(selector)) throw new Error(`Timeout ${timeout}ms exceeded waiting for ${selector}`); },
    async isVisible() { return state.shown.has(selector); },
    async innerText() { return state.texts[selector] || ""; },
    async click() { if (!clicks[selector]) throw new Error(`waiting for locator('${selector}')`); clicks[selector](state); },
    async fill(value) { if (!clicks[selector]) throw new Error(`waiting for locator('${selector}')`); clicks[selector](state, value); },
  });
  return {
    state,
    async goto(url) {
      state.visits.push(url);
      state.href = url;
      if (onGoto) onGoto(url, state);
      return { ok: () => state.status < 400, status: () => state.status };
    },
    url: () => state.href,
    locator: (selector) => ({ first: () => element(selector) }),
    async evaluate(fn) {
      const code = String(fn);
      if (code.includes("MutationObserver")) { if (onSettle) onSettle(state); return true; }
      if (code.includes("scrollHeight")) return scroll;
      if (code.includes("dc-root")) return drawn;
      return undefined; // document.fonts.ready
    },
    async waitForSelector() { if (!("data-dc-ready" in attrs)) throw new Error("Timeout exceeded"); },
    async getAttribute(target, name) { return name in attrs ? attrs[name] : null; },
    async screenshot({ path }) { state.shots.push(path); await writeFile(path, "png"); },
    async close() {},
  };
}
const shows = (state, selectors) => selectors.forEach((s) => state.shown.add(s));

let dir;
test.before(async () => { dir = await mkdtemp(join(tmpdir(), "ndahi-preview-capture-test-")); });
test.after(() => rm(dir, { recursive: true, force: true }));
const filesFor = (base) => ({ file: join(dir, `${base}.png`), fullFile: join(dir, `${base}-full.png`), failedFile: join(dir, `${base}-failed.png`) });
const build = (id, page, extra = {}) => captureBuild(page, screen(id), { origin: screen(id).app === "store" ? STORE : PORTAL, fixtures: FIXTURES, files: filesFor(`${id}-t`), phone: true, timeout: 20, ...extra });

test("routes: the expected page, its hash, and .html / index aliases", () => {
  assert.equal(routeProblem(screen("guest-product"), `${STORE}/#product/p1`), null);
  assert.equal(routeProblem(screen("guest-product"), `${STORE}/index.html#product/p1`), null);
  assert.match(routeProblem(screen("guest-product"), `${STORE}/`), /expected an address matching \^#product/);
  assert.match(routeProblem(screen("guest-product"), `${STORE}/#product/p1/extra`), /expected an address matching/);
  assert.equal(routeProblem(screen("guest-shop"), `${STORE}/`), null);
  assert.equal(routeProblem(screen("guest-shop"), `${STORE}/#shop`), null);
  assert.match(routeProblem(screen("guest-shop"), `${STORE}/#orders`), /expected an address/);
  assert.match(routeProblem(screen("guest-order"), `${STORE}/#order/o1`), /expected an address/, "no private token, not the guest view");
  assert.equal(routeProblem(screen("login"), `${PORTAL}/login.html`), null);
  assert.match(routeProblem(screen("devices"), `${PORTAL}/login`), /expected \/dashboard but landed on \/login/);
  assert.equal(routeProblem(screen("voucher-ready"), `${PORTAL}/voucher-ready.html?payment=x`), null);
  assert.equal(routeProblem(screen("checkout"), `${PORTAL}/dashboard#checkout/p1/2`), null);
  assert.match(routeProblem(screen("checkout"), `${PORTAL}/dashboard#product/p1`), /expected an address/);
});

test("fixtures fill paths encoded, and a missing one is a capture error", () => {
  assert.equal(resolvePath(screen("guest-order").path, FIXTURES), "/#order/order-1/tok%2F1");
  assert.throws(() => resolvePath(screen("guest-order").path, { guestOrderId: "o" }), (e) => e instanceof CaptureError && /"guestOrderToken" is unavailable/.test(e.message));
  assert.throws(() => resolvePath(screen("voucher-ready").path, { paymentId: "" }), CaptureError);
  assert.throws(() => resolvePath("/x/{toString}", {}), CaptureError, "only own fixture keys");
});

test("expectations add the tab, panel and menu the screen needs", () => {
  assert.deepEqual(expectations(screen("shop")), ['[data-portal-tab="shop"][aria-current="page"]', ".portal-shop__item"]);
  assert.deepEqual(expectations(screen("admin-bundles")), ['[data-tab-panel="bundles"]:not([hidden])', '[data-admin-nav="bundles"][aria-current="page"]']);
  assert.ok(rejections(screen("product")).includes('.error[role="alert"]:not(:empty)'));
  assert.ok(rejections(screen("home")).includes('.error-card[role="alert"]'), "portal service errors cannot count as a match");
});

test("the guest product page is captured once its route and UI are both there", async () => {
  const s = screen("guest-product");
  const page = fakePage({
    scroll: true,
    onGoto: (url, st) => shows(st, ['body[data-view="shop"] .products [data-product]']),
    clicks: { "[data-product]": (st) => { st.href = `${STORE}/#product/p1`; shows(st, expectations(s)); } },
  });
  const result = await build("guest-product", page);
  assert.equal(result.url, `${STORE}/#product/p1`);
  assert.deepEqual(result.steps, ["click [data-product]"]);
  assert.equal(result.full, true);
  assert.deepEqual(page.state.shots, [filesFor("guest-product-t").file, filesFor("guest-product-t").fullFile]);
});

test("the old dialog flow (product UI shown, address still the shop) is not accepted", async () => {
  const s = screen("guest-product");
  const page = fakePage({ clicks: { "[data-product]": (st) => shows(st, expectations(s)) } });
  await assert.rejects(build("guest-product", page), (e) => e instanceof CaptureError && /expected an address matching \^#product/.test(e.message));
  assert.deepEqual(page.state.shots, []);
});

test("a store error page is never captured as the guest order", async () => {
  // The order lookup failed: the store sets the body view, writes #message, and keeps "Loading store…".
  const page = fakePage({ onGoto: (url, st) => { shows(st, ["#message:not(:empty)", "#view > p:only-child"]); st.texts["#message:not(:empty)"] = "Order not found."; } });
  await assert.rejects(build("guest-order", page), (e) => /expected UI not visible: body\[data-view="order"\] \.order-page/.test(e.message));
  assert.deepEqual(page.state.shots, []);
  assert.equal(page.state.visits[0], `${STORE}/#order/order-1/tok%2F1`);
});

test("expected UI beside an error message still fails, naming the error", async () => {
  const page = fakePage({ onGoto: (url, st) => { shows(st, [...expectations(screen("guest-order")), "#message:not(:empty)"]); st.texts["#message:not(:empty)"] = "Payment check failed."; } });
  await assert.rejects(build("guest-order", page), (e) => /error or loading UI shown: #message:not\(:empty\) \("Payment check failed\."\)/.test(e.message));
  assert.deepEqual(page.state.shots, []);
});

test("a page that turns into a loading or error view while settling is not captured", async () => {
  const s = screen("guest-shop");
  const page = fakePage({
    onGoto: (url, st) => shows(st, expectations(s)),
    onSettle: (st) => { st.shown.clear(); shows(st, ["#view > p:only-child"]); },
  });
  await assert.rejects(build("guest-shop", page), (e) => /error or loading UI shown: #view > p:only-child.* once the page settled$/.test(e.message));
  assert.deepEqual(page.state.shots, []);

  // Or redirects away (a session that ran out) once the expected UI has been seen.
  const devices = screen("devices");
  const moved = fakePage({ onGoto: (url, st) => shows(st, expectations(devices)), onSettle: (st) => { st.href = `${PORTAL}/login`; } });
  await assert.rejects(build("devices", moved), /landed on \/login once the page settled/);
  assert.deepEqual(moved.state.shots, []);
});

test("the portal shop's failure view is rejected even on the right route and tab", async () => {
  const s = screen("product");
  const page = fakePage({
    onGoto: (url, st) => shows(st, ['[data-portal-tab="shop"][aria-current="page"]']),
    clicks: { ".portal-shop__item": (st) => { st.href = `${PORTAL}/dashboard#product/p1`; shows(st, [...expectations(s), '.error[role="alert"]:not(:empty)']); } },
  });
  await assert.rejects(build("product", page), /error or loading UI shown: \.error\[role="alert"\]/);
  assert.deepEqual(page.state.shots, []);
});

test("a redirect to sign-in is reported with where the page landed", async () => {
  const page = fakePage({ onGoto: (url, st) => { st.href = `${PORTAL}/login`; shows(st, ["#login"]); } });
  await assert.rejects(build("devices", page), (e) => /expected UI not visible: #manageDevices\[data-sub-active\]; expected \/dashboard but landed on \/login/.test(e.message));
  assert.deepEqual(page.state.shots, []);
});

test("HTTP errors, failed steps and missing fixtures fail before any picture", async () => {
  const http = fakePage({ onGoto: (url, st) => { st.status = 502; shows(st, expectations(screen("guest-shop"))); } });
  await assert.rejects(build("guest-shop", http), /answered 502/);
  const noProducts = fakePage({ onGoto: (url, st) => shows(st, ["#view > p:only-child"]) });
  await assert.rejects(build("guest-checkout", noProducts), /could not click \[data-product\] \(at http:\/\/localhost:\d+\/\)/);
  const unused = fakePage();
  await assert.rejects(build("guest-order", unused, { fixtures: {} }), /demo fixture "guestOrderId" is unavailable/);
  assert.deepEqual(unused.state.visits, [], "nothing was opened");
  for (const page of [http, noProducts, unused]) assert.deepEqual(page.state.shots, []);
});

test("fill steps type their value before the next click", async () => {
  const s = screen("admin-voucher-print"), typed = [];
  const page = fakePage({
    clicks: {
      '#generate [name="quantity"]': (st, value) => typed.push(value),
      '#generate button[type="submit"]': () => {},
      '#generated a[href="/dashboard#voucher-print"]': (st) => { st.href = st.href.replace(/#.*$/, "#voucher-print"); shows(st, expectations(s)); },
    },
  });
  const result = await captureBuild(page, s, { origin: "http://localhost:8081", fixtures: {}, files: filesFor("avp-t"), phone: false, timeout: 20 });
  assert.deepEqual(typed, ["3"]);
  assert.equal(result.steps[0], 'fill #generate [name="quantity"] with "3"');
});

test("design artboards count only when the canvas runtime is ready and drew something", async () => {
  const url = `${DESIGN}/design/PhoneGuestOrder.dc.html`, files = filesFor("design-t");
  const ok = fakePage({ attrs: { "data-dc-ready": "", "data-dc-settled": "yes" }, scroll: true });
  assert.deepEqual(await captureDesign(ok, { url, files, phone: true, timeout: 20 }), { url, settled: true, full: true });

  const cases = [
    [{ attrs: { "data-dc-ready": "error", "data-dc-error": "Could not load AdminSide.dc.html (404)" } }, /did not render: Could not load AdminSide\.dc\.html \(404\)/],
    [{ attrs: {} }, /did not finish within 20 ms/],
    [{ attrs: { "data-dc-ready": "" }, drawn: false }, /reported ready but drew nothing/],
    [{ attrs: { "data-dc-ready": "" }, onGoto: (u, st) => { st.href = `${DESIGN}/`; } }, /expected \/design\/PhoneGuestOrder\.dc\.html but landed on \/$/],
    [{ attrs: { "data-dc-ready": "" }, onGoto: (u, st) => { st.status = 404; } }, /answered 404/],
  ];
  for (const [options, message] of cases) {
    const page = fakePage(options);
    await assert.rejects(captureDesign(page, { url, files, phone: true, timeout: 20 }), message);
    assert.deepEqual(page.state.shots, [], String(message));
  }
  const slow = fakePage({ attrs: { "data-dc-ready": "", "data-dc-settled": "timeout" } });
  assert.equal((await captureDesign(slow, { url, files, phone: false, timeout: 20 })).settled, false, "recorded, not hidden");
});

test("a capture run records every outcome, leaves no stale gallery PNG for a failure, and writes the manifest", async () => {
  const run = join(dir, "run");
  await mkdir(run, { recursive: true });
  // Pictures from an earlier run that must not survive a failed capture.
  for (const name of ["guest-order-build-390.png", "guest-order-build-390-full.png"]) await writeFile(join(run, name), "old");
  const contexts = [];
  const launch = async () => ({
    newPage: async () => fakePage({ attrs: { "data-dc-ready": "", "data-dc-settled": "yes" }, scroll: true }),
    newContext: async (options) => {
      const context = { options, cookies: [], routes: [], closed: false };
      Object.assign(context, {
        addCookies: async (cookies) => context.cookies.push(...cookies),
        route: async (pattern) => context.routes.push(pattern),
        close: async () => { context.closed = true; },
        newPage: async () => fakePage({
          onGoto: (url, st) => {
            // Guest order: the lookup failed. Home router: the "not enabled" notice the screen is blocked on.
            if (url.startsWith(STORE)) { shows(st, ["#message:not(:empty)"]); st.texts["#message:not(:empty)"] = "Order not found."; }
            else shows(st, expectations(screen("home-router")));
          },
        }),
      });
      contexts.push(context);
      return context;
    },
    close: async () => {},
  });
  const state = { cookie: "customer_session=demo-cookie", staff: { owner: "demo-owner" }, fixtures: FIXTURES, warnings: ["mock warning"] };
  const manifest = await capture(state, { only: ["guest-order", "home-router"], dir: run, launch, source: { sha: "abc123", dirty: true }, timeout: 20 });

  assert.deepEqual(summarize(manifest), { captured: 2, blocked: 1, failed: 1 });
  const find = (id, kind) => manifest.results.find((r) => r.id === id && r.kind === kind);
  const failed = find("guest-order", "build");
  assert.equal(failed.status, "failed");
  assert.equal(failed.success, false);
  assert.match(failed.error, /expected UI not visible: body\[data-view="order"\] \.order-page/);
  assert.equal(failed.file, undefined, "no gallery image for a failed capture");
  assert.equal(failed.failedFile, "guest-order-build-390-failed.png");
  assert.equal(failed.session, "signed out");
  assert.equal(await exists(join(run, "guest-order-build-390.png")), false, "the old picture was removed");
  assert.equal(await exists(join(run, "guest-order-build-390-full.png")), false);
  assert.equal(await exists(join(run, failed.failedFile)), true, "a diagnosis picture is kept apart");

  const design = find("guest-order", "design");
  assert.deepEqual([design.status, design.board, design.file, design.fullFile, design.viewport], ["captured", "PhoneGuestOrder", "guest-order-design-390.png", "guest-order-design-390-full.png", { width: 390, height: 844 }]);
  const blocked = find("home-router", "build");
  assert.equal(blocked.status, "blocked");
  assert.equal(blocked.success, false, "blocked is never counted as a match for the artboard");
  assert.match(blocked.blocked, /not enabled/);
  assert.equal(blocked.session, "demo customer");

  // Cookies: the store is signed out; the portal gets only the account cookie on /api/account.
  assert.equal(contexts.length, 2);
  const portalContext = contexts.find((c) => c.cookies.some((k) => k.name === "customer_session"));
  const storeContext = contexts.find((c) => c !== portalContext);
  assert.ok(portalContext && storeContext);
  assert.deepEqual(storeContext.cookies.map((c) => c.name), ["ndahi_ui"]);
  const session = portalContext.cookies.find((c) => c.name === "customer_session");
  assert.deepEqual([session.value, session.path, session.httpOnly], ["demo-cookie", "/api/account", true]);
  assert.ok(contexts.every((c) => c.closed), "every browser context is closed");

  const written = JSON.parse(await readFile(join(run, "manifest.json"), "utf8"));
  assert.deepEqual(written.source, { sha: "abc123", dirty: true });
  assert.deepEqual(written.warnings, ["mock warning"]);
  assert.ok(written.finishedAt);
  assert.equal(written.results.length, 4);
});

test("the default capture folder is a new private mkdtemp folder, the same for the whole run", async () => {
  const chosen = process.env.PREVIEW_CAPTURE_DIR;
  const folder = await captureDir();
  try {
    assert.equal(await captureDir(), folder, "one folder per preview process");
    assert.ok((await stat(folder)).isDirectory());
    if (chosen) assert.equal(folder, resolve(chosen), "an explicitly chosen folder is used as given");
    else {
      assert.equal(dirname(folder), resolve(tmpdir()));
      assert.match(basename(folder), /^ndahi-redesign-preview-.{6,}$/, "a unique name, not a fixed /tmp path");
      assert.notEqual(folder, "/tmp/ndahi-redesign-preview");
      if (process.platform !== "win32") assert.equal((await stat(folder)).mode & 0o777, 0o700, "readable only by this user");
      assert.equal(await readManifest(), null, "a new folder has no manifest yet");
    }
  } finally {
    if (!chosen) await rm(folder, { recursive: true, force: true });
  }
});

test("the manifest is written to a new file and renamed into place, never through a planted link", async () => {
  const run = join(dir, "manifest-link");
  await mkdir(run, { recursive: true });
  const victim = join(dir, "victim.txt");
  await writeFile(victim, "untouched");
  let linked = true;
  try { await symlink(victim, join(run, "manifest.json")); } catch { linked = false; /* No symlink permission (Windows): still check the write. */ }
  await writeManifest(run, { results: [], source: { sha: "abc123" } });
  assert.equal(await readFile(victim, "utf8"), "untouched", "the link target was not written");
  const written = await lstat(join(run, "manifest.json"));
  assert.ok(written.isFile() && !written.isSymbolicLink(), linked ? "the link was replaced by the manifest" : "a plain file");
  if (process.platform !== "win32") assert.equal(written.mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(join(run, "manifest.json"), "utf8")).source, { sha: "abc123" });
  assert.deepEqual(await readManifest(run), { results: [], source: { sha: "abc123" } });
  assert.deepEqual((await readdir(run)).filter((name) => name.startsWith(".manifest-")), [], "no staging file is left");
});

test("confirmShown can be used on its own and checks route, rejections, then expectations", async () => {
  const s = screen("guest-checkout");
  const page = fakePage();
  page.state.href = `${STORE}/#product/p1`;
  shows(page.state, expectations(s));
  await confirmShown(page, s);
  page.state.shown.add("#checkoutError:not(:empty)");
  page.state.texts["#checkoutError:not(:empty)"] = "Out of stock";
  await assert.rejects(confirmShown(page, s), /error or loading UI shown: #checkoutError:not\(:empty\) \("Out of stock"\)/);
});
