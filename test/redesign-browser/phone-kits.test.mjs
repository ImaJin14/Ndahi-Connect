import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { storeState } from "../../lib/device-store.mjs";
import { kitInput } from "../../lib/store-kits.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { installSettingsInput, planRulesInput } from "../../lib/store-kit-orders.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// The Home kit in the portal's Shop, end to end at 390 px (canvas:
// PhoneStarterKit #373, PhoneInstallBooking #374, PhoneInstalments #375; owner
// decisions 27 Nov): first in Shop, the kit page's choices and totals, the
// installation's day, slot and place, Pay in 3's schedule, the kit's Checkout
// with its parts, Installation booked, moving and cancelling the visit, then
// the plan's next payment and the rest on the deposit's number, fully paid
// with the code, and the Activity row opening the running plan. French too.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const text = (v) => ({ en: v, fr: v });

test("the Home kit: installation and Pay in 3 from the Shop to fully paid, as drawn", { timeout: 300000 }, async (t) => {
  const secret = "redesign-phone-kits", store = createStore({ persistent: false });
  let providerStatus = "pending";
  const requests = [];
  const adapter = {
    configured: () => true,
    createPayment: async (p) => { requests.push({ id: p.id, network: p.network, payerPhone: p.payerPhone, amount: p.amount }); return { status: "pending", providerReference: `ref-${p.id}` }; },
    verifyPayment: async (p) => ({ status: providerStatus, amount: p.amount, currency: "XAF", providerReference: p.providerReference, transactionReference: p.id }),
    handleWebhook: async (raw) => JSON.parse(raw),
    refundPayment: async (p) => ({ status: "completed", providerReference: "refund-" + p.id }),
    verifyRefund: async () => ({ status: "completed" }),
  };
  await store.transaction((s) => {
    storeState(s);
    seedCatalogue(s, new Date());
    s.storeSettings = { ...s.storeSettings, open: true, pickup: "NDAHI office, Akwa", contact: "670000000", warranty: text("12-month warranty"), returns: text("7 days") };
    s.storeProducts.push({ id: "ax1500", version: 1, sku: "AX1500", name: text("TP-Link AX1500 router"), description: text("Wi-Fi 6"), specifications: text(""), compatibility: text(""), contents: text(""),
      warranty: text("12-month warranty"), setup: text(""), images: [], price: 45000, cost: 1, stock: 5, status: "published", featured: false, categoryId: "" });
    s.storeKits.push({ id: "kit-home", status: "on_sale", version: 1, ...kitInput(s, { name: { en: "Home kit", fr: "Kit maison" }, items: [{ productId: "ax1500", quantity: 1 }],
      firstBundleId: "home-wisp-30d", price: 70000, setUp: true, installation: true, payIn3: true }) });
    s.storeSettings.installations = installSettingsInput({ price: 15000, areas: [{ id: "bonamoussadi", name: "Bonamoussadi", town: "Douala", travelFee: 2000 }, { id: "akwa", name: "Akwa", town: "Douala", travelFee: 1500 }],
      capacity: { morning: 2, afternoon: 2 }, technicians: [{ id: "eric", name: "Eric" }] }, null);
    s.storeSettings.payPlans = planRulesInput({ depositPct: 40, days: 30, grace: 7, minPrice: 50000 }, null);
    s.customers.push({ id: "amina", name: "Amina Ndi", phone: "670001245", email: "amina@example.test" });
    s.dashboardSessions.push({ id: "sess", customerId: "amina", tokenHash: hashSecret("amina", secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const portalServer = await listen(createStaticServer("customer", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const portal = `http://127.0.0.1:${portalServer.address().port}`;
  const apiServer = createServer({ store, validateConfig: false, payments: { mesomb: adapter }, env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    CUSTOMER_APP_URL: portal, PAYMENT_MODE: "mesomb", PAYMENT_FEE_MTN: "percent=2,on=price,round=nearest", PAYMENT_FEE_ORANGE: "percent=2,on=price,round=nearest", EMAIL_MODE: "mock",
    MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BOOTSTRAP_MODE: "false", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(portalServer); });
  const screenshots = process.env.PHONE_KITS_SCREENSHOTS || "/tmp/ndahi-phone-kits";
  await mkdir(screenshots, { recursive: true });

  const open = async (hash, lang = "en") => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: lang === "fr" ? "fr-FR" : "en-GB", timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, portal].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "customer_session", value: "amina", url: `${api}/api/account`, httpOnly: true, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      try { localStorage.setItem("ndahi-language", "fr"); } catch {}
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    await page.goto(`${portal}/dashboard#${hash}`);
    await page.evaluate(() => document.fonts.ready);
    return { context, page, errors };
  };
  const check = async (page, label) => {
    await page.evaluate(() => { document.activeElement?.blur(); });
    assert.deepEqual(await lowContrastText(page), [], `contrast: ${label}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no sideways scroll: ${label}`);
    await page.screenshot({ path: `${screenshots}/${label}.png`, fullPage: true });
  };
  const texts = (page, selector) => page.locator(selector).evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));
  const kitOrder = async () => (await store.snapshot()).storeOrders.find((o) => o.kitId === "kit-home" && o.kind !== "plan_payment");

  const { context, page, errors } = await open("shop");
  // First in Shop, in the products' row style (owner, 27 Nov).
  const first = page.locator(".portal-shop__item").first();
  await first.waitFor();
  assert.equal(await first.getAttribute("href"), "/dashboard#kit/kit-home");
  assert.match((await first.innerText()).replace(/\s+/g, " "), /^Starter kit Home kit 70,000 FCFA 5 in stock/i);
  await first.click();

  // The kit: what's in it, Setup and How to pay, today's total.
  await page.locator(".portal-kit__inc").first().waitFor();
  assert.equal(await page.locator(".portal-kit__hero .portal-kit__eyebrow").textContent(), "Starter kit · plug in and go");
  assert.equal(await page.locator(".portal-kit__title").textContent(), "Home kit");
  assert.deepEqual(await texts(page, ".portal-kit__inc"), ["TP-Link AX1500 router Linked to your account · just plug it in",
    "First month: Home WISP Unlimited 30 days · unlimited data · shared through a supported router", "12-month warranty Registered to you automatically"]);
  assert.deepEqual(await texts(page, ".portal-kit__opt"), ["I’ll plug it in myself Ready to collect in 24 h · 2-minute setup Included", "Install it at my place A technician comes on a day you choose + 15,000 FCFA",
    "Pay in full One payment", "Pay in 3 40% today, rest in 30 days"]);
  assert.deepEqual(await texts(page, ".portal-kit__foot"), ["Kit price 70,000 FCFA You save 25,000 FCFA vs buying separately Buy the kit"]);
  await check(page, "kit");
  await page.getByRole("button", { name: /^Install it at my place/ }).click();
  await page.locator('[data-kit-setup="install"][aria-pressed="true"]').waitFor();
  assert.equal(await page.locator(".portal-kit__total").innerText(), "Kit price\n70,000 + 15,000 FCFA");
  await page.getByRole("button", { name: /^Pay in 3/ }).click();
  await page.locator('[data-kit-pay="plan"][aria-pressed="true"]').waitFor();
  assert.equal((await page.locator(".portal-kit__total").innerText()).replace(/\s+/g, " "), "Today (deposit) 28,000 + 15,000 FCFA");
  await page.getByRole("link", { name: "Continue to pick an install date" }).click();

  // When: Monday to Saturday from tomorrow; a later day's afternoon.
  await page.locator(".portal-kit__day").first().waitFor();
  assert.equal(await page.locator(".portal-kit__step").textContent(), "Step 1 of 2");
  assert.equal(await page.locator(".portal-kit__day").count(), 8);
  await page.locator(".portal-kit__day").nth(2).click();
  await page.getByRole("button", { name: /^Afternoon · 13:00 – 17:00/ }).click();
  assert.match(await page.locator("[data-book-next]").textContent(), /^Continue · \w{3} \d+ \w{3} · afternoon$/);
  await check(page, "when");
  await page.locator("[data-book-next]").click();

  // Where: the area's travel fee, directions, the phone the technician calls.
  await page.locator("#kitDirections").waitFor();
  assert.equal(await page.locator(".portal-kit__step").textContent(), "Step 2 of 2");
  await page.locator("#kitArea").selectOption("akwa");
  assert.equal(await page.locator("#kitTravel").textContent(), "Travel fee for this area: 1,500 FCFA");
  await page.getByRole("button", { name: "Book and pay with the kit" }).click();
  assert.equal(await page.locator("#kitMessage").textContent(), "Add directions from a landmark so the technician finds you.");
  await page.locator("#kitDirections").fill("Behind the Total station, blue gate");
  assert.deepEqual((await texts(page, ".portal-kit__row")).map((r) => r.replace(/^When \S+ \d+ \S+ · /, "When ")), ["When afternoon", "Installation 15,000 FCFA", "Travel 1,500 FCFA"]);
  await check(page, "where");
  await page.getByRole("button", { name: "Book and pay with the kit" }).click();

  // Pay in 3: the schedule from the server, then the deposit with the visit.
  await page.locator(".portal-kit__sch li").first().waitFor();
  assert.equal(await page.locator(".portal-kit__h1").textContent(), "Pay in 3 for the Home kit");
  const schedule = await texts(page, ".portal-kit__sch li");
  assert.equal(schedule[0], "1 Today · deposit (40%) 28,000 FCFA");
  assert.match(schedule[1], /^2 By \w{3} \d+ \w{3} 21,000 FCFA$/);
  assert.match(schedule[2], /^3 By \w{3} \d+ \w{3} 21,000 FCFA$/);
  assert.equal(await page.locator(".portal-kit__fee").textContent(), "Each payment adds its own Mobile Money fee (about 560 FCFA each). You can pay early or pay it all at once any time.");
  assert.equal((await page.locator(".portal-kit__foot .portal-kit__btn").innerText()).replace(/\s+/g, " "), "Pay deposit and installation 44,500 FCFA + 890 FCFA Mobile Money fee");
  await check(page, "plan-choose");
  await page.locator(".portal-kit__foot .portal-kit__btn").click();

  // The kit's Checkout: the parts, the fee and the total.
  await page.locator("#shopCheckout").waitFor();
  assert.deepEqual(await texts(page, "#shopCost .portal-shop__cost-row"), ["Deposit (40%) 28,000 FCFA", "Installation 15,000 FCFA", "Travel 1,500 FCFA", "Mobile Payment Fee (2%) 890 FCFA"]);
  assert.equal(await page.evaluate(() => document.body.dataset.portalSub), "checkout", "the drawn Checkout's layout");
  await check(page, "kit-checkout");
  await page.getByRole("button", { name: "Pay Now" }).click();
  await page.locator("[data-shop-check]").waitFor();
  providerStatus = "paid";
  await page.locator("[data-shop-check]").click();

  // Installation booked.
  await page.locator(".portal-kit__card").waitFor();
  let o = await kitOrder();
  assert.deepEqual([o.payment.amount, o.installation.areaId, o.installation.slot, o.plan.status], [44500, "akwa", "afternoon", "running"]);
  assert.equal(await page.locator(".portal-kit__card .portal-kit__eyebrow").textContent(), `Booking ${o.installation.reference}`);
  assert.equal(await page.locator(".portal-kit__card-line").textContent(), "Akwa · the technician calls 30 minutes before arriving");
  await check(page, "booked");
  // Move or cancel reuses "When" (owner, 27 Nov): move to a later day (more than
  // 24 h away, so it can still change), then cancel.
  await page.getByRole("link", { name: "Move or cancel" }).click();
  await page.locator(".portal-kit__day").first().waitFor();
  const before = o.installation.day;
  const target = await page.locator(".portal-kit__day:not([disabled])").evaluateAll((els, day) => els.map((el) => el.dataset.bookDay).filter((d) => d !== day).at(-1), before);
  await page.locator(`[data-book-day="${target}"]`).click();
  assert.match(await page.locator("[data-book-next]").textContent(), /^Move to \w{3} \d+ \w{3} · morning$/);
  await page.locator("[data-book-next]").click();
  await page.locator(".portal-kit__card").waitFor();
  o = await kitOrder();
  assert.deepEqual([o.installation.day, o.installation.status], [target, "moved"]);
  await page.getByRole("link", { name: "Move or cancel" }).click();
  page.once("dialog", (dialog) => { assert.equal(dialog.message(), "Cancel the installation? The installation and travel (16,500 FCFA) are refunded."); void dialog.accept(); });
  await page.getByRole("button", { name: "Cancel the installation" }).click();
  await page.waitForFunction(() => location.hash.startsWith("#order/"));
  o = await kitOrder();
  assert.equal(o.installation.status, "cancelled");

  // Activity opens the running plan (owner, 27 Nov).
  // A fresh load: Activity reads the orders when the dashboard opens.
  await page.goto(`${portal}/dashboard#activity`);
  await page.reload();
  const row = page.locator(`[data-order-row="${o.id}"]`);
  await row.waitFor();
  assert.equal(await row.getAttribute("href"), `/dashboard#plan/${o.id}`);
  await row.click();

  // The running plan: what's paid, the next payment on the deposit's number.
  await page.locator(".portal-kit__progress").waitFor();
  assert.equal(await page.locator(".portal-kit__paid").textContent(), "28,000 FCFA");
  assert.equal(await page.locator(".portal-kit__of").textContent(), "of 70,000 FCFA paid");
  const rows = await texts(page, ".portal-kit__sch li");
  assert.match(rows[0], /^✓ Deposit · paid \d+ \w{3} 28,000$/);
  assert.match(rows[1], /^2 Due \w{3} \d+ \w{3} · in \d+ days 21,000$/);
  assert.equal((await page.locator('[data-plan-pay="next"]').innerText()).replace(/\s+/g, " "), "Pay next 21,000 FCFA now + 420 FCFA Mobile Money fee");
  await check(page, "plan-active");
  providerStatus = "pending";
  await page.locator('[data-plan-pay="next"]').click();
  await page.locator("[data-shop-check]").waitFor();
  providerStatus = "paid";
  await page.locator("[data-shop-check]").click();
  await page.locator(".portal-kit__progress").waitFor();
  assert.equal(await page.locator(".portal-kit__paid").textContent(), "49,000 FCFA");
  assert.match((await texts(page, ".portal-kit__sch li"))[1], /^✓ Paid today 21,000$/);
  assert.equal((await page.locator('[data-plan-pay="next"]').innerText()).replace(/\s+/g, " "), "Pay the last 21,000 FCFA + 420 FCFA Mobile Money fee");
  providerStatus = "pending";
  await page.getByRole("button", { name: "Pay everything left now" }).click();
  await page.locator("[data-shop-check]").waitFor();
  providerStatus = "paid";
  await page.locator("[data-shop-check]").click();

  // Fully paid: the code.
  await page.locator(".portal-kit__code").waitFor();
  assert.equal(await page.locator(".portal-kit__h1").textContent(), "Fully paid — it's yours");
  assert.equal(await page.locator(".portal-kit__center-text").textContent(), "Your Home kit is being set up for your account. Collect it at NDAHI office, Akwa with this code from tomorrow.");
  assert.match(await page.locator(".portal-kit__code").textContent(), /^\d{3} \d{3}$/);
  await check(page, "plan-paid");
  // Every payment went to the deposit's number and network.
  assert.deepEqual(requests.map((r) => [r.payerPhone, r.network]), Array(3).fill([requests[0].payerPhone, "mtn"]));
  assert.equal((await kitOrder()).plan.status, "completed");
  assert.deepEqual(errors, []);
  await context.close();

  // French.
  {
    const { context, page, errors } = await open("kit/kit-home", "fr");
    await page.locator(".portal-kit__inc").first().waitFor();
    assert.equal(await page.locator(".portal-kit__title").textContent(), "Kit maison");
    assert.equal(await page.locator(".portal-kit__hero .portal-kit__eyebrow").textContent(), "Kit de démarrage · branchez et c'est parti");
    await check(page, "kit-fr");
    assert.deepEqual(errors, []);
    await context.close();
  }
});
