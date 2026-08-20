import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { totpCode } from "../lib/security.mjs";
async function listen(server) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${server.address().port}`;
}
async function setup() {
  const store = createStore({ persistent: false }),
    server = createServer({
      store,
      env: {
        PAYMENT_MODE: "mock",
        OTP_DELIVERY: "mock",
        SESSION_COOKIE_SECURE: "false",
        CUSTOMER_SESSION_SECRET: "customer-secret",
        ADMIN_SESSION_SECRET: "admin-secret",
        ADMIN_PIN: "9999",
        CUSTOMER_APP_URL: "http://customer.test",
        ADMIN_APP_URL: "http://admin.test",
        ALLOWED_ADMIN_ORIGINS: "http://admin.test",
      },
    }),
    base = await listen(server);
  async function req(path, { method = "GET", body, cookie, origin } = {}) {
    const response = await fetch(base + path, {
        method,
        headers: {
          "content-type": "application/json",
          ...(cookie ? { cookie } : {}),
          ...(origin ? { origin } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      }),
      json = await response.json();
    return {
      response,
      json,
      cookie: response.headers.get("set-cookie")?.split(";")[0],
    };
  }
  return { store, req, close: () => new Promise((r) => server.close(r)) };
}
async function customerSession(f) {
  const buy = await f.req("/api/purchase", {
      method: "POST",
      body: { phone: "670111111", name: "Customer", planId: "weekly" },
    }),
    paid = await f.req(`/api/payments/${buy.json.payment.id}/confirm`, {
      method: "POST",
    }),
    challenge = await f.req("/api/account/login/request-authenticator", {
      method: "POST",
      body: { phone: "670111111", code: paid.json.access.code },
    }),
    login = await f.req("/api/account/login/verify-authenticator", {
      method: "POST",
      body: {
        challengeId: challenge.json.challengeId,
        otp: totpCode(challenge.json.secret),
      },
    });
  return login.cookie;
}
test("customer application has no admin dashboard route or admin assets", async (t) => {
  const server = createStaticServer("customer"), base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  assert.equal((await fetch(base + "/admin")).status, 404);
  const home = await (await fetch(base + "/")).text();
  assert.doesNotMatch(home, /administrat|api\/admin/i);
});
test("role cookies are isolated, origins enforced, and logout targets the correct session", async (t) => {
  const f = await setup();
  t.after(f.close);
  const customerCookie = await customerSession(f);
  assert.match(customerCookie, /^customer_session=/);
  assert.equal(
    (await f.req("/api/admin/dashboard", {
      cookie: customerCookie,
      origin: "http://admin.test",
    })).response.status,
    401,
  );
  assert.equal(
    (await f.req("/api/admin/dashboard", {
      cookie: customerCookie,
      origin: "http://customer.test",
    })).response.status,
    403,
  );
  const adminLogin = await f.req("/api/admin/login", {
      method: "POST",
      body: { pin: "9999" },
      origin: "http://admin.test",
    }),
    adminCookie = adminLogin.cookie;
  assert.match(adminCookie, /^admin_session=/);
  assert.equal(
    (await f.req("/api/account/dashboard", {
      cookie: adminCookie,
      origin: "http://customer.test",
    })).response.status,
    401,
  );
  assert.equal(
    (await f.req("/api/admin/dashboard", {
      cookie: adminCookie,
      origin: "http://admin.test",
    })).response.status,
    200,
  );
  await f.req("/api/account/logout", {
    method: "POST",
    body: {},
    cookie: customerCookie,
    origin: "http://customer.test",
  });
  assert.equal(
    (await f.req("/api/account/dashboard", {
      cookie: customerCookie,
      origin: "http://customer.test",
    })).response.status,
    401,
  );
  assert.equal(
    (await f.req("/api/admin/dashboard", {
      cookie: adminCookie,
      origin: "http://admin.test",
    })).response.status,
    200,
  );
  await f.req("/api/admin/logout", {
    method: "POST",
    body: {},
    cookie: adminCookie,
    origin: "http://admin.test",
  });
  assert.equal(
    (await f.req("/api/admin/dashboard", {
      cookie: adminCookie,
      origin: "http://admin.test",
    })).response.status,
    401,
  );
});
test("admin login is rate limited and security actions are audited", async (t) => {
  const f = await setup();
  t.after(f.close);
  for (let i = 0; i < 5; i++) {
    assert.equal(
      (await f.req("/api/admin/login", {
        method: "POST",
        body: { pin: "wrong" },
        origin: "http://admin.test",
      })).response.status,
      401,
    );
  }
  assert.equal(
    (await f.req("/api/admin/login", {
      method: "POST",
      body: { pin: "wrong" },
      origin: "http://admin.test",
    })).response.status,
    429,
  );
  const state = await f.store.snapshot();
  assert.equal(
    state.auditLogs.filter((x) => x.action === "admin.login.failed").length,
    5,
  );
  assert.equal(state.auditLogs.at(0).action, "admin.login.rate_limited");
});
test("session cookies carry the required security attributes", async (t) => {
  const f = await setup();
  t.after(f.close);
  const login = await f.req("/api/admin/login", {
      method: "POST",
      body: { pin: "9999" },
      origin: "http://admin.test",
    }),
    header = login.response.headers.get("set-cookie");
  assert.match(header, /admin_session=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  const productionStore = createStore({ persistent: false }),
    server = createServer({
      store: productionStore,
      validateConfig: false,
      env: {
        NODE_ENV: "production",
        ADMIN_PIN: "9999",
        ADMIN_SESSION_SECRET: "admin-secret",
        CUSTOMER_SESSION_SECRET: "customer-secret",
        ALLOWED_ADMIN_ORIGINS: "https:\/\/admin.ndahiconnect.net",
      },
    }),
    base = await listen(server);
  t.after(() => new Promise((r) => server.close(r)));
  const r = await fetch(base + "/api/admin/login", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "origin": "https://admin.ndahiconnect.net",
    },
    body: JSON.stringify({ pin: "9999" }),
  });
  assert.match(r.headers.get("set-cookie"), /Secure/);
});
test("administrators can create, read, update and delete custom bundles", async (t) => {
  const f = await setup();
  t.after(f.close);
  const login = await f.req("/api/admin/login", {
      method: "POST",
      body: { pin: "9999" },
      origin: "http://admin.test",
    }),
    cookie = login.cookie,
    admin = { cookie, origin: "http://admin.test" };
  const created = await f.req("/api/admin/bundles", {
    ...admin,
    method: "POST",
    body: {
      name: "Exam Week",
      price: 750,
      quotaGb: 8,
      validityHours: 168,
      deviceLimit: 2,
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(created.json.bundle.custom, true);
  const listed = await f.req("/api/admin/dashboard", admin);
  assert.ok(
    listed.json.bundles.some((bundle) => bundle.id === created.json.bundle.id),
  );
  const updated = await f.req("/api/admin/bundles/update", {
    ...admin,
    method: "POST",
    body: {
      bundleId: created.json.bundle.id,
      name: "Exam Week Plus",
      price: 900,
      quotaGb: 10,
      validityHours: 240,
      deviceLimit: 3,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.bundle.name, "Exam Week Plus");
  assert.equal(updated.json.bundle.deviceLimit, 3);
  const deleted = await f.req("/api/admin/bundles/delete", {
    ...admin,
    method: "POST",
    body: { bundleId: created.json.bundle.id },
  });
  assert.equal(deleted.response.status, 200);
  const final = await f.req("/api/admin/dashboard", admin);
  assert.ok(
    !final.json.bundles.some((bundle) => bundle.id === created.json.bundle.id),
  );
  const actions = (await f.store.snapshot()).auditLogs.map((entry) =>
    entry.action
  );
  assert.ok(actions.includes("bundle.created"));
  assert.ok(actions.includes("bundle.updated"));
  assert.ok(actions.includes("bundle.deleted"));
});
test("administrators can edit built-in bundles", async (t) => {
  const f = await setup();
  t.after(f.close);
  const login = await f.req("/api/admin/login", {
      method: "POST",
      body: { pin: "9999" },
      origin: "http://admin.test",
    }),
    admin = { cookie: login.cookie, origin: "http://admin.test" };
  const updated = await f.req("/api/admin/bundles/update", {
    ...admin,
    method: "POST",
    body: {
      bundleId: "daily",
      name: "Daily Flex",
      price: 150,
      quotaGb: 2,
      validityHours: 36,
      deviceLimit: 2,
    },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.json.bundle.name, "Daily Flex");
  const dashboard = await f.req("/api/admin/dashboard", admin);
  assert.equal(
    dashboard.json.bundles.find((bundle) => bundle.id === "daily").price,
    150,
  );
  const state = await f.store.snapshot();
  assert.equal(state.bundleOverrides.daily.name, "Daily Flex");
  assert.ok(
    state.auditLogs.some((entry) =>
      entry.action === "bundle.updated" && entry.meta.bundleId === "daily"
    ),
  );
});
