import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

const origin = "http://admin.local";
const at = "2026-11-16T10:00:00.000Z";

test("authenticated reseller actions pass the central gate without expanding other roles", async (t) => {
  const store = createStore({ persistent: false });
  const secret = randomUUID();
  const actors = ["owner", "operator", "auditor", "reseller", "other"];
  const tokens = Object.fromEntries(actors.map((name) => [name, randomUUID()]));
  await store.transaction((s) => {
    s.zone.authenticatorRetirement = { version: 1 };
    for (const name of actors) {
      const role = name === "other" ? "reseller" : name;
      s.adminUsers.push({ id: name, username: name, active: true, role, passkeys: [] });
      s.adminSessions.push({ userId: name, role, tokenHash: hashSecret(tokens[name], secret), csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" });
    }
    s.vouchers.push({ id: "voucher-one", code: "NC-AAAA-BBBB", assignedResellerId: "reseller", generatedByAdmin: true, status: "available", faceValue: 500, saleType: "sold" });
  });
  const server = createServer({ store, now: () => new Date(at), validateConfig: false, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
    BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", PAYMENT_WEBHOOK_WORKER_ENABLED: "false",
    SESSION_COOKIE_SECURE: "false", ADMIN_SESSION_SECRET: secret, ADMIN_APP_URL: origin, ALLOWED_ADMIN_ORIGINS: origin,
  }});
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  async function call(actor, path, input, csrf = "csrf", method = "POST") {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { cookie: `admin_session=${tokens[actor]}`, origin, "content-type": "application/json", "x-csrf-token": csrf },
      ...(method === "POST" ? { body: JSON.stringify(input) } : {}),
    });
    return { status: response.status, body: await response.json() };
  }
  const sale = { voucherId: "voucher-one", operationKey: "sale-operation-123456789" };
  assert.equal((await call("reseller", "/api/admin/resellers/cash-sale", sale, "bad")).status, 403);
  assert.equal((await call("other", "/api/admin/resellers/cash-sale", sale)).status, 404);
  for (const actor of ["owner", "operator", "auditor"]) assert.equal((await call(actor, "/api/admin/resellers/cash-sale", sale)).status, 403);
  assert.equal((await call("reseller", "/api/admin/resellers/cash-sale", sale)).status, 201);
  const reclassify = await call("owner", "/api/admin/vouchers/classify", { voucherId: "voucher-one", saleType: "gift" });
  assert.equal(reclassify.status, 409);
  assert.equal(reclassify.body.code, "LEDGER_ADJUSTMENT_REQUIRED");
  const replay = await call("reseller", "/api/admin/resellers/cash-sale", sale);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal((await call("reseller", "/api/admin/resellers/stock-requests", { operationKey: "request-operation-123456" })).status, 201);
  assert.equal((await call("reseller", "/api/admin/resellers/commission", { resellerId: "reseller", commissionPercent: 50 })).status, 403);
  assert.equal((await call("auditor", "/api/admin/resellers/stock-requests", { operationKey: "auditor-operation-12345" })).status, 403);
});
