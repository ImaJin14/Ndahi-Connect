import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore, plans } from "../server.mjs";
import { activationCode, hashSecret, normalizeActivationCode, totpCode, totpSecret } from "../lib/security.mjs";
import { migrateVoucherCodes } from "../lib/voucher-migration.mjs";
async function fixture(options = {}) {
  const store = createStore({ persistent: false }),
    server = createServer({
      store,
      router: options.router,
      omada: options.omada,
      email: options.email,
      now: options.now,
      env: {
        PAYMENT_MODE: "mock",
        OTP_DELIVERY: "mock",
        SECRET_PEPPER: "test-pepper",
        CUSTOMER_SESSION_SECRET: "customer-test-secret",
        ADMIN_SESSION_SECRET: "admin-test-secret",
        SESSION_COOKIE_SECURE: "false",
        CUSTOMER_APP_URL: "http://customer.test",
        ADMIN_APP_URL: "http://admin.test",
        ALLOWED_ADMIN_ORIGINS: "http://admin.test",
        ADMIN_PIN: "9999",
        ...options.env,
      },
    });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`, jar = {};
  const call = async (path, method = "GET", data, _token, extra = {}) => {
    const cookie = extra.cookie ?? Object.values(jar).join("; "),
      response = await fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(extra.origin ? { origin: extra.origin } : {}),
        },
        body: data ? JSON.stringify(data) : undefined,
      }),
      set = response.headers.get("set-cookie");
    if (set) {
      const pair = set.split(";")[0], name = pair.split("=")[0];
      jar[name] = pair;
    }
    const json = await response.json();
    return { response, json, setCookie: set };
  };
  return {
    store,
    call,
    jar,
    base,
    close: () => new Promise((r) => server.close(r)),
  };
}
test("catalogue contains the required prices, quotas, validity and device limits", () => {
  assert.deepEqual(plans.map((x) => x.price), [
    100,
    500,
    2000,
    5500,
    10000,
    12500,
    15000,
    30000,
  ]);
  assert.deepEqual(plans.map((x) => x.deviceLimit), [
    1,
    1,
    1,
    2,
    3,
    3,
    4,
    6,
  ]);
  assert.equal(plans.at(-1).quotaGb, null);
});
test("activation codes are fixed-length, human-readable, unique and opaque", () => {
  const codes = new Set(Array.from({ length: 1000 }, activationCode));
  assert.equal(codes.size, 1000);
  assert.match([...codes][0], /^NC-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal([...codes][0].length, 12);
  assert.equal(normalizeActivationCode("nc abcd 5678"), "NC-ABCD-5678");
  assert.notEqual(hashSecret("123456", "pepper"), "123456");
});
test("verified payment emails the voucher and delivery failure never reverses payment", async (t) => {
  const sent = [], successful = await fixture({
    email: {
      configured: () => true,
      sendVoucher: async (message) => {
        sent.push(message);
        return { messageId: "email-success" };
      },
    },
  });
  t.after(successful.close);
  const purchase = await successful.call("/api/purchase", "POST", {
    name: "Ada", phone: "670000009", email: "ada@example.com", planId: "weekly",
  });
  const confirmed = await successful.call(`/api/payments/${purchase.json.payment.id}/confirm`, "POST");
  assert.equal(confirmed.response.status, 200);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].voucher.code, confirmed.json.access.code);
  assert.equal((await successful.store.snapshot()).vouchers[0].emailStatus, "sent");

  const failed = await fixture({
    email: {
      configured: () => true,
      sendVoucher: async () => { throw new Error("Temporary mail outage"); },
    },
  });
  t.after(failed.close);
  const secondPurchase = await failed.call("/api/purchase", "POST", {
    name: "Grace", phone: "670000008", email: "grace@example.com", planId: "weekly",
  });
  const secondConfirmation = await failed.call(`/api/payments/${secondPurchase.json.payment.id}/confirm`, "POST");
  assert.equal(secondConfirmation.response.status, 200);
  const state = await failed.store.snapshot();
  assert.equal(state.payments[0].status, "paid");
  assert.equal(state.vouchers[0].status, "active");
  assert.equal(state.vouchers[0].emailStatus, "failed");
  assert.equal(state.vouchers[0].emailAttempts, 1);
});
test("payment, binding, limits, disconnect reuse, OTP and dashboard security", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const buy = await f.call("/api/purchase", "POST", {
    name: "Ada",
    phone: "670000001",
    planId: "connect30",
    provider: "mtn",
  });
  assert.equal(buy.response.status, 201);
  const paid = await f.call(
    `/api/payments/${buy.json.payment.id}/confirm`,
    "POST",
  );
  assert.equal(paid.response.status, 200);
  assert.match(paid.json.access.code, /^NC-[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  const paymentStatus = await f.call(
    `/api/payments/${buy.json.payment.id}/status`,
  );
  assert.equal(paymentStatus.response.status, 200);
  assert.equal(paymentStatus.json.payment.status, "paid");
  assert.equal(paymentStatus.json.access.code, paid.json.access.code);
  const duplicate = await f.call(
    `/api/payments/${buy.json.payment.id}/confirm`,
    "POST",
  );
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.json.idempotent, true);
  const wrongCode = await f.call("/api/vouchers/redeem", "POST", {
    phone: "670000001",
    code: "NC-WRONG",
    deviceId: "x",
  });
  assert.equal(wrongCode.response.status, 401);
  const wrongPhone = await f.call("/api/vouchers/redeem", "POST", {
    phone: "670000002",
    code: paid.json.access.code,
    deviceId: "x",
  });
  assert.equal(wrongPhone.response.status, 401);
  const one = await f.call("/api/vouchers/redeem", "POST", {
      phone: "670000001",
      code: paid.json.access.code.toLowerCase().replaceAll("-", ""),
      deviceId: "one",
    }),
    two = await f.call("/api/vouchers/redeem", "POST", {
      phone: "670000001",
      code: paid.json.access.code,
      deviceId: "two",
    }),
    three = await f.call("/api/vouchers/redeem", "POST", {
      phone: "670000001",
      code: paid.json.access.code,
      deviceId: "three",
    });
  assert.equal(one.response.status, 200);
  assert.equal(two.response.status, 200);
  assert.equal(three.response.status, 409);
  const customerTotp = totpSecret();
  await f.store.transaction((state) => {
    state.customers.find((customer) => customer.phone === "670000001").totpSecret = customerTotp;
  });
  const otp = await f.call("/api/account/login/request-authenticator", "POST", {
    phone: "670000001",
    code: paid.json.access.code,
  });
  assert.equal(otp.response.status, 200);
  const snapshot = await f.store.snapshot();
  assert.equal(snapshot.otpChallenges[0].enrollmentSecret, undefined);
  const bad = await f.call("/api/account/login/verify-authenticator", "POST", {
    challengeId: otp.json.challengeId,
    otp: "000000",
  });
  assert.equal(bad.response.status, 401);
  const verified = await f.call("/api/account/login/verify-authenticator", "POST", {
    challengeId: otp.json.challengeId,
    otp: totpCode(customerTotp),
  });
  assert.equal(verified.response.status, 200);
  const returning = await f.call(
    "/api/account/login/request-authenticator",
    "POST",
    { phone: "670000001" },
  );
  assert.equal(returning.response.status, 200);
  assert.equal(returning.json.enrollmentRequired, false);
  assert.equal(returning.json.secret, undefined);
  assert.equal((await f.call(
    "/api/account/login/verify-authenticator",
    "POST",
    { challengeId: returning.json.challengeId, otp: totpCode(customerTotp) },
  )).response.status, 200);
  const reused = await f.call("/api/account/login/verify-authenticator", "POST", {
    challengeId: otp.json.challengeId,
    otp: totpCode(customerTotp),
  });
  assert.equal(reused.response.status, 401);
  const dash = await f.call(
    "/api/account/dashboard",
    "GET",
    null,
    verified.json.token,
  );
  assert.equal(dash.json.activeBundle.activeDevices, 2);
  const disconnected = await f.call("/api/account/devices/disconnect", "POST", {
    sessionId: dash.json.activeBundle.sessions[0].id,
  }, verified.json.token);
  assert.equal(disconnected.response.status, 200);
  const reuse = await f.call("/api/vouchers/redeem", "POST", {
    phone: "670000001",
    code: paid.json.access.code,
    deviceId: "three",
  });
  assert.equal(reuse.response.status, 200);
  const exposed = await f.call("/api/account?phone=670000001");
  assert.equal(exposed.response.status, 404);
});
test("stacking and Daily same-day renewal are rejected; exhausted non-daily renews", async (t) => {
  const f = await fixture();
  t.after(f.close);
  async function purchase(phone, planId) {
    const b = await f.call("/api/purchase", "POST", {
      name: "Test",
      phone,
      planId,
    });
    if (b.response.status !== 201) return b;
    return f.call(`/api/payments/${b.json.payment.id}/confirm`, "POST");
  }
  const first = await purchase("670000010", "weekly");
  assert.equal(first.response.status, 200);
  assert.equal(
    (await f.call("/api/purchase", "POST", {
      phone: "670000010",
      planId: "monthly",
    })).response.status,
    409,
  );
  await f.store.transaction((s) => {
    s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes;
  });
  const renewed = await purchase("670000010", "monthly");
  assert.equal(renewed.response.status, 200);
  const daily = await purchase("670000020", "daily");
  assert.equal(daily.response.status, 200);
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) =>
      x.customerId === s.customers.find((c) => c.phone === "670000020").id
    );
    v.usedBytes = v.quotaBytes;
  });
  assert.equal(
    (await f.call("/api/purchase", "POST", {
      phone: "670000020",
      planId: "daily",
    })).response.status,
    409,
  );
});
test("authenticator login throttles requests and locks after five incorrect attempts", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const b = await f.call("/api/purchase", "POST", {
      phone: "670000030",
      planId: "weekly",
    }),
    p = await f.call(`/api/payments/${b.json.payment.id}/confirm`, "POST"),
    credentials = { phone: "670000030", code: p.json.access.code },
    customerTotp = totpSecret();
  await f.store.transaction((state) => {
    state.customers.find((customer) => customer.phone === credentials.phone).totpSecret = customerTotp;
  });
  let ch;
  for (let i = 0; i < 5; i++) {
    ch = await f.call("/api/account/login/request-authenticator", "POST", credentials);
  }
  assert.equal(
    (await f.call("/api/account/login/request-authenticator", "POST", credentials))
      .response.status,
    429,
  );
  for (let i = 0; i < 5; i++) {
    await f.call("/api/account/login/verify-authenticator", "POST", {
      challengeId: ch.json.challengeId,
      otp: "111111",
    });
  }
  assert.equal(
    (await f.call("/api/account/login/verify-authenticator", "POST", {
      challengeId: ch.json.challengeId,
      otp: totpCode(customerTotp),
    })).response.status,
    401,
  );
});
test("voucher expiry and dashboard session expiry are enforced", async (t) => {
  let current = new Date("2026-08-19T10:00:00Z");
  const f = await fixture({ now: () => new Date(current) });
  t.after(f.close);
  const b = await f.call("/api/purchase", "POST", {
      phone: "670000040",
      planId: "weekly",
    }),
    p = await f.call(`/api/payments/${b.json.payment.id}/confirm`, "POST"),
    credentials = { phone: "670000040", code: p.json.access.code },
    customerTotp = totpSecret();
  await f.store.transaction((state) => {
    state.customers.find((customer) => customer.phone === credentials.phone).totpSecret = customerTotp;
  });
  const otp = await f.call("/api/account/login/request-authenticator", "POST", credentials),
    login = await f.call("/api/account/login/verify-authenticator", "POST", {
      challengeId: otp.json.challengeId,
      otp: totpCode(customerTotp, current.getTime()),
    });
  current = new Date(current.getTime() + 31 * 60_000);
  assert.equal(
    (await f.call("/api/account/dashboard", "GET", null, login.json.token))
      .response.status,
    401,
  );
  current = new Date("2026-08-27T10:00:00Z");
  const expired = await f.call("/api/vouchers/redeem", "POST", {
    ...credentials,
    deviceId: "late",
  });
  assert.equal(expired.response.status, 409);
  assert.match(expired.json.error, /expired/);
});

test("new customers create a hashed 4-digit PIN and PIN login is rate limited", async (t) => {
  const f = await fixture();
  t.after(f.close);
  const purchase = await f.call("/api/purchase", "POST", {
      phone: "670000041", planId: "weekly",
    }),
    paid = await f.call(`/api/payments/${purchase.json.payment.id}/confirm`, "POST");
  assert.equal((await f.call("/api/account/setup/pin", "POST", {
    phone: "670000041", code: paid.json.access.code, pin: "1234", confirmPin: "4321",
  })).response.status, 400);
  assert.equal((await f.call("/api/account/setup/pin", "POST", {
    phone: "670000041", code: paid.json.access.code, pin: "12ab", confirmPin: "12ab",
  })).response.status, 400);
  const setup = await f.call("/api/account/setup/pin", "POST", {
    phone: "670000041", code: paid.json.access.code, pin: "1234", confirmPin: "1234",
  });
  assert.equal(setup.response.status, 200);
  const state = await f.store.snapshot();
  assert.notEqual(state.customers[0].pinHash, "1234");
  assert.match(state.customers[0].pinHash, /^\$argon2id\$/);
  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.json.customer.pinHash, undefined);
  assert.equal(dashboard.json.customer.pinConfigured, true);
  assert.equal(dashboard.json.customer.authenticatorEnrolled, false);
  const enrollment = await f.call("/api/account/security/mfa/enroll", "POST", {});
  assert.equal((await f.call("/api/account/security/mfa/confirm", "POST", {
    challengeId: enrollment.json.challengeId,
    code: totpCode(enrollment.json.secret),
  })).response.status, 200);
  assert.equal((await f.call("/api/account/dashboard")).json.customer.authenticatorEnrolled, true);
  await f.call("/api/account/logout", "POST", {});
  assert.equal((await f.call("/api/account/login/pin", "POST", {
    phone: "670000041", pin: "1234",
  })).response.status, 200);
  for (let attempt = 0; attempt < 5; attempt++) {
    await f.call("/api/account/login/pin", "POST", { phone: "670000041", pin: "9999" });
  }
  assert.equal((await f.call("/api/account/login/pin", "POST", {
    phone: "670000041", pin: "1234",
  })).response.status, 429);
});

test("forgot PIN uses a single-use emailed token and invalidates existing sessions", async (t) => {
  let resetToken;
  const f = await fixture({
    email: {
      configured: () => true,
      sendVoucher: async () => ({ messageId: "voucher-email" }),
      sendPinReset: async ({ token }) => {
        resetToken = token;
        return { messageId: "reset-email" };
      },
    },
  });
  t.after(f.close);
  const purchase = await f.call("/api/purchase", "POST", {
      phone: "670000045", email: "reset@example.com", planId: "weekly",
    }),
    paid = await f.call(`/api/payments/${purchase.json.payment.id}/confirm`, "POST");
  await f.call("/api/account/setup/pin", "POST", {
    phone: "670000045", code: paid.json.access.code, pin: "1234", confirmPin: "1234",
  });
  const oldCookie = f.jar.customer_session;
  const requested = await f.call("/api/account/pin-reset/request", "POST", { phone: "670000045" });
  assert.equal(requested.response.status, 202);
  assert.ok(resetToken);
  const stored = await f.store.snapshot();
  assert.notEqual(stored.pinResetChallenges[0].tokenHash, resetToken);
  assert.equal((await f.call("/api/account/pin-reset/confirm", "POST", {
    token: resetToken, pin: "5678", confirmPin: "8765",
  })).response.status, 400);
  assert.equal((await f.call("/api/account/pin-reset/confirm", "POST", {
    token: resetToken, pin: "5678", confirmPin: "5678",
  })).response.status, 200);
  assert.equal((await f.call("/api/account/dashboard", "GET", null, null, {
    cookie: oldCookie,
  })).response.status, 401);
  assert.equal((await f.call("/api/account/login/pin", "POST", {
    phone: "670000045", pin: "1234",
  })).response.status, 401);
  assert.equal((await f.call("/api/account/login/pin", "POST", {
    phone: "670000045", pin: "5678",
  })).response.status, 200);
  assert.equal((await f.call("/api/account/pin-reset/confirm", "POST", {
    token: resetToken, pin: "9999", confirmPin: "9999",
  })).response.status, 401);
  const unknown = await f.call("/api/account/pin-reset/request", "POST", { phone: "670999999" });
  assert.equal(unknown.response.status, 202);
  assert.equal(unknown.json.message, requested.json.message);
});

test("Daily has a rolling seven-day cooldown and keeps 24-hour validity", async (t) => {
  let current = new Date("2026-09-07T10:00:00Z");
  const f = await fixture({ now: () => new Date(current) });
  t.after(f.close);
  const first = await f.call("/api/purchase", "POST", { phone: "670000042", planId: "daily" }),
    paid = await f.call(`/api/payments/${first.json.payment.id}/confirm`, "POST");
  assert.equal(+new Date(paid.json.voucher.expiresAt) - +new Date(paid.json.voucher.activatedAt), 24 * 36e5);
  current = new Date("2026-09-08T10:01:00Z");
  const blocked = await f.call("/api/purchase", "POST", { phone: "670000042", planId: "daily" });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.json.nextEligibleAt, "2026-09-14T10:00:00.000Z");
  current = new Date("2026-09-14T10:00:00Z");
  assert.equal((await f.call("/api/purchase", "POST", {
    phone: "670000042", planId: "daily",
  })).response.status, 201);
  const pendingOnly = await f.call("/api/purchase", "POST", { phone: "670000043", planId: "daily" });
  await f.store.transaction((state) => { state.payments.find((x) => x.id === pendingOnly.json.payment.id).status = "failed"; });
  assert.equal((await f.call("/api/purchase", "POST", {
    phone: "670000043", planId: "daily",
  })).response.status, 201);
});

test("discontinued plans are historical-only and account renewal/switching is idempotent", async (t) => {
  const f = await fixture();
  t.after(f.close);
  for (const planId of ["plus", "connect20"]) {
    assert.equal((await f.call("/api/purchase", "POST", {
      phone: "670000044", planId,
    })).response.status, 400);
  }
  const catalogue = await f.call("/api/plans");
  assert.ok(!catalogue.json.plans.some((plan) => [3000, 4000].includes(plan.price)));
  const purchase = await f.call("/api/purchase", "POST", { phone: "670000044", planId: "weekly" }),
    paid = await f.call(`/api/payments/${purchase.json.payment.id}/confirm`, "POST");
  await f.call("/api/account/setup/pin", "POST", {
    phone: "670000044", code: paid.json.access.code, pin: "2468", confirmPin: "2468",
  });
  const renewal = await f.call("/api/account/plan/purchase", "POST", {
    planId: "weekly", action: "renew", requestKey: "renew-1",
  });
  const duplicate = await f.call("/api/account/plan/purchase", "POST", {
    planId: "weekly", action: "renew", requestKey: "renew-1",
  });
  assert.equal(renewal.response.status, 201);
  assert.equal(duplicate.response.status, 200);
  assert.equal(duplicate.json.payment.id, renewal.json.payment.id);
  assert.equal((await f.call(`/api/payments/${renewal.json.payment.id}/confirm`, "POST")).response.status, 200);
  const switched = await f.call("/api/account/plan/purchase", "POST", {
    planId: "monthly", action: "switch", requestKey: "switch-1",
  });
  assert.equal(switched.response.status, 201);
  assert.equal((await f.call(`/api/payments/${switched.json.payment.id}/confirm`, "POST")).response.status, 200);
  const state = await f.store.snapshot();
  state.vouchers.push({
    id: "historic-3k", customerId: state.customers[0].id, planId: "plus",
    status: "expired", activatedAt: "2025-01-01T00:00:00.000Z",
    expiresAt: "2025-02-01T00:00:00.000Z", quotaBytes: 15e9, usedBytes: 15e9,
    deviceLimit: 1,
  });
  await f.store.transaction((stored) => stored.vouchers = state.vouchers);
  const dashboard = await f.call("/api/account/dashboard");
  assert.ok(dashboard.json.vouchers.some((voucher) => voucher.plan.name === "Connect Plus"));
  assert.ok(!dashboard.json.availablePlans.some((plan) => plan.discontinued));
});

test("customer checkout supports administrator-created bundles", async (t) => {
  const f = await fixture();
  t.after(f.close);
  await f.store.transaction((state) => {
    state.bundles.push({
      id: "custom-campus-night",
      name: "Campus Night",
      price: 800,
      quotaGb: 12,
      validityHours: 12,
      deviceLimit: 2,
      custom: true,
    });
  });
  const purchase = await f.call("/api/purchase", "POST", {
    name: "Custom Customer",
    phone: "670000050",
    planId: "custom-campus-night",
  });
  assert.equal(purchase.response.status, 201);
  assert.equal(purchase.json.payment.amount, 800);
  const confirmed = await f.call(
    `/api/payments/${purchase.json.payment.id}/confirm`,
    "POST",
  );
  assert.equal(confirmed.response.status, 200);
  assert.equal(confirmed.json.voucher.plan.name, "Campus Night");
  assert.equal(confirmed.json.voucher.deviceLimit, 2);
});

test("admin usage synchronization updates quota monotonically", async (t) => {
  const router = {
    async readUsage() {
      return [{ voucherId: "usage-voucher", usedBytes: 750 }];
    },
    async syncVoucher() {},
    async disconnectDevice() {},
    async disconnectVoucher() {},
    async markInactive() {},
  };
  const f = await fixture({ router });
  t.after(f.close);
  await f.store.transaction((state) =>
    state.vouchers.push({
      id: "usage-voucher",
      customerId: "c",
      planId: "weekly",
      code: "x",
      status: "active",
      activatedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600000).toISOString(),
      quotaBytes: 1000,
      usedBytes: 100,
      deviceLimit: 1,
    })
  );
  const login = await f.call(
    "/api/admin/login",
    "POST",
    { pin: "9999" },
    null,
    { origin: "http://admin.test" },
  );
  const synced = await f.call(
    "/api/admin/integrations/sync-usage",
    "POST",
    {},
    null,
    { origin: "http://admin.test", cookie: login.setCookie.split(";")[0] },
  );
  assert.equal(synced.response.status, 200);
  assert.equal(synced.json.updated, 1);
  assert.equal((await f.store.snapshot()).vouchers[0].usedBytes, 750);
});

test("admin can generate custom resale vouchers that activate on first redemption", async (t) => {
  const synchronized = [], f = await fixture({
    router: {
      syncVoucher: async (voucher) => synchronized.push(voucher.id),
      disconnectVoucher: async () => {},
      disconnectDevice: async () => {},
      markInactive: async () => {},
      readUsage: async () => [],
    },
  });
  t.after(f.close);
  const login = await f.call("/api/admin/login", "POST", { pin: "9999" }, null, {
    origin: "http://admin.test",
  });
  const generated = await f.call("/api/admin/vouchers/generate", "POST", {
    purpose: "resale",
    planMode: "custom",
    name: "Reseller Weekend",
    price: "1500",
    quotaGb: "3",
    validityHours: "48",
    deviceLimit: "2",
    quantity: "2",
  }, null, { origin: "http://admin.test", cookie: login.setCookie.split(";")[0] });
  assert.equal(generated.response.status, 201);
  assert.equal(generated.json.vouchers.length, 2);
  assert.ok(generated.json.vouchers.every((voucher) =>
    voucher.status === "available" && voucher.customerId === null && voucher.expiresAt === null
  ));
  assert.equal(synchronized.length, 0);
  const redeemed = await f.call("/api/vouchers/redeem", "POST", {
    phone: "670222333",
    code: generated.json.vouchers[0].code.toLowerCase().replaceAll("-", ""),
    deviceId: "resale-phone",
  });
  assert.equal(redeemed.response.status, 200);
  assert.equal(redeemed.json.voucher.status, "active");
  assert.ok(redeemed.json.voucher.customerId);
  assert.ok(redeemed.json.voucher.expiresAt);
  assert.equal(synchronized.length, 1);
});
