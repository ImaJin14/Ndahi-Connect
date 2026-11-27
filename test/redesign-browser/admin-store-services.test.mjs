import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../../server.mjs";
import { createStaticServer } from "../../static-server.mjs";
import { hashSecret } from "../../lib/security.mjs";
import { storeState, reserveOrder, settleOrder } from "../../lib/device-store.mjs";
import { kitInput } from "../../lib/store-kits.mjs";
import { seedCatalogue } from "../../lib/catalogue.mjs";
import { installSettingsInput, planRulesInput, kitQuote, newPlanPayment, cancelPlan, sweepPlans } from "../../lib/store-kit-orders.mjs";
import { lowContrastText } from "../../scripts/ui-checks.mjs";

// Kits & installs (AdminStoreServices, #347; owner decisions 27 Nov): the Kits
// tab (list, Edit kit, Bought separately, status buttons), the Installations
// tab (day pills, jobs, technician, On the way on the visit day, Done… with
// the signal, Couldn't install, the report, Installation settings) and the
// Payment plans tab (figures, remind, give more days once, cancel and refund,
// rules for the owner). The server's clock is a Thursday, as drawn.

const listen = (server) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve(server)); });
const close = (server) => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
const reservePort = async () => { const server = await listen(http.createServer()); const port = server.address().port; await close(server); return port; };
const DAY = 864e5, NOW = new Date("2026-11-19T09:00:00Z"), text = (v) => ({ en: v, fr: v });

function seed(s) {
  storeState(s);
  seedCatalogue(s, NOW);
  Object.assign(s.storeSettings, { open: true, pickup: "Akwa office", contact: "670000001", hours: "9–17", warranty: text("12 months"), returns: text("7 days") });
  const product = (id, sku, name, price, stock) => ({ id, version: 1, sku, name: text(name), description: text(name), specifications: text(""), compatibility: text(""), contents: text(""),
    warranty: text("12 months"), setup: text(""), images: [], price, cost: 1, stock, status: "published", featured: false, categoryId: "", createdAt: NOW.toISOString() });
  s.storeProducts.push(product("ax1500", "AX1500", "TP-Link AX1500", 45000, 30), product("cpe210", "CPE210", "TP-Link CPE210", 38000, 6));
  const personal = s.bundles.find((b) => b.accessType === "personal_unlimited" && b.status === "published");
  s.storeKits.push({ id: "kit-home", status: "on_sale", version: 1, createdAt: NOW.toISOString(), ...kitInput(s, { name: text("Home kit"), items: [{ productId: "ax1500", quantity: 1 }],
    firstBundleId: "home-wisp-30d", price: 70000, setUp: true, installation: true, payIn3: true }) });
  s.storeKits.push({ id: "kit-outdoor", status: "draft", version: 1, createdAt: NOW.toISOString(), ...kitInput(s, { name: text("Outdoor link kit"), items: [{ productId: "cpe210", quantity: 1 }],
    firstBundleId: personal.id, price: 60000, installation: true }) });
  s.storeSettings.installations = installSettingsInput({ price: 15000, areas: [{ id: "bonamoussadi", name: "Bonamoussadi", town: "Douala", travelFee: 2000 }],
    capacity: { morning: 2, afternoon: 2 }, technicians: [{ id: "eric", name: "Eric" }, { id: "brenda", name: "Brenda" }] }, null);
  s.storeSettings.payPlans = planRulesInput({ depositPct: 40, days: 30, grace: 7, minPrice: 50000 }, null);
  const kit = s.storeKits[0];
  let n = 0;
  const buy = (name, phone, at, { install, pay = "full" } = {}) => {
    const id = "cust-" + (++n);
    s.customers.push({ id, name, phone, createdAt: NOW.toISOString() });
    const q = kitQuote(s, kit, { setup: install ? "install" : "self", areaId: install?.areaId, pay }, at);
    const { order } = reserveOrder(s, { kitId: kit.id, expectedPrice: kit.price, expectedAmount: q.today, setup: install ? "install" : "self", pay, ...(install ? { installation: install } : {}),
      name, phone, payerPhone: phone, network: "mtn", checkoutKey: randomUUID() }, { now: at, secret: "seed", customerId: id, provider: "mock" });
    settleOrder(s, order, { status: "paid", transactionReference: order.payment.id, providerReference: "ref-" + order.id, amount: order.payment.amount, currency: "XAF" }, at);
    return order;
  };
  const job = (i, name, phone, day, slot, directions, extra = {}) =>
    Object.assign(buy(name, phone, new Date(+NOW - 2 * DAY + i * 60000), { install: { day, slot, areaId: "bonamoussadi", directions, phone } }).installation, extra);
  job(0, "Amina Ndi", "670121245", "2026-11-19", "morning", "Behind the Total station, blue gate", { status: "on_the_way", technicianId: "eric" });
  job(1, "Paul Tchami", "690558802", "2026-11-19", "morning", "Opposite the primary school", { technicianId: "brenda" });
  job(2, "Grace Tabi", "655110366", "2026-11-19", "afternoon", "Near the market, yellow shop", { status: "moved" });
  job(3, "Eric Mbah", "677001122", "2026-11-20", "morning", "By the pharmacy");
  // Plans: on track, late on its last payment, paid, cancelled.
  buy("Amina Nfor", "670331245", new Date(+NOW - DAY), { pay: "plan" });
  const late = buy("K. Nji", "677440011", new Date(+NOW - 32 * DAY), { pay: "plan" });
  const second = newPlanPayment(s, late, { which: "next", expectedAmount: late.plan.payments[1].amount, checkoutKey: randomUUID() }, { now: new Date(+NOW - 20 * DAY), secret: "seed", provider: "mock" }).order;
  settleOrder(s, second, { status: "paid", transactionReference: second.payment.id, providerReference: "r-" + second.id, amount: second.payment.amount, currency: "XAF" }, new Date(+NOW - 20 * DAY));
  const paid = buy("J. Fon", "699220033", new Date(+NOW - 10 * DAY), { pay: "plan" });
  const rest = newPlanPayment(s, paid, { which: "rest", expectedAmount: paid.plan.payments[1].amount + paid.plan.payments[2].amount, checkoutKey: randomUUID() }, { now: new Date(+NOW - 2 * DAY), secret: "seed", provider: "mock" }).order;
  settleOrder(s, rest, { status: "paid", transactionReference: rest.payment.id, providerReference: "r-" + rest.id, amount: rest.payment.amount, currency: "XAF" }, new Date(+NOW - 2 * DAY));
  cancelPlan(s, buy("M. Ekane", "650990044", new Date(+NOW - 12 * DAY), { pay: "plan" }), new Date(+NOW - 3 * DAY), "admin", "owner");
  sweepPlans(s, NOW);
}

test("Kits & installs: kits, installation jobs and payment plans, as drawn", { timeout: 300000 }, async (t) => {
  const secret = "redesign-services", store = createStore({ persistent: false });
  await store.transaction((s) => {
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: `u-${role}`, username: role, displayName: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `u-${role}`, role, tokenHash: hashSecret(`${role}-token`, secret), csrfToken: "csrf", expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    seed(s);
  });
  const apiPort = await reservePort(), api = `http://127.0.0.1:${apiPort}`;
  const adminServer = await listen(createStaticServer("admin", { apiUrl: api, env: { NODE_ENV: "test" } }));
  const admin = `http://127.0.0.1:${adminServer.address().port}`;
  const apiServer = createServer({ store, now: () => NOW, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
    ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "standalone",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => apiServer.listen(apiPort, "127.0.0.1", resolve));
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  t.after(async () => { await browser.close(); await close(apiServer); await close(adminServer); });
  const screenshots = process.env.POLISH_SCREENSHOTS || "/tmp/ndahi-admin-services";
  await mkdir(screenshots, { recursive: true });
  const open = async (role, width, lang = "en") => {
    const context = await browser.newContext({ viewport: { width, height: width < 768 ? 844 : 1200 }, timezoneId: "Africa/Douala" });
    await context.route("**/*", (route) => [api, admin].includes(new URL(route.request().url()).origin) ? route.continue() : route.abort("blockedbyclient"));
    await context.addCookies([{ name: "admin_session", value: `${role}-token`, url: `${api}/api/admin`, httpOnly: true, sameSite: "Lax" }, { name: "ndahi_ui", value: "v2", url: admin, sameSite: "Lax" }]);
    if (lang === "fr") await context.addInitScript(() => {
      try { localStorage.setItem("ndahi-language", "fr"); } catch {}
      const set = () => { if (document.documentElement && document.documentElement.lang !== "fr") document.documentElement.lang = "fr"; };
      new MutationObserver(set).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ["lang"] }); set();
    });
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error" && !/ERR_BLOCKED_BY_CLIENT/.test(message.text())) errors.push(message.text()); });
    return { context, page, errors };
  };
  const state = () => store.snapshot();
  const texts = (page, selector) => page.locator(selector).evaluateAll((els) => els.map((el) => el.innerText.replace(/\s+/g, " ").trim()));

  // ---------- Owner, 1280 ----------
  {
    const { context, page, errors } = await open("owner", 1280);
    await page.goto(`${admin}/dashboard#home`);
    // The side menu counts today's jobs still to do, as drawn.
    const item = page.locator('[data-admin-nav="services"]');
    await item.locator(".nd-badge").waitFor();
    assert.equal(await item.innerText(), "Kits & installs\n3");
    await item.click();
    await page.getByRole("heading", { name: "Kits, installations and payment plans.", exact: true }).waitFor();
    assert.equal(await page.locator("#adminEyebrow").textContent(), "Store");
    assert.deepEqual(await texts(page, ".admin-kits__tab"), ["Kits", "Installations 3", "Payment plans 1"]);
    assert.equal(await page.locator('.admin-kits__tab[aria-selected="true"]').textContent(), "Kits");

    // Kits: on sale first, the summary as drawn, the chosen kit's form.
    await page.locator(".admin-kits__kit").first().waitFor();
    const seeded = await state(), personal = seeded.bundles.find((b) => b.id === seeded.storeKits[1].firstBundleId);
    const kitCards = await texts(page, ".admin-kits__kit");
    assert.match(kitCards[0], /^Home kit On sale AX1500 \+ Home WISP Unlimited first month · 70,000 FCFA · \d+ sold this month$/);
    assert.equal(kitCards[1], "Outdoor link kit Draft CPE210 + " + (personal.name.en || personal.name));
    assert.equal(await page.locator("#kitEditTitle").textContent(), "Edit Home kit");
    assert.equal(await page.locator("#kitSaving").textContent(), "Bought separately: 95,000 FCFA · saving shown: 25,000 FCFA");
    await page.locator("#kitPrice").fill("100000");
    assert.equal(await page.locator("#kitSaving").textContent(), "Bought separately: 95,000 FCFA · no saving shown");
    await page.locator("#kitPrice").fill("72000");
    await page.getByRole("button", { name: "Save kit", exact: true }).click();
    await page.getByText("Kit saved.", { exact: true }).waitFor();
    assert.equal((await state()).storeKits.find((k) => k.id === "kit-home").price, 72000);
    await page.screenshot({ path: `${screenshots}/kits-1280.png`, fullPage: true });
    // A draft goes on sale from its form (owner, 27 Nov).
    await page.locator('[data-kit="kit-outdoor"]').click();
    await page.getByRole("button", { name: "Put on sale", exact: true }).click();
    await page.getByText("Outdoor link kit is on sale.", { exact: true }).waitFor();
    assert.equal((await state()).storeKits.find((k) => k.id === "kit-outdoor").status, "on_sale");
    // A new kit: one name for both languages, saved as a draft.
    await page.getByRole("button", { name: "New kit", exact: true }).click();
    assert.equal(await page.locator("#kitEditTitle").textContent(), "New kit");
    await page.locator("#kitName").fill("Starter pack");
    await page.locator("#kitPrice").fill("80000");
    await page.getByRole("button", { name: "Save kit", exact: true }).click();
    await page.getByText("Kit saved.", { exact: true }).waitFor();
    const made = (await state()).storeKits.find((k) => k.name.en === "Starter pack");
    assert.deepEqual([made.name.fr, made.status, made.items[0].productId, made.firstBundleId], ["Starter pack", "draft", "ax1500", "home-wisp-30d"]);
    assert.equal(await page.locator("#kitEditTitle").textContent(), "Edit Starter pack");

    // Installations: today and the next working days, then today's jobs.
    await page.getByRole("tab", { name: "Installations 3" }).click();
    assert.equal(new URL(page.url()).hash, "#services/installs");
    assert.deepEqual(await texts(page, ".admin-kits__day"), ["Today, Thu 19 · 3 jobs", "Fri 20 · 1 job", "Sat 21 · 0 jobs", "Mon 23 · 0 jobs", "Tue 24 · 0 jobs"]);
    assert.equal(await page.locator("#jobsTitle").textContent(), "Jobs · Today, Thu 19");
    assert.equal(await page.locator(".admin-kits__cap").textContent(), "Capacity: 2 morning · 2 afternoon · 2 technicians");
    const rows = () => texts(page, "section[aria-labelledby=jobsTitle] tbody tr");
    assert.deepEqual((await rows()).map((r) => r.replace(/ ((Eric|Brenda|Choose) )+/, " ")), [
      "Morning Amina N. 6•• •• 12 45 Bonamoussadi Behind the Total station, blue gate Home kit · AX1500 On the way Done…",
      "Morning Paul T. 6•• •• 88 02 Bonamoussadi Opposite the primary school Home kit · AX1500 Booked On the way",
      "Afternoon Grace T. 6•• •• 03 66 Bonamoussadi Near the market, yellow shop Home kit · AX1500 Moved by customer On the way"]);
    assert.equal(await page.locator("section[aria-labelledby=jobsTitle] tbody tr").first().locator("a").getAttribute("href"), `/dashboard#customer/cust-1`);
    // A technician, then On the way (the visit day), then Done… → Mark installed.
    await page.getByRole("combobox", { name: "Technician for Grace T." }).selectOption("brenda");
    await page.waitForFunction(() => !document.querySelector("[data-job-tech]:disabled") && document.querySelector('[aria-label="Technician for Grace T."]')?.value === "brenda");
    await page.waitForTimeout(300);
    assert.equal((await state()).storeOrders.find((o) => o.contact.name === "Grace Tabi").installation.technicianId, "brenda");
    const paul = page.locator("section[aria-labelledby=jobsTitle] tbody tr", { hasText: "Paul T." });
    await paul.getByRole("button", { name: "On the way" }).click();
    await paul.getByText("On the way", { exact: true }).first().waitFor();
    await paul.getByRole("button", { name: "Done…" }).click();
    await page.locator("#jobSignal").fill("−58 dBm · 42 Mbps");
    await page.screenshot({ path: `${screenshots}/installs-1280.png`, fullPage: true });
    await page.getByRole("button", { name: "Mark installed", exact: true }).click();
    await page.getByText("Installed. The kit is handed over and its first bundle is in the customer's account.", { exact: true }).waitFor();
    await paul.getByRole("button", { name: "View report" }).waitFor();
    assert.match(await page.locator("#jobReport").textContent(), /^Installed .+ by Brenda · signal −58 dBm · 42 Mbps$/);
    const handed = (await state()).storeOrders.find((o) => o.contact.name === "Paul Tchami");
    assert.deepEqual([handed.status, handed.installation.status], ["collected", "installed"]);
    // Couldn't install asks why and refunds the installation and travel.
    const grace = page.locator("section[aria-labelledby=jobsTitle] tbody tr", { hasText: "Grace T." });
    await grace.getByRole("button", { name: "On the way" }).click();
    await grace.getByRole("button", { name: "Done…" }).click();
    page.once("dialog", (dialog) => { assert.match(dialog.message(), /refunded/); void dialog.accept("Signal too weak"); });
    await page.getByRole("button", { name: "Couldn't install", exact: true }).click();
    await grace.getByText("Couldn't install", { exact: true }).waitFor();
    assert.match(await page.locator("#jobReport").textContent(), /: Signal too weak\. The installation and travel \(17,000 FCFA\) are refunded\.$/);
    const refused = (await state()).storeOrders.find((o) => o.contact.name === "Grace Tabi");
    assert.equal(refused.installation.status, "not_installed");
    assert.equal(refused.payment.refunds?.[0]?.amount ?? refused.payment.refund?.amount, 17000);
    // Installation settings (owner, 27 Nov): add an area and save.
    await page.getByRole("button", { name: "Add an area", exact: true }).click();
    await page.locator("#areaName1").fill("Akwa");
    await page.locator("#areaTown1").fill("Douala");
    await page.locator("#areaFee1").fill("1500");
    await page.getByRole("button", { name: "Save settings", exact: true }).click();
    await page.getByText("Installation settings saved.", { exact: true }).waitFor();
    assert.deepEqual((await state()).storeSettings.installations.areas.map((a) => [a.name, a.travelFee]), [["Bonamoussadi", 2000], ["Akwa", 1500]]);

    // Payment plans: the figures, then each plan as drawn.
    await page.getByRole("tab", { name: /^Payment plans/ }).click();
    await page.locator(".admin-kits__metric").first().waitFor();
    assert.deepEqual(await texts(page, ".admin-kits__metric"), ["2 plans running", "63,000 FCFA still to be paid", "1 late payments", "50% of plans completed"]);
    const planRows = await texts(page, "section[aria-labelledby=plansTitle] tbody tr");
    assert.equal(planRows.length, 4);
    assert.match(planRows[0], /^Amina N\. Home kit 40% \w{3} \d+ Dec On track Send reminder$/);
    assert.match(planRows[1], /^K\. Nji Home kit 70% \w{3} \d+ Nov 2 days late Give 7 more days Cancel and refund$/);
    assert.equal(planRows[2], "J. Fon Home kit 100% — Paid · to collect");
    assert.equal(planRows[3], "M. Ekane Home kit 40% — Cancelled · refunded");
    await page.screenshot({ path: `${screenshots}/plans-1280.png`, fullPage: true });
    await page.getByRole("button", { name: "Send reminder", exact: true }).click();
    await page.getByText("Reminder sent to Amina N.", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Give 7 more days", exact: true }).click();
    const extended = page.getByRole("button", { name: /^Extended to \d+ \w{3}$/ });
    await extended.waitFor();
    assert.equal(await extended.isDisabled(), true, "once only");
    page.once("dialog", (dialog) => { assert.match(dialog.message(), /^Cancel K\. Nji's plan and refund 49,000 FCFA\? The kit goes back on sale\.$/); void dialog.accept(); });
    await page.getByRole("button", { name: "Cancel and refund", exact: true }).click();
    await page.getByText("K. Nji's plan is cancelled; 49,000 FCFA is being refunded.", { exact: true }).waitFor();
    assert.equal((await state()).storeOrders.find((o) => o.contact.name === "K. Nji" && o.plan).plan.status, "cancelled");
    // The rules save as they change (owner).
    await page.locator("#ruleDeposit").selectOption("50");
    await page.getByText("Plan rules saved.", { exact: true }).waitFor();
    assert.equal((await state()).storeSettings.payPlans.depositPct, 50);
    assert.deepEqual(await lowContrastText(page), [], "contrast");
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---------- Operator: no rules, no refunds ----------
  {
    const { context, page, errors } = await open("operator", 1280);
    await page.goto(`${admin}/dashboard#services/plans`);
    await page.locator(".admin-kits__metric").first().waitFor();
    assert.equal(await page.locator("#ruleDeposit").isDisabled(), true);
    assert.equal(await page.locator("[data-plan-cancel]").count(), 0);
    await page.getByText("Only the owner changes the plan rules.", { exact: false }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
  }
  // ---------- Phone width and French ----------
  {
    const { context, page, errors } = await open("owner", 390);
    for (const tab of ["", "/installs", "/plans"]) {
      await page.goto(`${admin}/dashboard#services${tab}`);
      await page.locator(tab === "/installs" ? ".admin-kits__day" : tab ? ".admin-kits__metric" : ".admin-kits__kit").first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `overflow ${tab || "kits"}`);
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  {
    const { context, page, errors } = await open("owner", 1280, "fr");
    await page.goto(`${admin}/dashboard#services`);
    await page.getByRole("heading", { name: "Kits, installations et paiements échelonnés.", exact: true }).waitFor();
    await page.locator(".admin-kits__kit").first().waitFor();
    assert.deepEqual((await texts(page, ".admin-kits__tab")).map((x) => x.replace(/ \d+$/, "")), ["Kits", "Installations", "Paiements en 3 fois"]);
    assert.equal(await page.locator("#kitsListTitle").textContent(), "Kits en vente");
    await page.screenshot({ path: `${screenshots}/kits-fr.png`, fullPage: true });
    assert.deepEqual(errors, []);
    await context.close();
  }
});
