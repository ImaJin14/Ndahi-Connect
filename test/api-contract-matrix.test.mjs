import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHmac } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import argon2 from "argon2";
import pg from "pg";
import { createHandler, createStore, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { createStaticServer } from "../static-server.mjs";
import { checkDeployment } from "../scripts/check-deployment.mjs";
import { hashSecret } from "../lib/security.mjs";
import { silentLogger } from "../lib/logger.mjs";

const customerOrigin = "http://customer.test";
const adminOrigin = "http://admin.test";
const storeOrigin = "http://store.test";
const customerSecret = "matrix-customer-secret";
const adminSecret = "matrix-admin-secret";
const pepper = "matrix-pepper";
const now = new Date("2030-06-01T12:00:00Z");
const later = (ms) => new Date(+now + ms).toISOString();

async function setupServer(t, { store: customStore, extraEnv = {}, seed, router, payments, email } = {}) {
  const store = customStore || createStore({ persistent: false });
  if (seed) await store.transaction(seed);
  const handler = createHandler({
    store,
    now: () => now,
    validateConfig: false,
    logger: silentLogger,
    router,
    payments,
    email,
    env: {
      NODE_ENV: "production",
      PAYMENT_MODE: "mock",
      EMAIL_MODE: "mock",
      MIKROTIK_MODE: "mock",
      OMADA_MODE: "mock",
      CUSTOMER_SESSION_SECRET: customerSecret,
      ADMIN_SESSION_SECRET: adminSecret,
      SECRET_PEPPER: pepper,
      SESSION_COOKIE_SECURE: "false",
      CUSTOMER_APP_URL: customerOrigin,
      ADMIN_APP_URL: adminOrigin,
      STORE_APP_URL: storeOrigin,
      BILLING_WORKER_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
      COVERAGE_ACCESS_ENABLED: "true",
      COVERAGE_ALLOWED_IPS: "203.0.113.10",
      TRUST_PROXY: "render",
      LOG_LEVEL: "silent",
      ...extraEnv,
    },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(resolve);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const req = async (method, path, { origin = customerOrigin, cookie, csrf, body, headers = {} } = {}) => {
    const reqHeaders = {
      ...(origin ? { origin } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrf ? { "x-csrf-token": csrf } : {}),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
      "cf-connecting-ip": "203.0.113.10",
      ...headers,
    };
    const res = await fetch(base + path, {
      method,
      headers: reqHeaders,
      ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
    });
    const contentType = res.headers.get("content-type") || "";
    const buf = Buffer.from(await res.arrayBuffer());
    const text = buf.toString("utf8");
    let jsonBody = null;
    if (contentType.includes("application/json")) {
      try { jsonBody = JSON.parse(text); } catch { jsonBody = null; }
    }
    return { status: res.status, headers: res.headers, buf, text, body: jsonBody };
  };
  return { store, handler, req, base };
}

test("CSRF regression: customer device-management current/reset and nickname enforce session + x-csrf-token", async (t) => {
  const { req } = await setupServer(t, {
    seed: (s) => {
      s.customers.push({ id: "c1", name: "Alice", phone: "670000101" });
      s.dashboardSessions.push({
        id: "s1",
        customerId: "c1",
        tokenHash: hashSecret("tok-1", customerSecret),
        csrfToken: "csrf-1",
        expiresAt: later(3600_000),
      });
    },
  });
  const mac = "AA:BB:CC:DD:EE:10";
  for (const [path, payload] of [
    ["/api/account/device-management/current/reset", {}],
    ["/api/account/device-management/nickname", { mac, nickname: "My Phone" }],
  ]) {
    assert.equal((await req("POST", path, { body: payload })).status, 401, `${path} requires session`);
    assert.equal((await req("POST", path, { cookie: "customer_session=tok-1", body: payload })).status, 403, `${path} requires CSRF`);
    assert.equal((await req("POST", path, { cookie: "customer_session=tok-1", csrf: "wrong", body: payload })).status, 403, `${path} rejects bad CSRF`);
    const ok = await req("POST", path, { cookie: "customer_session=tok-1", csrf: "csrf-1", body: payload });
    assert.equal(ok.status, 200, `${path} succeeds with valid session + CSRF`);
  }
  const dm = await req("GET", "/api/account/device-management", { cookie: "customer_session=tok-1" });
  assert.equal(dm.status, 200);
});

test("Admin role-gate regression: all admin roles can change their own password/PIN with CSRF and log in with it", async (t) => {
  const oldPass = "123456";
  const oldHash = await argon2.hash(oldPass);
  const roles = ["owner", "operator", "reseller", "auditor"];
  const { req } = await setupServer(t, {
    seed: (s) => {
      roles.forEach((role, idx) => {
        const id = `u-${role}`;
        s.adminUsers.push({
          id,
          username: role,
          email: `${role}@ndahi.test`,
          role,
          active: true,
          passwordHash: oldHash,
          pinHash: oldHash,
          passkeys: [],
        });
        s.adminSessions.push({
          id: `as-${role}`,
          userId: id,
          role,
          tokenHash: hashSecret(`adm-${role}`, adminSecret),
          csrfToken: `adm-csrf-${role}`,
          expiresAt: later(3600_000),
        });
      });
    },
  });

  for (const role of roles) {
    const cookie = `admin_session=adm-${role}`;
    const csrf = `adm-csrf-${role}`;
    const newPassword = role === "owner" ? "654321" : role === "operator" ? "765432" : role === "reseller" ? "876543" : "987654";

    // Missing CSRF -> 403
    assert.equal(
      (await req("POST", "/api/admin/profile/password", { origin: adminOrigin, cookie, body: { currentPassword: oldPass, newPassword } })).status,
      403,
    );
    // Wrong current password -> 401
    assert.equal(
      (await req("POST", "/api/admin/profile/password", { origin: adminOrigin, cookie, csrf, body: { currentPassword: "000000", newPassword } })).status,
      401,
    );
    // Valid self-service change -> 200
    const changed = await req("POST", "/api/admin/profile/password", {
      origin: adminOrigin,
      cookie,
      csrf,
      body: { currentPassword: oldPass, newPassword },
    });
    assert.equal(changed.status, 200, `${role} should be able to update own password`);
    assert.equal(changed.body.updated, true);

    // Confirm login works with new password (and old password fails)
    const badLogin = await req("POST", "/api/admin/login", {
      origin: adminOrigin,
      body: { email: `${role}@ndahi.test`, password: oldPass },
    });
    assert.equal(badLogin.status, 401);
    const goodLogin = await req("POST", "/api/admin/login", {
      origin: adminOrigin,
      body: { email: `${role}@ndahi.test`, password: newPassword },
    });
    assert.equal(goodLogin.status, 200);
  }
});

test("Public, telemetry, home config, and 404 boundaries return expected contracts", async (t) => {
  const { req } = await setupServer(t);
  assert.equal((await req("GET", "/api/health")).status, 200);
  assert.equal((await req("GET", "/api/status")).status, 200);
  assert.equal((await req("GET", "/api/plans")).status, 200);
  assert.equal((await req("GET", "/api/authentication-policy")).status, 200);
  assert.equal((await req("GET", "/api/purchase/access")).status, 200);
  const homeCfg = await req("GET", "/api/home/config");
  assert.equal(homeCfg.status, 200);
  assert.equal(typeof homeCfg.body.enabled, "boolean");

  // Telemetry & CSP report
  assert.equal((await req("POST", "/api/csp-report", { origin: null, body: { "csp-report": { "violated-directive": "script-src" } } })).status, 204);
  assert.equal((await req("POST", "/api/telemetry/vitals", { origin: "https://evil.invalid", body: {} })).status, 403);
  assert.equal((await req("GET", "/api/metrics")).status, 404);

  // Unknown routes
  assert.equal((await req("GET", "/api/does-not-exist")).status, 404);
  assert.equal((await req("GET", "/not-api")).status, 404);
});

test("Device store public & authenticated contracts (catalogue, checkout, order, verify, receipt PDF, claim, CORS)", async (t) => {
  const mesombStub = {
    configured: () => true,
    async createPayment(payment) {
      return { status: "pending", providerReference: "m-ref-" + payment.id, raw: {} };
    },
    async verifyPayment(payment) {
      return {
        status: "paid",
        providerReference: payment.providerReference || "m-ref-" + payment.id,
        transactionReference: payment.id,
        amount: payment.amount,
        currency: "XAF",
        raw: {},
      };
    },
  };
  const { req } = await setupServer(t, {
    extraEnv: { PAYMENT_MODE: "mesomb" },
    payments: { mesomb: mesombStub },
    seed: (s) => {
      s.customers.push(
        { id: "c1", name: "Alice", phone: "670000101", email: "alice@ndahi.test" },
        { id: "c2", name: "Bob", phone: "670000102", email: "bob@ndahi.test" },
      );
      s.dashboardSessions.push(
        { id: "s1", customerId: "c1", tokenHash: hashSecret("tok-1", customerSecret), csrfToken: "csrf-1", expiresAt: later(3600_000) },
        { id: "s2", customerId: "c2", tokenHash: hashSecret("tok-2", customerSecret), csrfToken: "csrf-2", expiresAt: later(3600_000) },
      );
      s.storeSettings = { open: true, pickup: { en: "Main desk", fr: "Accueil" }, terms: { en: "Terms", fr: "Conditions" } };
      s.storeCategories = [{ id: "cat-1", name: { en: "Routers", fr: "Routeurs" }, order: 1 }];
      s.storeProducts = [{
        id: "prod-1", sku: "SKU-4G-1", version: 1, status: "published", featured: true, categoryId: "cat-1",
        name: { en: "4G Router", fr: "Routeur 4G" },
        description: { en: "Wi-Fi router", fr: "Routeur Wi-Fi" },
        specifications: { en: "LTE", fr: "LTE" },
        compatibility: { en: "All", fr: "Tous" },
        contents: { en: "Box", fr: "Boîte" },
        warranty: { en: "1 year", fr: "1 an" },
        setup: { en: "Plug", fr: "Brancher" },
        price: 15000, cost: 10000, stock: 5, images: [],
      }];
    },
  });

  // Store CORS allows storeOrigin & customerOrigin, rejects untrusted
  const cat = await req("GET", "/api/store/catalogue", { origin: storeOrigin });
  assert.equal(cat.status, 200);
  assert.equal(cat.headers.get("access-control-allow-origin"), storeOrigin);
  assert.equal(cat.body.products.length, 1);
  assert.equal((await req("GET", "/api/store/catalogue", { origin: "https://evil.invalid" })).status, 403);

  // Anonymous store context
  const anonCtx = await req("GET", "/api/account/store/context", { origin: storeOrigin });
  assert.equal(anonCtx.status, 200);
  assert.equal(anonCtx.body.authenticated, false);

  // Guest checkout -> order -> verify -> receipt PDF -> claim by c1
  const guestCheckout = await req("POST", "/api/store/checkout", {
    origin: storeOrigin,
    body: {
      productId: "prod-1",
      quantity: 1,
      expectedPrice: 15000,
      name: "Guest Buyer",
      phone: "670000199",
      payerPhone: "670000199",
      network: "mtn",
      checkoutKey: "store-guest-key-0000000001",
    },
  });
  assert.equal(guestCheckout.status, 200);
  const { order: gOrder, token: gToken } = guestCheckout.body;
  assert.ok(gOrder.id && gToken);

  const tracked = await req("POST", "/api/store/order", { origin: storeOrigin, body: { orderId: gOrder.id, token: gToken } });
  assert.equal(tracked.status, 200);
  assert.equal(tracked.body.order.id, gOrder.id);

  // Mock checkout starts paid/confirmed or verify succeeds and produces PDF receipt
  const verified = await req("POST", "/api/store/verify", { origin: storeOrigin, body: { orderId: gOrder.id, token: gToken } });
  assert.equal(verified.status, 200);

  const guestPdf = await req("POST", "/api/store/receipt", { origin: storeOrigin, body: { orderId: gOrder.id, token: gToken } });
  assert.equal(guestPdf.status, 200);
  assert.match(guestPdf.headers.get("content-type") || "", /application\/pdf/);
  assert.equal(guestPdf.buf.subarray(0, 5).toString("ascii"), "%PDF-");

  // Claim guest order into c1 (requires session + CSRF)
  assert.equal((await req("POST", "/api/account/store/claim", { origin: storeOrigin, body: { orderId: gOrder.id, token: gToken } })).status, 401);
  assert.equal((await req("POST", "/api/account/store/claim", { origin: storeOrigin, cookie: "customer_session=tok-1", body: { orderId: gOrder.id, token: gToken } })).status, 403);
  const claimed = await req("POST", "/api/account/store/claim", {
    origin: storeOrigin,
    cookie: "customer_session=tok-1",
    csrf: "csrf-1",
    body: { orderId: gOrder.id, token: gToken },
  });
  assert.equal(claimed.status, 200);

  // Authenticated account store order/verify/receipt & cross-customer isolation
  const acctCtx = await req("GET", "/api/account/store/context", { origin: customerOrigin, cookie: "customer_session=tok-1" });
  assert.equal(acctCtx.status, 200);
  assert.equal(acctCtx.body.authenticated, true);
  assert.equal(acctCtx.body.orders.length, 1);

  const acctOrder = await req("POST", "/api/account/store/order", {
    origin: customerOrigin,
    cookie: "customer_session=tok-1",
    csrf: "csrf-1",
    body: { orderId: gOrder.id },
  });
  assert.equal(acctOrder.status, 200);

  const acctVerify = await req("POST", "/api/account/store/verify", {
    origin: customerOrigin,
    cookie: "customer_session=tok-1",
    csrf: "csrf-1",
    body: { orderId: gOrder.id },
  });
  assert.equal(acctVerify.status, 200);

  const acctPdf = await req("POST", "/api/account/store/receipt", {
    origin: customerOrigin,
    cookie: "customer_session=tok-1",
    csrf: "csrf-1",
    body: { orderId: gOrder.id },
  });
  assert.equal(acctPdf.status, 200);
  assert.equal(acctPdf.buf.subarray(0, 5).toString("ascii"), "%PDF-");

  // Customer 2 cannot read Customer 1's store order
  const crossCustomer = await req("POST", "/api/account/store/order", {
    origin: customerOrigin,
    cookie: "customer_session=tok-2",
    csrf: "csrf-2",
    body: { orderId: gOrder.id },
  });
  assert.equal(crossCustomer.status, 404);
});

test("Flutterwave webhook verifies signature and activates payment", async (t) => {
  const secretHash = "flw-test-secret";
  const flwStub = {
    async handleWebhook(raw, sig) {
      const expected = createHmac("sha256", secretHash).update(raw).digest("base64");
      if (!sig || sig !== expected) throw Error("Invalid signature");
      const ev = JSON.parse(raw);
      return { eventId: ev.id, type: ev.type, paymentId: ev.data.tx_ref, transactionId: ev.data.id };
    },
    async verifyPayment(payment, txId) {
      return { status: "paid", providerReference: String(txId), transactionReference: payment.id, amount: payment.amount, currency: "XAF", raw: {} };
    },
  };
  const { req, store } = await setupServer(t, {
    payments: { flutterwave: flwStub },
    seed: (s) => {
      s.customers.push({ id: "c1", name: "Alice", phone: "670000101" });
      s.payments.push({
        id: "pay-flw-1",
        customerId: "c1",
        planId: "daily",
        amount: 250,
        currency: "XAF",
        provider: "flutterwave",
        status: "pending",
        createdAt: now.toISOString(),
        paymentExpiresAt: later(300_000),
        paymentClosesAt: later(420_000),
        payerPhone: "670000101",
      });
    },
  });

  const payload = JSON.stringify({
    id: "evt-flw-1",
    type: "charge.completed",
    data: { id: 987654, tx_ref: "pay-flw-1", status: "successful", amount: 250, currency: "XAF" },
  });
  assert.equal((await req("POST", "/api/webhooks/flutterwave", { origin: null, body: payload, headers: { "flutterwave-signature": "bad" } })).status, 401);

  const sig = createHmac("sha256", secretHash).update(payload).digest("base64");
  const ok = await req("POST", "/api/webhooks/flutterwave", { origin: null, body: payload, headers: { "flutterwave-signature": sig } });
  assert.equal(ok.status, 200);
  const snap = await store.snapshot();
  assert.equal(snap.payments.find((p) => p.id === "pay-flw-1").status, "paid");
});

test("Admin endpoints matrix: vouchers print/email, resellers, network/omada/home, retired MFA, and role gates", async (t) => {
  const passHash = await argon2.hash("123456");
  const { req } = await setupServer(t, {
    extraEnv: { NDAHI_HOME_ENABLED: "true" },
    seed: (s) => {
      s.customers.push({ id: "c1", name: "Alice", phone: "670000101", email: "alice@ndahi.test", emailVerifiedAt: now.toISOString() });
      s.dashboardSessions.push({ id: "cs-1", customerId: "c1", tokenHash: hashSecret("cust-1", customerSecret), csrfToken: "c-csrf-1", expiresAt: later(3600_000) });
      s.vouchers.push({
        id: "v-1",
        customerId: "c1",
        code: "NC-1111-2222",
        planId: "daily",
        status: "active",
        activatedAt: now.toISOString(),
        expiresAt: later(86400_000),
        quotaBytes: 1e9,
        usedBytes: 0,
        deviceLimit: 1,
      });
      s.sessions.push({ id: "sess-1", voucherId: "v-1", deviceId: "AA:BB:CC:DD:EE:01", status: "online" });
      for (const role of ["owner", "operator", "reseller", "auditor"]) {
        const id = `u-${role}`;
        s.adminUsers.push({ id, username: role, email: `${role}@ndahi.test`, role, active: true, passwordHash: passHash, pinHash: passHash, passkeys: [] });
        s.adminSessions.push({ id: `as-${role}`, userId: id, role, tokenHash: hashSecret(`adm-${role}`, adminSecret), csrfToken: `csrf-${role}`, expiresAt: later(3600_000) });
      }
    },
  });

  const owner = { origin: adminOrigin, cookie: "admin_session=adm-owner", csrf: "csrf-owner" };
  const operator = { origin: adminOrigin, cookie: "admin_session=adm-operator", csrf: "csrf-operator" };
  const reseller = { origin: adminOrigin, cookie: "admin_session=adm-reseller", csrf: "csrf-reseller" };
  const auditor = { origin: adminOrigin, cookie: "admin_session=adm-auditor", csrf: "csrf-auditor" };

  // Vouchers print, print-preview, print-pdf, resend-email, details
  assert.equal((await req("GET", "/api/admin/vouchers/v-1/details", owner)).status, 200);
  assert.equal((await req("GET", "/api/admin/vouchers/v-1/details?full=1", owner)).status, 200);
  assert.equal((await req("POST", "/api/admin/vouchers/print", { ...owner, body: { voucherId: "v-1" } })).status, 200);
  assert.equal((await req("POST", "/api/admin/vouchers/print-preview", { ...owner, body: { voucherIds: ["v-1"], widthMm: 58 } })).status, 200);
  const vPdf = await req("POST", "/api/admin/vouchers/print-pdf", { ...owner, body: { voucherIds: ["v-1"], widthMm: 80 } });
  assert.equal(vPdf.status, 200);
  assert.equal(vPdf.buf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal((await req("POST", "/api/admin/vouchers/resend-email", { ...owner, body: { voucherId: "v-1" } })).status, 200);
  assert.equal((await req("POST", "/api/admin/vouchers/print", { ...auditor, body: { voucherId: "v-1" } })).status, 403);

  // Resellers ledger + commission/remittances/adjustments role checks
  assert.equal((await req("GET", "/api/admin/resellers/ledger", owner)).status, 200);
  assert.equal((await req("GET", "/api/admin/resellers/ledger", reseller)).status, 200);
  assert.equal((await req("POST", "/api/admin/resellers/commission", { ...operator, body: { resellerId: "u-reseller", commissionPercent: 10 } })).status, 403);
  const comm = await req("POST", "/api/admin/resellers/commission", { ...owner, body: { resellerId: "u-reseller", commissionPercent: 12 } });
  assert.equal(comm.status, 200);
  const rem = await req("POST", "/api/admin/resellers/remittances", {
    ...owner,
    body: { resellerId: "u-reseller", amount: 1000, method: "cash", operationKey: "remit-op-key-00001" },
  });
  assert.equal(rem.status, 201);
  const adj = await req("POST", "/api/admin/resellers/adjustments", {
    ...owner,
    body: { resellerId: "u-reseller", amount: -200, reason: "Correction", operationKey: "adj-op-key-000001" },
  });
  assert.equal(adj.status, 201);

  // Network, Omada, Device disconnect & Home admin routes
  assert.equal((await req("GET", "/api/admin/integrations/omada", owner)).status, 200);
  assert.equal((await req("POST", "/api/admin/integrations/sync-usage", owner)).status, 200);
  assert.equal((await req("POST", "/api/admin/devices/disconnect", { ...owner, body: { sessionId: "sess-1" } })).status, 200);
  assert.equal((await req("GET", "/api/admin/network/setup/status", owner)).status, 200);
  assert.equal((await req("GET", "/api/admin/network/setup/status", operator)).status, 403);
  assert.equal((await req("GET", "/api/admin/home", owner)).status, 200);
  assert.equal((await req("GET", "/api/admin/home/readiness", owner)).status, 200);
  assert.equal((await req("GET", "/api/admin/home/pilot-template", owner)).status, 200);

  // Retired MFA endpoints return 410
  assert.equal((await req("POST", "/api/admin/profile/mfa/enroll", { ...owner, body: {} })).status, 410);

  // Customer retired MFA endpoints: CSRF gate first when unauthenticated (401), then 410 when authenticated
  assert.equal((await req("POST", "/api/account/security/mfa/enroll", { origin: customerOrigin, body: {} })).status, 401);
  assert.equal((await req("POST", "/api/account/security/mfa/enroll", { origin: customerOrigin, cookie: "customer_session=cust-1", csrf: "c-csrf-1", body: {} })).status, 410);
  assert.equal((await req("POST", "/api/account/security/recovery-codes/generate", { origin: customerOrigin, cookie: "customer_session=cust-1", csrf: "c-csrf-1", body: {} })).status, 410);
});

test("Deployment smoke check verifies all 4 services (customer, admin, store, api) locally", async (t) => {
  const listen = (s) => new Promise((r) => s.listen(0, "127.0.0.1", r));
  const close = (s) => new Promise((r) => { s.close(r); s.closeAllConnections(); });
  const probe = http.createServer();
  await listen(probe);
  const apiPort = probe.address().port;
  await close(probe);
  const apiUrl = `http://127.0.0.1:${apiPort}`;

  const customerSrv = createStaticServer("customer", { apiUrl, env: { NODE_ENV: "test" } });
  const adminSrv = createStaticServer("admin", { apiUrl, env: { NODE_ENV: "test" } });
  const storeSrv = createStaticServer("store", { apiUrl, env: { NODE_ENV: "test" } });
  await Promise.all([listen(customerSrv), listen(adminSrv), listen(storeSrv)]);

  const cUrl = `http://127.0.0.1:${customerSrv.address().port}`;
  const aUrl = `http://127.0.0.1:${adminSrv.address().port}`;
  const sUrl = `http://127.0.0.1:${storeSrv.address().port}`;

  const apiSrv = http.createServer(createHandler({
    store: createStore({ persistent: false }),
    now: () => now,
    validateConfig: false,
    logger: silentLogger,
    env: {
      NODE_ENV: "test",
      BOOTSTRAP_MODE: "true",
      PAYMENT_MODE: "mock",
      EMAIL_MODE: "mock",
      MIKROTIK_MODE: "mock",
      OMADA_MODE: "mock",
      CUSTOMER_APP_URL: cUrl,
      ADMIN_APP_URL: aUrl,
      ALLOWED_ADMIN_ORIGINS: aUrl,
      STORE_APP_URL: sUrl,
      BILLING_WORKER_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
      LOG_LEVEL: "silent",
    },
  }));
  await new Promise((r) => apiSrv.listen(apiPort, "127.0.0.1", r));
  t.after(async () => {
    await Promise.all([close(customerSrv), close(adminSrv), close(storeSrv), close(apiSrv)]);
  });

  const checks = await checkDeployment({
    customerUrl: cUrl,
    adminUrl: aUrl,
    storeUrl: sUrl,
    apiUrl,
    allowBootstrap: true,
    expectedProvider: "mock",
    expectAuthenticatorRetired: true,
  });
  assert.ok(checks.some((c) => c.includes("Store service")));
});

const dbUrl = process.env.TEST_DATABASE_URL;
test("PostgreSQL contract matrix: CSRF fixes, admin self-service password, and store persistence", { skip: dbUrl ? false : "TEST_DATABASE_URL is not set" }, async (t) => {
  const schema = `ndahi_contract_matrix_${process.pid}`;
  const adminClient = new pg.Client({ connectionString: dbUrl });
  await adminClient.connect();
  await adminClient.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: dbUrl, options: `-c search_path=${schema}`, max: 10 });
  t.after(async () => {
    await pool.end();
    await adminClient.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminClient.end();
  });
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(dir)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) {
    await pool.query(await readFile(new URL(file, dir), "utf8"));
  }
  const pgStore = createPostgresStore({ pool, initialState: blank });
  const oldPass = "123456";
  const oldHash = await argon2.hash(oldPass);
  const mesombStub = {
    configured: () => true,
    async createPayment(payment) {
      return { status: "pending", providerReference: "pg-ref-" + payment.id, raw: {} };
    },
    async verifyPayment(payment) {
      return { status: "paid", providerReference: payment.providerReference || "pg-ref-" + payment.id, transactionReference: payment.id, amount: payment.amount, currency: "XAF", raw: {} };
    },
  };

  const { req } = await setupServer(t, {
    store: pgStore,
    extraEnv: { PAYMENT_MODE: "mesomb" },
    payments: { mesomb: mesombStub },
    seed: (s) => {
      s.customers.push({ id: "pg-c1", name: "PG Alice", phone: "670000801", email: "pg@ndahi.test" });
      s.dashboardSessions.push({
        id: "pg-cs1",
        customerId: "pg-c1",
        tokenHash: hashSecret("pg-tok-1", customerSecret),
        csrfToken: "pg-csrf-1",
        expiresAt: later(3600_000),
      });
      s.adminUsers.push({
        id: "pg-op",
        username: "pgoperator",
        email: "pgop@ndahi.test",
        role: "operator",
        active: true,
        passwordHash: oldHash,
        pinHash: oldHash,
        passkeys: [],
      });
      s.adminSessions.push({
        id: "pg-as1",
        userId: "pg-op",
        role: "operator",
        tokenHash: hashSecret("pg-adm-1", adminSecret),
        csrfToken: "pg-adm-csrf-1",
        expiresAt: later(3600_000),
      });
      s.storeSettings = { open: true, pickup: { en: "Main desk", fr: "Accueil" }, terms: { en: "Terms", fr: "Conditions" } };
      s.storeCategories = [{ id: "pg-cat", name: { en: "Routers", fr: "Routeurs" }, order: 1 }];
      s.storeProducts = [{
        id: "pg-prod", sku: "PG-SKU-1", version: 1, status: "published", featured: true, categoryId: "pg-cat",
        name: { en: "PG Router", fr: "Routeur PG" }, description: { en: "Wi-Fi", fr: "Wi-Fi" },
        specifications: { en: "LTE", fr: "LTE" }, compatibility: { en: "All", fr: "Tous" },
        contents: { en: "Box", fr: "Boîte" }, warranty: { en: "1y", fr: "1an" }, setup: { en: "Plug", fr: "Plug" },
        price: 15000, cost: 10000, stock: 5, images: [],
      }];
    },
  });

  // 1. Customer CSRF persistence on PostgreSQL
  const mac = "AA:BB:CC:DD:EE:88";
  assert.equal((await req("POST", "/api/account/device-management/nickname", { cookie: "customer_session=pg-tok-1", body: { mac, nickname: "PG Phone" } })).status, 403);
  assert.equal((await req("POST", "/api/account/device-management/nickname", { cookie: "customer_session=pg-tok-1", csrf: "pg-csrf-1", body: { mac, nickname: "PG Phone" } })).status, 200);
  assert.equal((await req("POST", "/api/account/device-management/current/reset", { cookie: "customer_session=pg-tok-1", body: {} })).status, 403);
  assert.equal((await req("POST", "/api/account/device-management/current/reset", { cookie: "customer_session=pg-tok-1", csrf: "pg-csrf-1", body: {} })).status, 200);
  const pgSnap1 = await pgStore.snapshot();
  assert.equal(pgSnap1.customers.find((c) => c.id === "pg-c1").deviceNicknames[mac], "PG Phone");

  // 2. Admin operator self-service password change persistence on PostgreSQL
  const newPass = "918273";
  assert.equal((await req("POST", "/api/admin/profile/password", { origin: adminOrigin, cookie: "admin_session=pg-adm-1", body: { currentPassword: oldPass, newPassword: newPass } })).status, 403);
  assert.equal((await req("POST", "/api/admin/profile/password", { origin: adminOrigin, cookie: "admin_session=pg-adm-1", csrf: "pg-adm-csrf-1", body: { currentPassword: oldPass, newPassword: newPass } })).status, 200);
  assert.equal((await req("POST", "/api/admin/login", { origin: adminOrigin, body: { email: "pgop@ndahi.test", password: newPass } })).status, 200);

  // 3. Store checkout -> verify -> receipt PDF -> claim persistence on PostgreSQL
  const co = await req("POST", "/api/store/checkout", {
    origin: storeOrigin,
    body: { productId: "pg-prod", quantity: 1, expectedPrice: 15000, name: "PG Guest", phone: "670000899", payerPhone: "670000899", network: "mtn", checkoutKey: "pg-store-checkout-key-000001" },
  });
  assert.equal(co.status, 200);
  assert.equal((await req("POST", "/api/store/verify", { origin: storeOrigin, body: { orderId: co.body.order.id, token: co.body.token } })).status, 200);
  const pdf = await req("POST", "/api/store/receipt", { origin: storeOrigin, body: { orderId: co.body.order.id, token: co.body.token } });
  assert.equal(pdf.status, 200);
  assert.equal(pdf.buf.subarray(0, 5).toString("ascii"), "%PDF-");
  assert.equal((await req("POST", "/api/account/store/claim", { origin: storeOrigin, cookie: "customer_session=pg-tok-1", csrf: "pg-csrf-1", body: { orderId: co.body.order.id, token: co.body.token } })).status, 200);
  const pgSnap2 = await pgStore.snapshot();
  assert.equal(pgSnap2.storeOrders.find((o) => o.id === co.body.order.id).customerId, "pg-c1");
});
