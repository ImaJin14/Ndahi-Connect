import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./device-management.test.mjs";
import { routerRevision } from "../lib/device-identities.mjs";

// Replace a device (#350): the device list shows a Personal Unlimited bundle's
// slots; Replace (PIN) removes the chosen device's slot, which frees only once
// the router confirms; retrying is safe, and a removal the router failed is
// asked for again.
async function personal(t) {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    const v = s.vouchers.find((x) => x.id === "v1");
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null });
    s.wifiDeviceGrants ??= [];
    for (const [n, name] of [[1, "imajin"], [2, "HP laptop"]]) s.wifiDeviceGrants.push({ id: `g${n}`, customerId: "c1", voucherId: "v1", mac: `AA:BB:CC:DD:EE:0${n}`, name,
      status: "approved", routerRevision: routerRevision(s), approvedAt: `2030-01-01T1${n}:00:00Z` });
    v.wifiDevices = v.wifiDevices.slice(0, 1);
    s.wifiDeviceGrants.find((g) => g.id === "g2").lastSeenAt = "2030-01-01T10:00:00Z";
  });
  return f;
}

test("the device list shows a Personal Unlimited bundle's slots", async (t) => {
  const f = await personal(t), list = (await f.call("/api/account/device-management")).body;
  assert.equal(list.slots.total, 2); assert.equal(list.slots.endsAt, "2030-02-01T00:00:00Z");
  assert.deepEqual(list.slots.rows.map((r) => [r.id, r.name, r.mac, r.online, r.removing]), [["g1", "imajin", "••:••:••:DD:EE:01", true, false], ["g2", "HP laptop", "••:••:••:DD:EE:02", false, false]]);
  assert.equal(list.slots.rows[1].lastSeenAt, "2030-01-01T10:00:00Z");
});

test("replacing needs the PIN, frees the slot only once the router confirms, and retries a failed removal", async (t) => {
  const f = await personal(t);
  const wrong = await f.call("/api/account/device-management/replace", { approvalId: "g2", pin: "0000" });
  assert.equal(wrong.status, 401);
  f.advance(15 * 60); // past the PIN back-off a wrong PIN starts
  const asked = await f.call("/api/account/device-management/replace", { approvalId: "g2", pin: "2468" });
  assert.equal(asked.status, 202);
  let row = asked.body.slots.rows.find((r) => r.id === "g2");
  assert.equal(row.removing, true, "the slot stays taken until the router confirms");
  let s = await f.store.snapshot(), grant = s.wifiDeviceGrants.find((g) => g.id === "g2");
  const first = grant.revocationCommandId;
  assert.equal(s.routerCommands.find((c) => c.id === first).action, "revoke_wifi_device");
  assert.equal(s.vouchers.find((v) => v.id === "v1").expiresAt, "2030-02-01T00:00:00Z", "the end date never moves");
  // Retrying while the router works on it changes nothing.
  assert.equal((await f.call("/api/account/device-management/replace", { approvalId: "g2", pin: "2468" })).status, 202);
  assert.equal((await f.store.snapshot()).wifiDeviceGrants.find((g) => g.id === "g2").revocationCommandId, first);
  // The router fails: retrying asks it again.
  await f.store.transaction((x) => { x.routerCommands.find((c) => c.id === first).status = "dead_letter"; });
  assert.equal((await f.call("/api/account/device-management")).body.slots.rows.find((r) => r.id === "g2").removing, true, "a failed removal still holds the slot");
  const retried = await f.call("/api/account/device-management/replace", { approvalId: "g2", pin: "2468" });
  assert.equal(retried.status, 202);
  s = await f.store.snapshot(); grant = s.wifiDeviceGrants.find((g) => g.id === "g2");
  assert.notEqual(grant.revocationCommandId, first);
  assert.equal(s.routerCommands.find((c) => c.id === grant.revocationCommandId).status, "queued");
  assert.ok(s.auditLogs.some((a) => a.action === "voucher.device_slot_release_retried"));
  // Confirmed: the slot is free.
  await f.store.transaction((x) => { const g = x.wifiDeviceGrants.find((y) => y.id === "g2"); g.revocationConfirmedAt = "2030-01-01T12:01:00Z"; x.routerCommands.find((c) => c.id === g.revocationCommandId).status = "processed"; });
  assert.deepEqual((await f.call("/api/account/device-management")).body.slots.rows.map((r) => r.id), ["g1"]);
});
