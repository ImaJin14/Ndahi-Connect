import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { publishInitialStoreCatalogue } from "../lib/initial-store-catalogue.mjs";
import { chromium } from "playwright";
const store = createStore({ persistent: false });
await publishInitialStoreCatalogue({ store });
// Deliberately open only this disposable fixture: unpriced purchase protection
// must work independently of the production store's closed-checkout setting.
await store.transaction((s) => {
  s.storeSettings.open = true;
  s.storeSettings.pickup = "Fixture office";
});
const api = "http://127.0.0.1:9182",
  origin = "http://127.0.0.1:9183";
const server = createServer({
  store,
  validateConfig: false,
  env: {
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    STORE_APP_URL: origin,
    ALLOWED_STORE_ORIGINS: origin,
    BILLING_WORKER_ENABLED: "false",
    SECURITY_ALERTS_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false",
  },
});
const site = createStaticServer("store", { apiUrl: api });
const listen = (s, port) => new Promise((r) => s.listen(port, "127.0.0.1", r));
const close = (s) => {
  s.closeAllConnections();
  return new Promise((r) => s.close(r));
};
let browser;
try {
  await listen(server, 9182);
  await listen(site, 9183);
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 1280]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(origin);
    await page.locator(".products .product").last().waitFor();
    assert.equal(await page.locator(".products .product").count(), 4);
    assert.equal(
      await page
        .locator(".products .price")
        .filter({ hasText: "Price to be confirmed" })
        .count(),
      4,
    );
    for (const name of [
      "TP-Link AX1500 Travel Router",
      "TP-Link CPE210",
      "Wavlink AC1200",
      "Wavlink Mini",
    ]) {
      const card = page
        .locator(".products .product")
        .filter({ has: page.getByRole("heading", { name, exact: true }) });
      await card.getByRole("button").click();
      assert.equal(await page.locator("#buy").isDisabled(), true);
      await page.keyboard.press("Escape");
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
      true,
    );
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `PASS four published/unpriced products; purchase disabled at ${width}px`,
    );
  }
} finally {
  await browser?.close();
  await Promise.all([close(server), close(site)]);
}
