// Personal Unlimited device slots (#334): the server's rules, without a
// router (owner, 24 Nov: router behaviour is proved on the test HotSpot with
// docs/operations/unlimited-device-slots-test-plan.md, not simulated here).
import test from "node:test";
import assert from "node:assert/strict";
import { blank } from "../lib/api/state.mjs";
import { routerRevision } from "../lib/device-identities.mjs";
import { slotRefusal, occupiedSlots, startWaitingBundle, waitingBundle, revokeDeviceGrant, isPersonalUnlimited } from "../lib/device-slots.mjs";
import { activeSubscription } from "../lib/subscription-policy.mjs";

const now = new Date("2026-11-25T10:00:00Z");
const A = "AA:AA:AA:AA:AA:01", B = "AA:AA:AA:AA:AA:02", C = "AA:AA:AA:AA:AA:03";
function state() {
  const s = blank();
  s.customers.push({ id: "amina", phone: "670000001" });
  s.vouchers.push({ id: "personal", customerId: "amina", planId: "unlimited-24h-2", status: "active", activatedAt: now.toISOString(),
    expiresAt: new Date(+now + 24 * 36e5).toISOString(), quotaBytes: null, deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2, sharing: false });
  return s;
}
const grant = (s, mac, extra = {}) => { s.wifiDeviceGrants.push({ id: mac, customerId: "amina", mac, voucherId: "personal", status: "approved", routerRevision: routerRevision(s), ...extra }); };

test("full slots refuse a new device even when a registered one is offline", () => {
  const s = state(), v = s.vouchers[0];
  grant(s, A); grant(s, B);
  // B is offline: no live session, still registered.
  v.wifiDevices = [{ mac: A }];
  const refused = slotRefusal(s, v, C);
  assert.deepEqual([refused.status, refused.body.code, refused.body.slots], [409, "DEVICE_SLOTS_FULL", 2]);
  assert.match(refused.body.error, /even when a device is offline/);
  assert.equal(slotRefusal(s, v, A), null, "a registered device reconnects");
  assert.equal(slotRefusal(s, v, B.toLowerCase()), null, "MACs compare as RouterOS reports them, upper case");
  // A device being connected right now counts too.
  const t = state(); grant(t, A);
  assert.equal(slotRefusal(t, t.vouchers[0], C, 1)?.body.code, "DEVICE_SLOTS_FULL");
});

test("a removed device keeps its slot until the router confirms it is gone; then the replacement fits", () => {
  const s = state(), v = s.vouchers[0];
  grant(s, A); grant(s, B);
  const removal = revokeDeviceGrant(s, "amina", s.wifiDeviceGrants.find((g) => g.mac === B), now, { kind: "customer", actor: "amina" });
  assert.deepEqual([removal.conflict, removal.pending], [false, true]);
  assert.ok(s.routerCommands.some((c) => c.action === "revoke_wifi_device" && c.grantId === B), "the router is asked to remove its session, saved login and binding");
  assert.deepEqual(occupiedSlots(s, v), [A, B], "still taken: removal not confirmed");
  assert.equal(slotRefusal(s, v, C)?.body.code, "DEVICE_SLOTS_FULL", "the replacement waits for confirmation");
  s.wifiDeviceGrants.find((g) => g.mac === B).revocationConfirmedAt = now.toISOString();
  assert.equal(slotRefusal(s, v, C), null, "confirmed: the slot is free");
  assert.equal(v.deviceReplacements, 1);
  assert.equal(v.expiresAt, new Date(+now + 24 * 36e5).toISOString(), "replacing never restarts or extends the bundle");
  assert.ok(s.auditLogs.some((a) => a.action === "voucher.device_slot_released" && a.meta.voucherId === "personal"));
});

test("removing a device while its connection is being confirmed is refused, and nothing changes", () => {
  const s = state(); grant(s, A);
  s.routerCommands.push({ id: "cmd-1", action: "connect_wifi_device", status: "processing" });
  s.wifiPairingRequests.push({ id: "p1", customerId: "amina", mac: A, status: "connecting", commandId: "cmd-1" });
  const before = JSON.stringify(s);
  assert.deepEqual(revokeDeviceGrant(s, "amina", s.wifiDeviceGrants[0], now), { conflict: true });
  assert.equal(JSON.stringify(s), before);
});

test("time starts at the first connection, once, and the waiting bundle is the customer's bundle", () => {
  const s = state();
  s.vouchers = [{ id: "waiting", customerId: "amina", planId: "unlimited-7d-1", status: "available", activatedAt: null, expiresAt: null,
    startsOnFirstConnection: true, validityHours: 168, accessType: "personal_unlimited", deviceSlots: 1 }];
  assert.equal(activeSubscription(s, "amina", now)?.id, "waiting", "no second bundle while one waits");
  assert.equal(waitingBundle(s, "amina")?.id, "waiting");
  const later = new Date(+now + 3 * 864e5);
  assert.equal(startWaitingBundle(s, s.vouchers[0], later, "device_request"), true);
  const v = s.vouchers[0];
  assert.deepEqual([v.status, v.activatedAt, v.expiresAt, v.routerSyncStatus], ["active", later.toISOString(), new Date(+later + 168 * 36e5).toISOString(), "pending"]);
  assert.ok(s.routerCommands.some((c) => c.action === "sync_voucher" && c.targetId === "waiting"));
  assert.equal(startWaitingBundle(s, v, new Date(+later + 36e5), "code"), false, "never restarted");
  assert.equal(v.activatedAt, later.toISOString());
});

test("a legacy bundle is unaffected: no slot rule, no waiting, its devices stay", () => {
  const s = blank();
  s.customers.push({ id: "paul", phone: "670000002" });
  const legacy = { id: "family", customerId: "paul", planId: "family", status: "active", activatedAt: now.toISOString(), expiresAt: new Date(+now + 720 * 36e5).toISOString(),
    quotaBytes: 50e9, usedBytes: 0, deviceLimit: 3, wifiDevices: [{ mac: A }, { mac: B }, { mac: C }] };
  s.vouchers.push(legacy);
  for (const mac of [A, B, C]) s.wifiDeviceGrants.push({ id: mac, customerId: "paul", mac, voucherId: "family", status: "approved", routerRevision: routerRevision(s) });
  const before = JSON.stringify(s);
  assert.equal(isPersonalUnlimited(legacy), false);
  assert.equal(slotRefusal(s, legacy, "AA:AA:AA:AA:AA:09"), null, "the old device rule applies, not slots");
  assert.equal(waitingBundle(s, "paul"), undefined);
  assert.equal(startWaitingBundle(s, legacy, now, "code"), false);
  assert.equal(JSON.stringify(s), before, "all three devices and the bundle unchanged");
  // Forgetting one of its devices doesn't count as an Unlimited replacement.
  revokeDeviceGrant(s, "paul", s.wifiDeviceGrants[0], now);
  assert.equal(legacy.deviceReplacements, undefined);
});
