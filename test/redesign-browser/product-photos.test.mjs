import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { deflateSync, crc32 } from "node:zlib";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Product photos, up to 30 (owner, 21 Nov; taken over from Codex). The owner
// adds photos in Edit product until the picker stops at 30 and saves; the
// public store and the portal show the main photo with a row of thumbnails
// (canvas: ProductDesktop), each loaded from the API, and choosing one shows
// it. The catalogue carries addresses, not images. Local servers only.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const words = { en: "Router", fr: "Routeur" };

// A real PNG of one colour, so browsers decode it.
function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8), tail = Buffer.alloc(4), body = Buffer.concat([Buffer.from(type), data]);
    head.writeUInt32BE(data.length);
    head.write(type, 4);
    tail.writeUInt32BE(crc32(body));
    return Buffer.concat([head.subarray(0, 4), body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: width }, () => [r, g, b]).flat())]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))), chunk("IEND", Buffer.alloc(0))]);
}
const colour = (n) => [40 + ((n * 53) % 200), 90 + ((n * 29) % 150), 60 + ((n * 71) % 180)];

test("the owner adds photos up to 30, and shoppers browse them in the store and the portal", { timeout: 300000 }, async (t) => {
  const secret = "redesign-product-photos", store = createStore({ persistent: false });
  // 28 photos already on the product, stored as the admin would store them.
  const ids = [];
  for (let n = 0; n < 28; n++) {
    const bytes = png(320, 240, colour(n)), id = createHash("sha256").update(bytes).digest("hex");
    await store.photos.put({ id, mime: "image/png", bytes: bytes.length, data: bytes.toString("base64") });
    ids.push(id);
  }
  await store.transaction((s) => {
    storeState(s);
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "Bandja Street", contact: "WhatsApp +237671493902", hours: "Mon–Sat 9:00–18:00", warranty: words, returns: words };
    s.storeProducts.push({ id: "ax1500", version: 1, stock: 5, sku: "AX1500", name: { en: "TP-Link AX1500 Travel Router", fr: "Routeur de voyage TP-Link AX1500" },
      description: { en: "Dual-band Wi-Fi 6 router.", fr: "Routeur Wi-Fi 6." }, specifications: words, compatibility: words, contents: words, warranty: words, setup: words,
      images: ids.map((id, n) => ({ id, mime: "image/png", bytes: 1, alt: { en: `View ${n + 1}`, fr: `Vue ${n + 1}` } })),
      price: 120000, cost: 80000, status: "published", featured: true, categoryId: "" });
    s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "owner", role: "owner", tokenHash: hashSecret("owner-token", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.customers.push({ id: "amina", name: "Amina Nfor", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const staticEnv = { env: { NODE_ENV: "test" } };
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, ...staticEnv }));
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, ...staticEnv }));
  const storeServer = await listen(createStaticServer("store", { apiUrl: api, ...staticEnv }));
  const [admin, portal, shop] = [adminServer, portalServer, storeServer].map((s) => `http://127.0.0.1:${s.address().port}`);
  const apiServer = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    SESSION_COOKIE_SECURE: "false", ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, CUSTOMER_APP_URL: portal, STORE_APP_URL: shop, PAYMENT_MODE: "mock", EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); await close(portalServer); await close(storeServer); });
  const screenshots = process.env.PRODUCT_PHOTOS_SCREENSHOTS || "/tmp/ndahi-product-photos";
  await mkdir(screenshots, { recursive: true });
  const open = async (width, cookies = []) => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 900 } });
    await context.route("**/*", (route) => [api, admin, portal, shop].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: portal, sameSite: "Lax" }, ...cookies]);
    const page = await context.newPage(), errors = [], csp = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (/Content Security Policy/.test(message.text())) csp.push(message.text()); });
    page.on("dialog", (dialog) => dialog.accept());
    return { context, page, errors, csp };
  };
  const check = async (page, label) => {
    await page.evaluate(() => { document.activeElement?.blur(); scrollTo(0, 0); });
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  // A loaded image: decoded, from the API's photo address.
  const loaded = (img) => img.evaluate((el) => el.complete && el.naturalWidth > 0 && el.currentSrc);
  const ownerCookie = { name: "admin_session", value: "owner-token", url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" };
  const customerCookie = { name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" };

  // The owner adds two photos; at 30 the picker stops.
  let { context, page, errors, csp } = await open(1280, [ownerCookie]);
  await page.goto(`${admin}/dashboard#product/ax1500`);
  // The drawn grid (canvas: AdminProductEdit, #387): one square per photo, the
  // first outlined as the main one, then "+ Add".
  const photos = page.locator("#storeImages .is-photo");
  await photos.nth(27).waitFor();
  assert.equal(await photos.count(), 28);
  assert.match(await loaded(photos.first().locator("img")), new RegExp(`^${api}/api/store/photos/${ids[0]}$`));
  assert.equal(await page.locator("#storeImages .is-main").count(), 1);
  const picker = page.locator("#storeImageUpload");
  for (const n of [28, 29]) {
    await picker.setInputFiles({ name: `photo-${n}.png`, mimeType: "image/png", buffer: png(320, 240, colour(n)) });
    await photos.nth(n).waitFor();
  }
  assert.equal(await photos.count(), 30);
  assert.equal(await picker.isDisabled(), true, "no 31st photo");
  assert.equal(await page.locator(".admin-photos__add").innerText(), "30 photos, the most a product can have. Remove one to add another.");
  // Each photo's alternative text is under the collapsed Photo details (kept by the owner, 25 Nov).
  await page.locator("#productPhotoDetails > summary").click();
  const details = page.locator("#storePhotoDetails fieldset");
  assert.equal(await details.count(), 30);
  await details.nth(29).locator('[name="image29.en"]').fill("Ports and power");
  await details.nth(29).locator('[name="image29.fr"]').fill("Ports et alimentation");
  await page.getByRole("button", { name: "Save product" }).click();
  await page.locator("#storeSaved").filter({ hasText: "Saved" }).waitFor();
  const saved = (await store.snapshot()).storeProducts.find((p) => p.id === "ax1500");
  assert.equal(saved.images.length, 30);
  assert.ok(saved.images.every((image) => /^[0-9a-f]{64}$/.test(image.id) && !image.data), "references only");
  assert.equal(saved.images[29].mime, "image/webp", "resized in the browser before upload");
  assert.deepEqual(saved.images[29].alt, { en: "Ports and power", fr: "Ports et alimentation" });
  await check(page, "admin-edit-30-photos-1280");
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, []);
  await context.close();

  // The catalogue carries addresses only.
  const catalogue = await fetch(`${api}/api/store/catalogue`).then((r) => r.text());
  assert.ok(catalogue.length < 60000, `catalogue is ${catalogue.length} bytes`);

  // The public store: the main photo, 30 thumbnails, choose the last.
  for (const width of [390, 1280]) {
    ({ context, page, errors, csp } = await open(width));
    await page.goto(`${shop}/#product/ax1500`);
    const main = page.locator(".detail-media .product-visual img");
    await main.waitFor();
    await page.waitForFunction(() => document.querySelector(".detail-media .product-visual img")?.naturalWidth > 0);
    assert.equal(await loaded(main), `${api}/api/store/photos/${ids[0]}`);
    const thumbs = page.getByRole("group", { name: "Product image" }).getByRole("button");
    assert.equal(await thumbs.count(), 30);
    assert.equal(await thumbs.first().getAttribute("aria-pressed"), "true");
    const last = page.getByRole("button", { name: "Show photo 30 of 30" });
    await last.scrollIntoViewIfNeeded();
    await last.click();
    assert.equal(await last.getAttribute("aria-pressed"), "true");
    assert.equal(await thumbs.first().getAttribute("aria-pressed"), "false");
    await page.waitForFunction((id) => document.querySelector(".detail-media .product-visual img")?.currentSrc.endsWith(id) &&
      document.querySelector(".detail-media .product-visual img").naturalWidth > 0, saved.images[29].id);
    assert.equal(await main.getAttribute("alt"), "Ports and power");
    await check(page, `store-product-photos-${width}`);
    assert.deepEqual(errors, []);
    assert.deepEqual(csp, []);
    await context.close();
  }

  // The portal (signed in): the same photos and thumbnails.
  for (const width of [390, 1280]) {
    ({ context, page, errors, csp } = await open(width, [customerCookie]));
    await page.goto(`${portal}/dashboard#product/ax1500`);
    const media = page.locator(".portal-shop__media"), main = media.locator(".portal-shop__photo img");
    await main.waitFor();
    await page.waitForFunction(() => document.querySelector(".portal-shop__photo img")?.naturalWidth > 0);
    assert.equal(await loaded(main), `${api}/api/store/photos/${ids[0]}`);
    const thumbs = page.getByRole("group", { name: "Product photos" }).getByRole("button");
    assert.equal(await thumbs.count(), 30);
    const second = page.getByRole("button", { name: "Show photo 2 of 30" });
    await second.click();
    assert.equal(await second.getAttribute("aria-pressed"), "true");
    await page.waitForFunction((id) => document.querySelector(".portal-shop__photo img")?.currentSrc.endsWith(id), ids[1]);
    assert.equal(await main.getAttribute("alt"), "View 2");
    if (width >= 1024) {
      // Desktop: photos on the left, the product's details on the right.
      const [photoBox, nameBox] = [await media.boundingBox(), await page.locator(".portal-shop__name").boundingBox()];
      assert.ok(photoBox.x + photoBox.width <= nameBox.x, "the photos keep the left column");
    }
    await check(page, `portal-product-photos-${width}`);
    assert.deepEqual(errors, []);
    assert.deepEqual(csp, []);
    await context.close();
  }
});
