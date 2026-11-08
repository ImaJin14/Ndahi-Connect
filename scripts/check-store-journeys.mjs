import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { chromium } from "playwright";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { storeState } from "../lib/device-store.mjs";
const store = createStore({ persistent: false }),
  secret = randomUUID(),
  token = randomUUID(),
  csrf = randomUUID();
const enFr = (en, fr = en) => ({ en, fr });
await store.transaction((s) => {
  storeState(s);
  Object.assign(s.storeSettings, {
    open: true,
    contact: "Store test desk",
    pickup: "NDAHI office — test pickup location",
    hours: "Monday–Saturday, 09:00–17:00",
    warranty: enFr("Test warranty terms", "Conditions de garantie de test"),
    returns: enFr(
      "Contact us for returns.",
      "Contactez-nous pour les retours.",
    ),
  });
  s.storeCategories.push(
    {
      id: "routers",
      version: 1,
      name: enFr("Travel routers", "Routeurs de voyage"),
      position: 0,
      hidden: false,
    },
    {
      id: "extenders",
      version: 1,
      name: enFr("Wi-Fi extenders", "Répéteurs Wi-Fi"),
      position: 1,
      hidden: false,
    },
  );
  for (const [id, name, fr, categoryId, price] of [
    ["test-router", "Travel router", "Routeur de voyage", "routers", 18000],
    ["test-extender", "Wi-Fi extender", "Répéteur Wi-Fi", "extenders", 12000],
    ["test-cable", "Ethernet cable", "Câble Ethernet", "", 2000],
  ])
    s.storeProducts.push({
      id,
      version: 1,
      sku: id,
      name: enFr(name, fr),
      description: enFr(
        "Fixture equipment for browser validation.",
        "Équipement de test pour validation navigateur.",
      ),
      specifications: enFr("Test specification"),
      compatibility: enFr("Physical compatibility is not verified."),
      contents: enFr("Device and setup guide"),
      warranty: enFr("Test warranty"),
      setup: enFr("Follow the setup guide."),
      categoryId,
      price,
      cost: 1000,
      images: [],
      stock: 10,
      status: "published",
      featured: id === "test-router",
    });
  s.adminUsers.push({
    id: "owner",
    username: "owner",
    role: "owner",
    active: true,
  });
  s.adminSessions.push({
    id: "owner-session",
    userId: "owner",
    role: "owner",
    tokenHash: hashSecret(token, secret),
    csrfToken: csrf,
    expiresAt: "2035-01-01T00:00:00Z",
  });
});
const api = createServer({
  store,
  validateConfig: false,
  env: {
    NODE_ENV: "test",
    PAYMENT_MODE: "mock",
    SECRET_PEPPER: secret,
    ADMIN_SESSION_SECRET: secret,
    STORE_APP_URL: "http://127.0.0.1:9193",
    CUSTOMER_APP_URL: "http://127.0.0.1:9190",
    ADMIN_APP_URL: "http://127.0.0.1:9191",
    ALLOWED_ADMIN_ORIGINS: "http://127.0.0.1:9191",
    NETWORK_QUEUE_ENABLED: "false",
    BILLING_WORKER_ENABLED: "false",
    PAYMENT_WEBHOOK_REPLAY_ENABLED: "false",
  },
});
const website = createStaticServer("store", {
    apiUrl: "http://127.0.0.1:9192",
  }),
  admin = createStaticServer("admin", { apiUrl: "http://127.0.0.1:9192" });
const listen = (server, port) =>
  new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
let browser, activePage;
let checks = 0;
try {
  await listen(api, 9192);
  await listen(website, 9193);
  await listen(admin, 9191);
  browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
  for (const width of [320, 1280]) {
    const context = await browser.newContext({
        viewport: { width, height: 1000 },
      }),
      page = await context.newPage(),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await context.addInitScript(() =>
      localStorage.setItem("ndahi-store-language", "fr"),
    );
    await page.goto("http://127.0.0.1:9193/");
    await page
      .getByRole("heading", { name: "Find your connection." })
      .waitFor();
    assert.equal(await page.locator(".product").count(), 3);
    checks++;
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    checks++;
    await page.screenshot({
      path: `/tmp/ndahi-store-${width}.png`,
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Travel routers", exact: true })
      .click();
    assert.equal(await page.locator(".product").count(), 1);
    checks++;
    assert.equal(await page.locator("#language").count(), 0);
    assert.equal(await page.locator("html").getAttribute("lang"), "en");
    checks++;
    await page.getByRole("button", { name: "View device" }).click();
    await page.locator("#productTitle").waitFor();
    await page.getByRole("button", { name: "Buy this device" }).click();
    await page.getByLabel("Full name").fill("Guest browser buyer");
    await page.getByLabel("Contact phone").fill("670000099");
    await page.getByLabel("Mobile Money number").fill("690000099");
    await page.getByRole("button", { name: "Pay with Mobile Money" }).click();
    await page.waitForURL(/#order\//);
    await page.getByRole("button", { name: "Check payment" }).click();
    await page.getByText("Preparing your order", { exact: true }).waitFor();
    checks++;
    const receiptDownload = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download receipt", exact: true }).click();
    const receiptFile = await receiptDownload;
    assert.match(receiptFile.suggestedFilename(), /^ndahi-store-receipt-/);
    const receiptBytes = await readFile(await receiptFile.path());
    assert.equal(receiptBytes.subarray(0, 5).toString(), "%PDF-");
    checks++;
    const url = page.url();
    await page.reload();
    await page.getByText("Preparing your order", { exact: true }).waitFor();
    assert.equal(page.url(), url);
    checks++;
    await page
      .getByRole("link", { name: "My orders", exact: true })
      .first()
      .click();
    await page
      .getByRole("heading", { name: "Recent orders on this browser" })
      .waitFor();
    checks++;
    assert.deepEqual(errors, []);
    await context.close();
    const staff = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    await staff.addCookies([
      {
        name: "admin_session",
        value: token,
        domain: "127.0.0.1",
        path: "/api/admin",
      },
    ]);
    const panel = await staff.newPage();
    panel.setDefaultTimeout(15000);
    activePage = panel;
    panel.on("dialog", (dialog) => dialog.accept());
    panel.on("pageerror", (e) => errors.push(e.message));
    let firstStoreRead = true;
    await panel.route("**/api/admin/store", async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      if (firstStoreRead) {
        firstStoreRead = false;
        return route.fulfill({
          status: 503,
          headers: {
            "Access-Control-Allow-Origin": "http://127.0.0.1:9191",
            "Access-Control-Allow-Credentials": "true",
          },
          contentType: "application/json",
          body: JSON.stringify({ error: "Store temporarily unavailable" }),
        });
      }
      return route.continue();
    });
    await panel.goto("http://127.0.0.1:9191/dashboard#store");
    await panel
      .getByText("Store temporarily unavailable", { exact: true })
      .waitFor();
    await panel
      .getByRole("button", { name: "Retry loading store", exact: true })
      .click();
    checks++;
    assert.equal(
      await panel
        .getByRole("button", { name: "Open store management" })
        .count(),
      0,
    );
    await panel
      .getByRole("button", { name: "Close checkout", exact: true })
      .click();
    await panel
      .getByText("Closed — new orders paused", { exact: true })
      .waitFor();
    assert.equal((await store.snapshot()).storeSettings.open, false);
    await panel
      .getByRole("button", { name: "Open checkout", exact: true })
      .click();
    await panel
      .getByText("Open — accepting new orders", { exact: true })
      .waitFor();
    assert.equal((await store.snapshot()).storeSettings.open, true);
    checks++;
    await panel.getByRole("link", { name: "Home", exact: true }).click();
    await panel.getByRole("link", { name: "Store", exact: true }).click();
    await panel
      .getByRole("heading", { name: "Store overview", exact: true })
      .waitFor();
    await panel.locator('[data-order-filter="preparing"]').click();
    assert.equal(
      await panel.locator("#storeOrderStatus").inputValue(),
      "preparing",
    );
    assert.equal(
      await panel.locator("#storeOrderRows tbody tr").count(),
      (await store.snapshot()).storeOrders.filter(
        (o) => o.status === "preparing",
      ).length,
    );
    await panel.locator("#storeOrderStatus").selectOption("collected");
    await panel
      .getByText("No orders match this view.", { exact: true })
      .waitFor();
    await panel.locator("#storeOrderStatus").selectOption("all");
    assert.equal(
      await panel.locator("#storeOrderRows tbody tr").count(),
      (await store.snapshot()).storeOrders.length,
    );
    await panel.getByRole("button", { name: "Overview", exact: true }).click();
    await panel
      .getByRole("button", { name: "Update stock", exact: true })
      .click();
    await panel
      .getByRole("heading", { name: "Inventory", exact: true })
      .waitFor();
    await panel.getByRole("button", { name: "Overview", exact: true }).click();
    await panel.screenshot({
      path: `/tmp/ndahi-store-overview-${width}.png`,
      fullPage: true,
    });
    assert.equal(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    checks++;

    await panel
      .getByRole("button", { name: "Add product", exact: true })
      .waitFor();
    await panel
      .getByRole("button", { name: "Add product", exact: true })
      .click();
    const form = panel.locator("#storeProductForm");
    await form.locator('[name="name.en"]').fill("Browser draft " + width);
    await form
      .locator('[name="name.fr"]')
      .fill("Brouillon navigateur " + width);
    await form.locator('[name="sku"]').fill("BROWSER-" + width);
    await form.locator('[name="price"]').fill("5000");
    const imageData = await panel.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = 20;
      canvas.height = 20;
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#174e38";
      ctx.fillRect(0, 0, 20, 20);
      return canvas.toDataURL("image/png");
    });
    await panel.locator("#storeImageUpload").setInputFiles({
      name: "test.png",
      mimeType: "image/png",
      buffer: Buffer.from(imageData.split(",")[1], "base64"),
    });
    await panel.locator("#storeImages fieldset").waitFor();
    await panel.locator('[name="image0.en"]').fill("Test product image");
    await panel.locator('[name="image0.fr"]').fill("Image du produit test");

    await panel
      .getByRole("button", { name: "Save product", exact: true })
      .click();
    await panel
      .getByRole("row")
      .filter({ hasText: "BROWSER-" + width })
      .waitFor();
    checks++;
    const row = panel.getByRole("row").filter({ hasText: "BROWSER-" + width });
    await row.getByRole("button", { name: "Edit", exact: true }).click();
    await panel.locator('#storeProductForm [name="price"]').fill("5500");
    await panel
      .getByRole("button", { name: "Save product", exact: true })
      .click();
    await row.getByText("5,500 FCFA", { exact: true }).waitFor();
    checks++;
    await row.getByRole("button", { name: "Delete", exact: true }).click();
    await row.waitFor({ state: "detached" });
    checks++;
    await panel
      .getByRole("button", { name: "Categories", exact: true })
      .click();
    await panel
      .getByRole("button", { name: "Add category", exact: true })
      .click();
    await panel
      .locator('#categoryForm [name="name.en"]')
      .fill("Test accessories " + width);
    await panel
      .locator('#categoryForm [name="name.fr"]')
      .fill("Accessoires test " + width);
    await panel.getByRole("button", { name: "Save category" }).click();
    await panel.getByText(new RegExp("Test accessories " + width)).waitFor();
    checks++;
    await panel.getByRole("button", { name: "Stock", exact: true }).click();
    await panel.locator('#stockForm [name="delta"]').fill("2");
    await panel
      .locator('#stockForm [name="reason"]')
      .fill("Browser stock receipt " + width);
    await panel.getByRole("button", { name: "Record adjustment" }).click();
    await panel
      .getByRole("cell", {
        name: "Browser stock receipt " + width + " / owner",
      })
      .waitFor();
    checks++;
    await panel.getByRole("button", { name: "Settings", exact: true }).click();
    await panel
      .locator('#storeSettingsForm [name="banner.en"]')
      .fill("Browser store update " + width);
    await panel
      .locator('#storeSettingsForm [name="banner.fr"]')
      .fill("Actualité boutique " + width);
    const settingsSaved = panel.waitForResponse(
      (response) =>
        response.url().endsWith("/api/admin/store/settings/save") &&
        response.status() === 200,
    );
    await panel.getByRole("button", { name: "Save store settings" }).click();
    await settingsSaved;
    assert.equal(
      (await (await fetch("http://127.0.0.1:9192/api/store/catalogue")).json())
        .settings.banner.en,
      "Browser store update " + width,
    );
    checks++;
    await panel.unroute("**/api/admin/store");
    await panel.route("**/api/admin/store", async (route) => {
      const response = await route.fetch();
      const snapshot = await response.json();
      snapshot.settings.open = false;
      snapshot.settings.contact = "";
      return route.fulfill({ response, json: snapshot });
    });
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel
      .getByText("Closed — new orders paused", { exact: true })
      .waitFor();
    assert.equal(
      await panel
        .getByRole("button", { name: "Open checkout", exact: true })
        .isDisabled(),
      true,
    );
    await panel
      .getByText("Configuration missing: Contact details.", { exact: true })
      .waitFor();
    await panel.unroute("**/api/admin/store");
    await panel.getByRole("button", { name: "Refresh", exact: true }).click();
    await panel
      .getByText("Open — accepting new orders", { exact: true })
      .waitFor();
    checks++;
    await panel.screenshot({
      path: `/tmp/ndahi-store-admin-${width}.png`,
      fullPage: true,
    });
    assert.ok(
      await panel.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth + 1,
      ),
    );
    checks++;
    assert.deepEqual(errors, []);
    await staff.close();
  }
  const recoveryContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    recovery = await recoveryContext.newPage();
  await recovery.goto("http://127.0.0.1:9193/");
  await recovery.locator('[data-product="test-cable"]').click();
  await recovery.getByRole("button", { name: "Buy this device" }).click();
  await recovery.getByLabel("Full name").fill("Lost response buyer");
  await recovery.getByLabel("Contact phone", { exact: true }).fill("670000098");
  await recovery
    .getByLabel("Mobile Money number", { exact: true })
    .fill("690000098");
  await recovery.route(
    "**/api/store/checkout",
    async (route) => {
      await route.fetch();
      await route.abort();
    },
    { times: 1 },
  );
  await recovery.getByRole("button", { name: "Pay with Mobile Money" }).click();
  await recovery
    .locator("#checkoutError")
    .filter({ hasText: /fetch/i })
    .waitFor();
  await recovery.reload();
  await recovery.getByRole("button", { name: "Resume checkout" }).click();
  await recovery.getByRole("button", { name: "Pay with Mobile Money" }).click();
  await recovery.waitForURL(/#order\//);
  await recovery.getByRole("button", { name: "Check payment" }).click();
  await recovery.getByText("Preparing your order", { exact: true }).waitFor();
  checks++;
  await recoveryContext.close();
  const s = await store.snapshot();
  assert.equal(s.vouchers.length, 0);
  assert.equal(s.storeOrders.length, 3);
  assert.ok(s.storeOrders.every((o) => o.payment.status === "paid"));
  checks++;
  console.log(
    JSON.stringify({
      status: "passed",
      checks,
      widths: [320, 1280],
      payments: "mock",
      hardware: "not physically verified",
      screenshots: "/tmp/ndahi-store-*.png",
    }),
  );
} catch (error) {
  if (activePage) {
    console.error(
      await activePage
        .locator("#storeAdminMessage")
        .textContent()
        .catch(() => ""),
    );
    await activePage
      .screenshot({
        path: "/tmp/ndahi-store-browser-failure.png",
        fullPage: true,
      })
      .catch(() => {});
  }
  throw error;
} finally {
  await browser?.close();
  for (const app of [api, website, admin])
    await new Promise((resolve) => {
      app.closeAllConnections();
      app.close(resolve);
    });
}
