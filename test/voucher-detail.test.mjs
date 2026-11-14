// The voucher detail page's data (#258, redesign AdminVoucherDetail): history
// from the audit trail and the voucher's own times, router sync, and the code
// with its QR only for roles that may see codes.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

const secret = "voucher-detail-secret", at = (iso) => new Date(iso).toISOString();

test("the detail adds history, router sync and the code with its QR for code roles", async (t) => {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.customers.push({ id: "c1", name: "J. Fon", phone: "670004019" });
    s.vouchers.unshift({ id: "v1", customerId: "c1", planId: "weekly", code: "K7PM-42XQ", status: "revoked", saleType: "gift", saleAmount: 0, faceValue: 1000,
      createdAt: at("2026-10-29T10:12:00Z"), activatedAt: at("2026-11-08T18:03:00Z"), expiresAt: at("2026-11-15T18:03:00Z"), quotaBytes: 5e9, usedBytes: 1.8e9,
      deviceLimit: 3, generatedByAdmin: true, emailStatus: "sent", emailSentAt: at("2026-11-08T18:04:00Z"), routerSyncStatus: "pending",
      wifiDevices: [{ mac: "AA:BB:CC:DD:EE:01" }, { mac: "AA:BB:CC:DD:EE:02" }] });
    s.auditLogs.unshift(
      { id: "a3", action: "voucher.revoked", actor: "owner", meta: { voucherId: "v1" }, at: at("2026-11-13T09:00:00Z") },
      { id: "a2", action: "voucher.sale_classified", actor: "operator", meta: { voucherId: "v1", previous: "sold", saleType: "gift" }, at: at("2026-11-09T08:00:00Z") },
      { id: "a1", action: "voucher.generated", actor: "owner", meta: { voucherIds: ["v1", "v2"], quantity: 2, saleType: "sold", customerId: "c1" }, at: at("2026-10-29T10:12:00Z") },
      { id: "a0", action: "voucher.revoked", actor: "owner", meta: { voucherId: "other" }, at: at("2026-11-01T00:00:00Z") });
    s.routerCommands.push({ id: "router:disconnect_voucher:v1", action: "disconnect_voucher", targetId: "v1", status: "queued", at: at("2026-11-13T09:00:00Z") });
    for (const role of ["owner", "operator", "auditor", "reseller"]) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, displayName: role[0].toUpperCase() + role.slice(1), role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `staff-${role}`, role, tokenHash: hashSecret(`token-${role}`, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, CUSTOMER_APP_URL: "https://portal.example.test",
    ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (role, query = "?full=1") => {
    const r = await fetch(`${base}/api/admin/vouchers/v1/details${query}`, { headers: { cookie: `admin_session=token-${role}`, origin: "http://admin.test" } });
    return { status: r.status, body: await r.json() };
  };
  const owner = await get("owner");
  assert.equal(owner.status, 200);
  const d = owner.body.detail;
  assert.equal(d.code, "K7PM-42XQ");
  assert.match(d.qr, /^data:image\/png;base64,/);
  assert.deepEqual(d.history.map((e) => [e.kind, e.by ?? null]), [["created", "Owner"], ["redeemed", null], ["classified", "Operator"], ["revoked", "Owner"]]);
  assert.deepEqual([d.history[0].quantity, d.history[0].saleType, d.history[1].customer, d.history[2].saleType], [2, "sold", "J. Fon", "gift"]);
  assert.deepEqual([d.saleType, d.activeDevices, d.email.status], ["gift", 2, "sent"]);
  assert.deepEqual(d.routerSync, { status: "pending", action: "disconnect_voucher", commandStatus: "queued", result: null, at: at("2026-11-13T09:00:00Z") });
  const auditor = await get("auditor");
  assert.equal(auditor.status, 200);
  assert.equal(auditor.body.detail.code, undefined, "auditors do not see codes");
  assert.equal(auditor.body.detail.qr, undefined);
  assert.equal(auditor.body.detail.history[1].customer, undefined, "nor customer names");
  assert.equal((await get("reseller")).status, 404, "a reseller reads only their own stock");
  const plain = await get("owner", "");
  assert.equal(plain.body.detail, undefined, "the existing inline details are unchanged");
});
