import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";

// Isolated fixtures with delayed responses; no .env, database or live providers.
const apiPort = Number(process.env.PENDING_API_PORT || 8498), portalPort = Number(process.env.PENDING_PORT || 8497),
  adminPort = Number(process.env.PENDING_ADMIN_PORT || 8499), api = `http://127.0.0.1:${apiPort}`,
  portal = `http://127.0.0.1:${portalPort}`, admin = `http://127.0.0.1:${adminPort}`;
const origins = new Set([api, portal, admin]);
const server = createServer({ store: createStore({ persistent: false }), env: {
  NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false",
  SESSION_COOKIE_SECURE: "false", CUSTOMER_APP_URL: portal, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin, ADMIN_PIN: "9999",
} });
const customerSite = createStaticServer("customer", { apiUrl: api }), adminSite = createStaticServer("admin", { apiUrl: api });
const listen = (app, port) => new Promise((resolve, reject) => { app.once("error", reject); app.listen(port, "127.0.0.1", resolve); });
const close = (app) => new Promise((resolve) => { app.close(resolve); app.closeAllConnections(); });
let browser, checks = 0;
const screenshots = process.env.PENDING_SCREENSHOTS || "/tmp/ndahi-pending-checks";

// Keep a request open until the test has inspected the pending UI and tried a
// second submission. Count requests to catch races even if their UI looks fine.
async function hold(page, path, body, status = 400) {
  let release, count = 0;
  const gate = new Promise((resolve) => { release = resolve; }),
    started = page.waitForRequest((request) => new URL(request.url()).pathname === path, { timeout: 10000 });
  await page.route(`**${path}`, async (route) => {
    count++;
    await gate;
    await route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
  });
  return { release, started, count: () => count };
}
const submitTwice = (page, selector) => page.evaluate((selector) => {
  const form = document.querySelector(selector);
  form.requestSubmit();
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}, selector);
const idle = (page, selector) => page.waitForFunction((selector) => {
  const control = document.querySelector(selector);
  return control && !control.disabled && control.getAttribute("aria-busy") !== "true";
}, selector);

try {
  await listen(server, apiPort); await listen(customerSite, portalPort); await listen(adminSite, adminPort);
  const login = await fetch(`${api}/api/admin/login`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: "9999" }),
  });
  assert.equal(login.status, 200);
  const adminCookie = login.headers.get("set-cookie").split(";")[0];
  const post = async (path, input) => {
    const response = await fetch(api + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.ok(response.ok);
    return { response, body: await response.json() };
  };
  const purchase = await post("/api/purchase", { name: "Fixture customer", phone: "670080002", email: "fixture@example.test", planId: "weekly" });
  const paid = await post(`/api/payments/${purchase.body.payment.id}/confirm`, {});
  const customerLogin = await post("/api/account/setup/pin", { phone: "670080002", code: paid.body.access.code, pin: "2468", confirmPin: "2468" });
  const customerCookie = customerLogin.response.headers.get("set-cookie").split(";")[0];
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  await mkdir(screenshots, { recursive: true });
  async function scenario(name, work, { authenticated = false, customer = false, width = 1440 } = {}) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      return ["http:", "https:"].includes(url.protocol) && !origins.has(url.origin) ? route.abort("blockedbyclient") : route.continue();
    });
    if (authenticated) await context.addCookies([{ name: "admin_session", value: adminCookie.split("=")[1], domain: "127.0.0.1", path: "/api/admin", httpOnly: true, sameSite: "Lax" }]);
    if (customer) await context.addCookies([{ name: "customer_session", value: customerCookie.split("=")[1], domain: "127.0.0.1", path: "/api/account", httpOnly: true, sameSite: "Lax" }]);
    const page = await context.newPage(), errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("dialog", (dialog) => dialog.accept());
    try { await work(page); assert.deepEqual(errors, []); console.log(`PASS ${name}`); checks++; }
    catch (error) { await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {}); throw error; }
    finally { await context.close(); }
  }

  await scenario("customer login cannot submit natively before its module loads", async (page) => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; }), documents = [];
    await page.route(/\/login(\.[0-9a-f]+)?\.js$/, async (route) => { await gate; await route.continue(); });
    page.on("request", (request) => { if (request.resourceType() === "document") documents.push(request.url()); });
    await page.goto(`${portal}/login`, { waitUntil: "commit" });
    await page.locator('[name="code"]').waitFor();
    assert.equal(await page.locator("#loginSubmit").isDisabled(), true);
    await page.locator('[name="phone"]').fill("670080001");
    await page.locator('[name="code"]').fill("NC-ABCD-EFGH");
    await page.locator('[name="code"]').press("Enter");
    release(); await idle(page, "#loginSubmit");
    assert.deepEqual(documents, [`${portal}/login`]);
  });

  for (const width of [1440, 390]) await scenario(`customer login locks competing methods and restores PIN retry at ${width}px`, async (page) => {
    const begin = await hold(page, "/api/account/access/begin", { token: "fixture-access", mode: "login" }, 200);
    await page.goto(`${portal}/login`);
    await page.locator('[name="phone"]').fill("670080001");
    await page.locator('[name="code"]').fill("NC-ABCD-EFGH");
    await submitTwice(page, "#login"); await begin.started;
    assert.equal(await page.locator("#loginSubmit").textContent(), "Checking…");
    for (const selector of ["#loginSubmit", "#changeDetails", "#customerPasskeyLogin"]) assert.equal(await page.locator(selector).isDisabled(), true);
    await page.evaluate(() => document.querySelector("#customerPasskeyLogin").onclick());
    begin.release(); await idle(page, "#loginSubmit");
    assert.equal(begin.count(), 1);
    assert.equal(await page.locator("#loginSubmit").textContent(), "Sign in");
    const complete = await hold(page, "/api/account/access/complete", { error: "Invalid PIN" });
    await page.locator("#customerPin").fill("1234");
    await submitTwice(page, "#login"); await complete.started;
    assert.equal(await page.locator("#loginSubmit").textContent(), "Signing in…");
    complete.release(); await idle(page, "#loginSubmit");
    assert.equal(complete.count(), 1);
    assert.equal(await page.locator("#loginSubmit").textContent(), "Sign in");
    assert.equal(await page.locator("#togglePin").textContent(), "Show");
    await page.getByText("Invalid PIN", { exact: true }).waitFor();
  }, { width });

  await scenario("admin login rejects duplicate submits and disables controls", async (page) => {
    const credentials = await hold(page, "/api/admin/login", { authenticated: true, user: { username: "fixture-owner", role: "owner" } }, 200);
    await page.goto(`${admin}/login`);
    await page.locator('[name="username"]').fill("fixture-owner");
    await page.locator("#adminPassword").fill("fixture-pin");
    await submitTwice(page, "#login"); await credentials.started;
    assert.equal(await page.locator("#passkeyLogin").isDisabled(), true);
    assert.equal(await page.locator("#togglePassword").textContent(), "Show");
    credentials.release(); await page.waitForURL("**/dashboard");
    assert.equal(credentials.count(), 1);
  });

  for (const confirm of [false, true]) await scenario(`PIN reset ${confirm ? "confirmation" : "request"} handles a missing submitter and retries`, async (page) => {
    const request = await hold(page, `/api/account/pin-reset/${confirm ? "confirm" : "request"}`, { error: "Fixture reset failure" });
    await page.goto(`${portal}/forgot-pin${confirm ? "?token=fixture-token" : ""}`);
    if (confirm) {
      await page.locator("#newPin").fill("2468");
      await page.locator('#resetConfirm [name="confirmPin"]').fill("2468");
    } else await page.locator('#resetRequest [name="phone"]').fill("670080001");
    const form = confirm ? "#resetConfirm" : "#resetRequest", button = `${form} button:not([type])`;
    await submitTwice(page, form); await request.started;
    assert.equal(await page.locator(button).getAttribute("aria-busy"), "true");
    request.release(); await idle(page, button);
    assert.equal(request.count(), 1);
    assert.equal(await page.locator(button).textContent(), confirm ? "Reset PIN" : "Send reset link");
    await page.getByText("Fixture reset failure", { exact: true }).waitFor();
  });

  await scenario("PIN setup locks duplicate submissions and restores retry after failure",async page=>{
    await page.addInitScript(()=>sessionStorage.setItem("ndahi-login-challenge",JSON.stringify({setupPin:true,phone:"670080001",code:"NC-ABCD-EFGH"})));
    const request=await hold(page,"/api/account/setup/pin",{error:"Fixture PIN setup failure"});
    await page.goto(`${portal}/verify.html`);await page.locator("#primary").fill("1234");await page.locator("#confirm").fill("1234");
    await submitTwice(page,"#verify");await request.started;assert.equal(await page.locator("#submitLabel").isDisabled(),true);
    request.release();await idle(page,"#submitLabel");assert.equal(request.count(),1);await page.getByText("Fixture PIN setup failure",{exact:true}).waitFor();
  });
  await scenario("passkey enrollment keeps duplicate actions locked and restores retry",async page=>{
    const request=await hold(page,"/api/account/passkeys/options",{error:"Fixture passkey options failure"});
    await page.goto(`${portal}/dashboard#account`);await page.locator("#securityManager>summary").click(); await page.locator('[data-security-panel="passkeys"]').click(); await page.locator("#addCustomerPasskey").click();
    await page.locator('[data-passkey-owner-proof] [name="pin"]').fill("2468");
    await page.locator("[data-passkey-owner-proof]").getByRole("button",{name:"Confirm with PIN",exact:true}).click();await request.started;
    assert.equal(await page.locator("#addCustomerPasskey").isDisabled(),true);
    await page.evaluate(()=>document.querySelector("#addCustomerPasskey").dispatchEvent(new MouseEvent("click",{bubbles:true})));
    request.release();await idle(page,"#addCustomerPasskey");assert.equal(request.count(),1);await page.getByText("Fixture passkey options failure",{exact:true}).waitFor();
  },{customer:true});

  await scenario("admin voucher generation and integration failures restore controls", async (page) => {
    await page.goto(`${admin}/dashboard`);
    await page.getByRole("link", { name: "More", exact: true }).click();
    await page.getByRole("tab", { name: "Generate voucher" }).click();
    const generation = await hold(page, "/api/admin/vouchers/generate", { error: "Fixture generation failure" });
    await submitTwice(page, "#generate"); await generation.started;
    assert.equal(await page.locator("#generate button").textContent(), "Generating…");
    generation.release(); await idle(page, "#generate button");
    assert.equal(generation.count(), 1);
    await page.getByText("Fixture generation failure", { exact: true }).waitFor();
    await page.getByRole("tab", { name: "Connections" }).click();
    const sync = await hold(page, "/api/admin/integrations/sync-usage", { error: "Fixture sync failure" });
    await page.locator("#syncUsage").click(); await sync.started;
    await page.evaluate(() => document.querySelector("#syncUsage").onclick());
    sync.release(); await idle(page, "#syncUsage");
    assert.equal(sync.count(), 1);
    assert.equal(await page.locator("#syncUsage").textContent(), "Sync usage");
    await page.getByText("Fixture sync failure", { exact: true }).waitFor();
  }, { authenticated: true });

  await scenario("delegated admin actions reject duplicate clicks and recover after failure", async (page) => {
    await page.goto(`${admin}/dashboard#connections`);
    await page.locator("#syncUsage").waitFor();
    await page.evaluate(() => document.querySelector("#app").insertAdjacentHTML("afterbegin", '<button id="fixtureRevoke" data-voucher="fixture-voucher">Revoke fixture</button>'));
    const revoke = await hold(page, "/api/admin/vouchers/revoke", { error: "Fixture revoke failure" });
    await page.locator("#fixtureRevoke").click(); await revoke.started;
    await page.evaluate(() => document.querySelector("#fixtureRevoke").dispatchEvent(new MouseEvent("click", { bubbles: true })));
    revoke.release(); await idle(page, "#fixtureRevoke");
    assert.equal(revoke.count(), 1);
    assert.equal(await page.locator("#fixtureRevoke").textContent(), "Revoke fixture");
    await page.getByText("Fixture revoke failure", { exact: true }).waitFor();
  }, { authenticated: true });

  await scenario("network activation preserves its completed disabled state", async (page) => {
    await page.goto(`${admin}/login`);
    await page.evaluate(async () => {
      const root = document.createElement("section"); root.id = "fixtureNetwork"; document.body.append(root);
      const { mountNetworkSetup } = await import("/network-setup.js");
      const state = { enabled: true, encryptionReady: true, runtimeRouterEnabled: false, allowedOrigins: [], jobs: [] };
      window.activationCalls = 0;
      await mountNetworkSetup(root, async (path) => {
        if (path.endsWith("/activate")) {
          window.activationCalls++;
          await new Promise((resolve) => { window.finishActivation = resolve; });
          state.runtimeRouterEnabled = true;
        }
        return structuredClone(state);
      });
    });
    await page.locator("#networkEnforcementTested").check();
    await page.locator("#networkActivate").click();
    await page.waitForFunction(() => window.activationCalls === 1);
    await page.evaluate(() => document.querySelector("#networkActivate").onclick());
    assert.equal(await page.locator("#networkActivate").getAttribute("aria-busy"), "true");
    await page.evaluate(() => window.finishActivation());
    await page.waitForFunction(() => document.querySelector("#networkActivate").getAttribute("aria-busy") !== "true");
    assert.equal(await page.locator("#networkActivate").isDisabled(), true);
    assert.equal(await page.evaluate(() => window.activationCalls), 1);
    assert.equal(await page.locator("#networkActivate").textContent(), "Use saved router for vouchers");
  });

  await scenario("record pages lock pagination, ignore stale searches and expose retry", async (page) => {
    await page.goto(`${admin}/login`);
    await page.evaluate(async () => {
      const root = document.createElement("section"); root.id = "fixtureRecords"; document.body.append(root);
      const { mountRecords } = await import("/records.js");
      window.recordRequests = [];
      void mountRecords(root, { collection: "customers", title: "Fixture customers", headers: ["Name"],
        row: (record) => `<tr><td>${record.name}</td></tr>`,
        call: (path) => new Promise((resolve, reject) => window.recordRequests.push({ path, resolve, reject })),
      });
    });
    assert.equal(await page.locator('[data-page="next"]').isDisabled(), true);
    await page.evaluate(() => window.recordRequests[0].resolve({ page: 1, pages: 3, total: 60, statuses: [], items: [{ name: "Initial result" }] }));
    await idle(page, '[data-page="next"]');
    await page.locator('[data-page="next"]').click();
    await page.evaluate(() => document.querySelector('[data-page="next"]').onclick());
    assert.equal(await page.evaluate(() => window.recordRequests.length), 2);
    assert.match(await page.locator("tbody").textContent(), /Loading/);
    await page.locator('input[name="q"]').fill("latest");
    await page.evaluate(() => window.recordRequests[1].resolve({ page: 2, pages: 3, total: 60, statuses: [], items: [{ name: "Stale result" }] }));
    assert.doesNotMatch(await page.locator("tbody").textContent(), /Stale/);
    await page.waitForFunction(() => window.recordRequests.length === 3);
    assert.match(await page.evaluate(() => window.recordRequests[2].path), /q=latest/);
    await page.evaluate(() => window.recordRequests[2].reject(new Error("Fixture records failure")));
    await page.getByRole("button", { name: "Try again" }).click();
    await page.waitForFunction(() => window.recordRequests.length === 4);
    await page.evaluate(() => window.recordRequests[3].resolve({ page: 1, pages: 1, total: 1, statuses: [], items: [{ name: "Latest result" }] }));
    await page.getByText("Latest result", { exact: true }).waitFor();
    assert.equal(await page.locator("#fixtureRecords").getAttribute("aria-busy"), null);
    assert.equal(await page.locator('[data-page="next"]').isDisabled(), true);
  });

  await scenario("customer picker clears stale choices and recovers from failed searches", async (page) => {
    await page.goto(`${admin}/login`);
    await page.evaluate(async () => {
      const root = document.createElement("section");
      root.innerHTML = '<input id="fixtureSearch"><select id="fixtureSelect" required></select>'; document.body.append(root);
      const { mountCustomerPicker } = await import("/records.js");
      window.pickerRequests = [];
      void mountCustomerPicker(root.querySelector("input"), root.querySelector("select"),
        (path) => new Promise((resolve, reject) => window.pickerRequests.push({ path, resolve, reject })));
    });
    await page.locator("#fixtureSearch").fill("latest");
    await page.evaluate(() => window.pickerRequests[0].resolve({ items: [{ id: "stale", name: "Stale customer", phone: "670080001" }] }));
    assert.equal(await page.locator("#fixtureSelect").inputValue(), "");
    await page.waitForFunction(() => window.pickerRequests.length === 2);
    await page.evaluate(() => window.pickerRequests[1].reject(new Error("Fixture picker failure")));
    await page.waitForFunction(() => document.querySelector("#fixtureSelect").getAttribute("aria-busy") !== "true");
    assert.match(await page.locator("#fixtureSelect").textContent(), /Unable to load/);
    await page.locator("#fixtureSearch").press("Enter");
    await page.waitForFunction(() => window.pickerRequests.length === 3);
    await page.evaluate(() => window.pickerRequests[2].resolve({ items: [{ id: "latest", name: "Latest customer", phone: "670080002" }] }));
    await page.waitForFunction(() => document.querySelector("#fixtureSelect").value === "latest");
  });

  await scenario("saved-checkout failures stay visible and can be retried", async (page) => {
    await page.context().addCookies([{ name: "ndahi-checkout", url: portal, sameSite: "Strict",
      value: encodeURIComponent(JSON.stringify({ requestKey: crypto.randomUUID().replaceAll("-", ""), planId: "weekly" })) }]);
    // The visit checks the saved key itself and keeps packages locked until it knows.
    const check = await hold(page, "/api/purchase/recover", { error: "Fixture recovery unavailable" }, 500);
    await page.goto(`${portal}/onboarding.html`); await check.started;
    await page.getByText("Checking a payment saved on this device…", { exact: true }).waitFor();
    assert.equal(await page.locator('[data-plan="weekly"]').isDisabled(), true);
    check.release();
    await page.getByRole("button", { name: "Resume saved payment" }).waitFor();
    assert.equal(await page.locator('[data-plan="weekly"]').isDisabled(), true, "an unconfirmed saved payment still blocks another");
    const recover = await hold(page, "/api/purchase/recover", { error: "Fixture recovery unavailable" }, 500);
    await page.getByRole("button", { name: "Resume saved payment" }).click(); await recover.started;
    assert.equal(await page.locator("#resumeCheckout").textContent(), "Resuming…");
    recover.release();
    await page.locator("#planNotice .error-card").waitFor();
    assert.equal(await page.locator("#checkout").isVisible(), false);
    const retry = page.getByRole("button", { name: "Resume saved payment" });
    const retryResponse = page.waitForResponse((response) => response.url().endsWith("/api/purchase/recover"));
    await retry.click();
    await retryResponse;
    assert.equal(check.count(), 1);
    assert.equal(recover.count(), 2);
  });
  console.log(`PASS ${checks} pending-state browser scenarios`);
} finally {
  await browser?.close(); await close(customerSite); await close(adminSite); await close(server);
}
