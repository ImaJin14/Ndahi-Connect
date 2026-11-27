// The voucher page's data for Unlimited bundles (AdminVoucherDetail, #344;
// owner 26 Nov): the terms it carries, device slots in use (now, or every
// device that held one once ended), its batch, the date the code must be used
// by, and the device and place of the redemption; Resend receipt email sends
// a fresh delivery, or says why it can't.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore, plans } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { createTransactionalEmailService } from "../lib/transactional-email.mjs";
import { deviceKind } from "../lib/device-kind.mjs";

const secret = "voucher-detail-unlimited";
const env = { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: "https://portal.example.test", ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock",
  MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" };
const later = (days) => new Date(Date.now() + days * 864e5).toISOString();

async function start(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "staff-owner", username: "owner", displayName: "Owner", role: "owner", active: true, passkeys: [] });
    s.adminSessions.push({ userId: "staff-owner", role: "owner", tokenHash: hashSecret("token-owner", secret), csrfToken: "csrf-owner", expiresAt: "2099-01-01T00:00:00.000Z" });
    s.bundles.push({ id: "p2", name: "Week Unlimited", price: 3500, validityHours: 168, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaGb: null, status: "published", catalogue: "unlimited" });
    s.customers.push({ id: "c-fon", name: "J. Fon", phone: "670004019", email: "fon@example.test", emailVerifiedAt: later(-60) },
      { id: "c-noemail", name: "No Mail", phone: "670004020" },
      { id: "c-grace", name: "Grace T.", phone: "670004021", email: "grace@example.test", emailVerifiedAt: later(-30) });
    const base = { planId: "p2", generatedByAdmin: true, saleType: "gift", saleAmount: 0, faceValue: 3500, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2,
      validityHours: 168, quotaBytes: null, batchReference: "B-1127-01", createdAt: later(-10), useBy: later(80) };
    s.vouchers.push({ ...base, id: "u-active", code: "NC-K7PM-42XQ", status: "active", customerId: "c-fon", usedBytes: 0, activatedAt: later(-1), expiresAt: later(6),
      redeemedDevice: "android_phone", redeemedPlace: "AP-Market", emailStatus: "sent" },
    { ...base, id: "u-ended", code: "NC-U5ED-9XQA", status: "expired", customerId: "c-noemail", usedBytes: 0, activatedAt: later(-9), expiresAt: later(-2) },
    { ...base, id: "u-stock", code: "NC-S7CK-4ABC", status: "available", usedBytes: 0 });
    s.wifiDeviceGrants = [
      { id: "g1", customerId: "c-fon", voucherId: "u-active", mac: "AA:BB:CC:4F:A2:10", status: "approved", routerRevision: "" },
      { id: "g2", customerId: "c-fon", voucherId: "u-active", mac: "AA:BB:CC:19:C7:5E", status: "approved", routerRevision: "" },
      { id: "g3", customerId: "c-noemail", voucherId: "u-ended", mac: "AA:BB:CC:00:00:01", status: "revoked", routerRevision: "" },
      { id: "g4", customerId: "c-noemail", voucherId: "u-ended", mac: "AA:BB:CC:00:00:01", status: "approved", routerRevision: "" }];
  });
  const server = createServer({ store, validateConfig: false, env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const admin = async (path, input) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { cookie: "admin_session=token-owner", origin: "http://admin.test", "x-csrf-token": "csrf-owner",
      ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, base, admin };
}

test("the details carry the terms, slots used, the batch, the use-by date and where it was redeemed", async (t) => {
  const f = await start(t);
  const active = (await f.admin("/api/admin/vouchers/u-active/details?full=1")).body.detail;
  assert.deepEqual([active.accessType, active.deviceSlots, active.slotsUsed], ["personal_unlimited", 2, 2]);
  assert.deepEqual(active.batch, { reference: "B-1127-01", size: 3 });
  assert.equal(typeof active.validUntil, "string");
  const redeemed = active.history.find((e) => e.kind === "redeemed");
  assert.deepEqual([redeemed.customer, redeemed.device, redeemed.place, redeemed.emailed], ["J. Fon", "android_phone", "AP-Market", true]);
  // Ended: every device that held a slot, counted once.
  assert.equal((await f.admin("/api/admin/vouchers/u-ended/details?full=1")).body.detail.slotsUsed, 1);
  // Recent vouchers gets the access type, for "Used up".
  const list = (await f.admin("/api/admin/records?collection=vouchers&q=U5ED")).body.items;
  assert.equal(list[0].accessType, "personal_unlimited");
});

test("Resend receipt email sends a fresh delivery, or says why it can't", async (t) => {
  const f = await start(t);
  const none = await f.admin("/api/admin/vouchers/resend-email", { voucherId: "u-stock" });
  assert.deepEqual([none.status, none.body.queued, none.body.error], [200, false, "No receipt email yet: it's sent when the code is redeemed."]);
  const noEmail = await f.admin("/api/admin/vouchers/resend-email", { voucherId: "u-ended" });
  assert.equal(noEmail.body.error, "This customer has no confirmed email address, so there's no receipt to send.");
  // A given voucher (#509) sends once, then a resend goes out under its own key.
  const given = await f.admin("/api/admin/vouchers/generate", { customerId: "c-grace", planId: "weekly", purpose: "assigned", saleType: "gift" });
  const id = given.body.voucher.id, sent = [];
  const service = createTransactionalEmailService({ store: f.store, now: () => new Date(), pepper: secret, planFor: (s, planId) => s.bundles.find((p) => p.id === planId) || plans.find((p) => p.id === planId) || null,
    email: { configured: () => true, sendVoucher: async (message) => { sent.push(message.deliveryKey); return { messageId: "m" + sent.length }; } } });
  await service.voucher(id);
  const resend = await f.admin("/api/admin/vouchers/resend-email", { voucherId: id });
  assert.equal(resend.body.queued, true);
  const v = (await f.store.snapshot()).vouchers.find((x) => x.id === id);
  assert.deepEqual([v.emailResends, v.emailDelivery.status], [1, "pending"]);
  await service.voucher(id);
  assert.deepEqual(sent, [`voucher-confirmation/${id}`, `voucher-confirmation/${id}/resend-1`]);
});

test("entering a code notes the kind of device that redeemed it", async (t) => {
  const f = await start(t);
  const made = await f.admin("/api/admin/vouchers/generate", { planId: "weekly", purpose: "resale", saleType: "sold", quantity: 1 });
  const code = (made.body.vouchers || [made.body.voucher])[0].code;
  const r = await fetch(f.base + "/api/vouchers/redeem", { method: "POST", headers: { "content-type": "application/json", origin: "https://portal.example.test", "cf-connecting-ip": "198.51.100.9",
    "user-agent": "Mozilla/5.0 (Linux; Android 13; SM-A135F) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36" }, body: JSON.stringify({ phone: "670009999", code, deviceId: "d1" }) });
  assert.equal(r.status, 200);
  assert.equal((await f.store.snapshot()).vouchers.find((v) => v.code === code).redeemedDevice, "android_phone");
  assert.deepEqual(["iPhone", "Android 13; Tablet", "Windows NT 10.0", "Macintosh", "X11; CrOS"].map((ua) => deviceKind(ua)), ["iphone", "android_tablet", "windows", "mac", "chromebook"]);
});
