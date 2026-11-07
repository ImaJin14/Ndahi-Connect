import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createHomeService } from "../lib/home-service.mjs";
import { createStore } from "../lib/api/state.mjs";
import { homeGatewayCheckIds } from "../lib/home-compatibility.mjs";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";

test("production enrollment fails before challenge/router writes when Home indexes are unverified", async () => {
  const store = createStore({ persistent: false }); let writes = 0;
  const service = createHomeService({ store, env: { NODE_ENV: "production", NDAHI_HOME_ENABLED: "true" },
    router: { async beginHomeEnrollment() { writes++; } } });
  await assert.rejects(service.begin("c1", "s1"), { code: "HOME_DATABASE_UNVERIFIED" });
  assert.equal((await store.snapshot()).homeChallenges.length, 0); assert.equal(writes, 0);
  store.homeSchemaReadiness = async () => ({ status: "migration_required" });
  await assert.rejects(service.begin("c1", "s1"), { code: "HOME_DATABASE_UNVERIFIED" });
  assert.equal(writes, 0);
});

test("admin readiness/pilot imports keep role gates, run external reads after transaction and never expose gateway credentials", async () => {
  const origin = "http://admin.test", secret = randomUUID(); let inTransaction = false, inspections = 0;
  const f = await pairingFixture({ env: { NDAHI_HOME_ENABLED: "false", ADMIN_APP_URL: origin,
    ALLOWED_ADMIN_ORIGINS: origin, ADMIN_SESSION_SECRET: secret }, router: {
      async inspectHomeReadiness() {
        assert.equal(inTransaction, false); inspections++;
        return { status: "configuration_verified", password: "do-not-expose-gateway-secret",
          checks: homeGatewayCheckIds.map(id => ({ id, status: "passed" })) };
      },
    } });
  try {
    const transaction = f.store.transaction.bind(f.store);
    f.store.transaction = (fn, options) => transaction(async s => { inTransaction = true; try { return await fn(s); } finally { inTransaction = false; } }, options);
    f.store.homeSchemaReadiness = async () => { assert.equal(inTransaction, false); return { status: "ready", checks: [] }; };
    await f.store.transaction(s => {
      for (const role of ["owner", "operator", "auditor", "reseller"]) {
        s.adminUsers.push({ id: role, username: role, role, active: true });
        s.adminSessions.push({ userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() });
      }
    });
    const call = async (role, path, input, csrf = "csrf") => {
      const response = await fetch(f.api + path, { method: input ? "POST" : "GET", headers: { origin,
        cookie: `admin_session=${role}`, "content-type": "application/json", "x-csrf-token": csrf },
        ...(input ? { body: JSON.stringify(input) } : {}) });
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
    for (const role of ["auditor", "reseller"]) assert.equal((await call(role, "/api/admin/home/readiness")).status, 403);
    assert.equal(inspections, 0);
    const ready = await call("operator", "/api/admin/home/readiness");
    assert.equal(ready.status, 200); assert.equal(ready.body.database.status, "ready");
    assert.equal(ready.body.gateway.status, "configuration_verified");
    assert.equal(ready.body.nativePilot, "pending"); assert.equal(ready.body.enabled, false);
    assert.equal(ready.headers.get("cache-control"), "no-store");
    assert.ok(!JSON.stringify(ready.body).includes("do-not-expose-gateway-secret"));
    const report = { version: 1, evidenceKind: "synthetic", credentials: "never-store-report-secrets" };
    const input = { report, reason: "Isolated synthetic test; not hardware acceptance" };
    assert.equal((await call("operator", "/api/admin/home/pilot", { report: null, reason: "invalid upload" })).status, 400);
    assert.equal((await call("operator", "/api/admin/home/pilot", input, "wrong")).status, 403);
    assert.equal((await call("reseller", "/api/admin/home/pilot", input)).status, 403);
    assert.equal((await call("operator", "/api/admin/home/pilot", input)).status, 201);
    assert.equal((await call("operator", "/api/admin/home/pilot", input)).body.replayed, true);
    const state = await f.store.snapshot();
    assert.equal(state.homeUsageObservations.filter(o => o.type === "pilot.report").length, 1);
    assert.ok(!JSON.stringify(state).includes("never-store-report-secrets"));
    assert.equal(state.vouchers.length, 1); assert.equal(state.vouchers[0].usedBytes, 20);
  } finally { await f.close(); }
});
