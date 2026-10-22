import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { notificationItems } from "../lib/notifications.mjs";
import { wifiDeviceView } from "../lib/wifi-devices.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";

test("retained terminal access and superseded disconnect history stays scoped and contains no credentials", async (t) => {
  const f = await pairingFixture(); t.after(f.close);
  await f.store.transaction((s) => {
    s.wifiPairingRequests.push({ id: "history-1", customerId: "c1", mac: guestMac, name: "TV", kind: "reconnect", status: "connected", at: f.now().toISOString(), updatedAt: f.now().toISOString() });
    s.routerCommands.push({ id: "old-disconnect", action: "disconnect_wifi_device", customerId: "c1", status: "processed", result: "superseded",
      processedAt: f.now().toISOString(), device: { voucherId: "v1", mac: guestMac, username: s.vouchers[0].code } });
  });
  const s = await f.store.snapshot(), own = notificationItems(s, { type: "customer", id: "c1" }, f.now());
  assert.equal(own.filter((n) => n.id === "device:history-1").length, 1);
  const ended = own.find((n) => n.id === "wifi-disconnect:old-disconnect");
  assert.match(ended.body, /does not confirm disconnection/);
  assert.equal(ended.pushEligible, false);
  assert.equal(ended.url, "/dashboard#devices");
  assert.equal(JSON.stringify(own).includes(s.vouchers[0].code), false);
  assert.equal(notificationItems(s, { type: "customer", id: "c2" }, f.now()).some((n) => n.id === ended.id), false);
});

test("polling retained history preserves its source version and per-person read/archive state", async (t) => {
  const f = await pairingFixture(); t.after(f.close);
  await f.store.transaction((s) => { s.routerCommands.push({ id: "finished", action: "disconnect_wifi_device", customerId: "c1", status: "processed", result: "disconnected",
    processedAt: f.now().toISOString(), device: { voucherId: "v1", mac: guestMac } }); });
  const s = await f.store.snapshot(), actor = { type: "customer", id: "c1" };
  const first = notificationItems(s, actor, f.now()).find((n) => n.id === "wifi-disconnect:finished");
  s.notificationStates.push({ id: "read-history", actor: "customer:c1", notificationId: first.id, readVersion: first.version, archivedVersion: first.version });
  const next = notificationItems(s, actor, new Date(+f.now() + 60000)).find((n) => n.id === first.id);
  assert.equal(next.version, first.version); assert.equal(next.read, true); assert.equal(next.archived, true);
  assert.equal(notificationItems(s, actor, f.now()).filter((n) => n.id === first.id).length, 1);
});

test("device summary exposes only the owning customer's safe saved-approval fields", async (t) => {
  const f = await pairingFixture(); t.after(f.close);
  await f.store.transaction((s) => { approveDevice(s, "c1", { mac: guestMac }, f.now(), "test"); approveDevice(s, "c2", { mac: "00:00:00:00:00:22" }, f.now(), "test"); });
  const s = await f.store.snapshot(), result = wifiDeviceView(s, s.vouchers[0]);
  assert.equal(result.approvedDevices.length, 1); assert.equal(result.approvedDevices[0].mac, guestMac);
  assert.equal(result.approvedDevices[0].customerId, undefined);
  assert.equal(result.approvedDevices[0].controllerHash, undefined);
});
