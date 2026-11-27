// Customer detail for Unlimited (AdminCustomerDetail, #341; owner 26 Nov): Send
// PIN reset email (the customer's own Forgot PIN link, or the reason it can't),
// the Devices tab's slots (masked MAC, online and where, or last seen, and
// being removed), the customer's replacements, the Home WISP router, and
// Revoke device by its slot.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

const secret = "admin-customer-detail";
const env = { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
  ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
  BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" };
const later = (hours) => new Date(Date.now() + hours * 36e5).toISOString();

async function start(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    for (const role of ["owner", "operator", "auditor"]) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, displayName: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `staff-${role}`, role, tokenHash: hashSecret(role, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    s.bundles.push({ id: "p2", name: "Week Unlimited", price: 3500, validityHours: 168, accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaGb: null, status: "published", catalogue: "unlimited" });
    s.customers.push({ id: "c-amina", name: "Amina N.", phone: "670001245", email: "amina@example.com", emailVerifiedAt: later(-900), pinHash: "hash", status: "active" },
      { id: "c-noemail", name: "No Mail", phone: "670001246", pinHash: "hash", status: "active" });
    s.vouchers.push({ id: "va", code: "NC-K7PM-42XQ", customerId: "c-amina", planId: "p2", status: "active", accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2,
      validityHours: 168, quotaBytes: null, usedBytes: 0, activatedAt: later(-100), expiresAt: later(68),
      wifiDevices: [{ mac: "AA:BB:CC:4F:A2:10", sessionId: "s1", startedAt: later(-3) }] });
    s.wifiDeviceGrants = [
      { id: "g-tablet", customerId: "c-amina", voucherId: "va", mac: "AA:BB:CC:00:11:22", status: "revoked", routerRevision: "", name: "tablet", approvedAt: later(-90), revokedAt: later(-60), revocationConfirmedAt: later(-60) },
      { id: "g-phone", customerId: "c-amina", voucherId: "va", mac: "AA:BB:CC:4F:A2:10", status: "approved", routerRevision: "", name: "phone", approvedAt: later(-59), place: "AP-Market", placeSince: later(-3) },
      { id: "g-laptop", customerId: "c-amina", voucherId: "va", mac: "AA:BB:CC:19:C7:5E", status: "approved", routerRevision: "", name: "HP laptop", approvedAt: later(-80), lastSeenAt: later(-2) }];
    s.auditLogs.unshift({ id: "rel", action: "voucher.device_slot_released", actor: "c-amina", meta: { customerId: "c-amina", voucherId: "va", macSuffix: "11:22", by: "customer" }, at: later(-60) });
  });
  const server = createServer({ store, validateConfig: false, env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (role, path, input) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { cookie: `admin_session=${role}`, origin: "http://admin.test", "x-csrf-token": `csrf-${role}`,
      ...(input ? { "content-type": "application/json" } : {}) }, ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, call };
}

test("Send PIN reset email sends the Forgot PIN link, or says why it can't", async (t) => {
  const f = await start(t);
  const sent = await f.call("operator", "/api/admin/customers/pin-reset-email", { customerId: "c-amina" });
  assert.deepEqual([sent.status, sent.body], [200, { sent: true, to: "a••••@example.com" }]);
  const s = await f.store.snapshot();
  assert.equal(s.pinResetChallenges.filter((c) => c.customerId === "c-amina" && !c.used).length, 1, "one live link");
  assert.ok(s.auditLogs.some((a) => a.action === "customer.pin_reset_email_sent" && a.meta.customerId === "c-amina"));
  assert.deepEqual(await f.call("owner", "/api/admin/customers/pin-reset-email", { customerId: "c-noemail" }),
    { status: 409, body: { error: "This customer has no confirmed email address, so a reset link can't be sent." } });
  assert.equal((await f.call("auditor", "/api/admin/customers/pin-reset-email", { customerId: "c-amina" })).status, 403);
  // A second link replaces the first; three a quarter-hour.
  await f.call("owner", "/api/admin/customers/pin-reset-email", { customerId: "c-amina" });
  assert.equal((await f.store.snapshot()).pinResetChallenges.filter((c) => c.customerId === "c-amina" && !c.used).length, 1);
  await f.call("owner", "/api/admin/customers/pin-reset-email", { customerId: "c-amina" });
  assert.equal((await f.call("owner", "/api/admin/customers/pin-reset-email", { customerId: "c-amina" })).status, 429);
});

test("the customer's summary lists each slot, the replacements and the Home WISP router", async (t) => {
  const f = await start(t);
  const found = await f.call("owner", "/api/admin/records?collection=customers&q=c-amina");
  const bundle = found.body.items.find((c) => c.id === "c-amina").summary.bundle;
  assert.deepEqual([bundle.validityHours, bundle.deviceSlots, bundle.slotsUsed, bundle.homeRouter], [168, 2, 2, { registered: false }]);
  assert.deepEqual(bundle.slots.map(({ id, name, mac, online, place, removing }) => ({ id, name, mac, online, place, removing })), [
    { id: "g-laptop", name: "HP laptop", mac: "••:••:••:19:C7:5E", online: false, place: undefined, removing: false },
    { id: "g-phone", name: "phone", mac: "••:••:••:4F:A2:10", online: true, place: "AP-Market", removing: false },
  ]);
  assert.equal(typeof bundle.slots[0].lastSeenAt, "string");
  assert.equal(typeof bundle.slots[1].since, "string");
  assert.deepEqual([bundle.replacements.count, bundle.replacements.last.from, bundle.replacements.last.to], [1, "tablet", "phone"]);
});

test("Revoke device works on a slot's id, and the slot shows as being removed", async (t) => {
  const f = await start(t);
  assert.equal((await f.call("owner", "/api/admin/vouchers/devices/revoke", { voucherId: "va", grantId: "g-laptop" })).status, 400, "a reason is required");
  const revoked = await f.call("owner", "/api/admin/vouchers/devices/revoke", { voucherId: "va", grantId: "g-laptop", reason: "Lost laptop" });
  assert.ok([200, 202].includes(revoked.status));
  const s = await f.store.snapshot();
  assert.equal(s.wifiDeviceGrants.find((g) => g.id === "g-laptop").status, "revoked");
  assert.equal(s.auditLogs.find((a) => a.action === "voucher.device_revoked").meta.macSuffix, "C7:5E");
});
