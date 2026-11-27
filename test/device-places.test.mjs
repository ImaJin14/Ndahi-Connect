// Where a device is (owner, 26 Nov 2026, on #344 and #341): the access point
// the Omada controller reports for a MAC the router saw. These check the
// mapping and what is recorded; the controller itself is checked on-site
// (docs/operations/device-places-onsite-test.md).
import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { placeIndex, recordPlaces, createDevicePlaces, devicePlacesEnabled, normalMac } from "../lib/device-places.mjs";
import { OmadaProvisioner } from "../lib/network-omada.mjs";

const now = new Date("2026-11-27T09:00:00.000Z");

test("the controller's clients map MACs to access points; inactive or unplaced clients are left out", () => {
  const places = placeIndex([{ mac: "aa-bb-cc-4f-a2-10", ap: "AP-Market" }, { mac: "AA:BB:CC:19:C7:5E", ap: " AP-Junction ", active: true },
    { mac: "AA:BB:CC:00:00:01", ap: "AP-Old", active: false }, { mac: "AA:BB:CC:00:00:02", ap: null }, { mac: "not-a-mac", ap: "AP-X" }]);
  assert.deepEqual([...places.entries()], [["AA:BB:CC:4F:A2:10", { ap: "AP-Market" }], ["AA:BB:CC:19:C7:5E", { ap: "AP-Junction" }]]);
  assert.equal(normalMac("aa-bb-cc-dd-ee-ff"), "AA:BB:CC:DD:EE:FF");
});

test("a voucher started recently takes its first placed device's access point; slots keep theirs and since when", () => {
  const places = placeIndex([{ mac: "AA:BB:CC:4F:A2:10", ap: "AP-Market" }, { mac: "AA:BB:CC:19:C7:5E", ap: "AP-Junction" }]);
  const s = {
    vouchers: [
      { id: "recent", status: "active", activatedAt: new Date(+now - 3600e3).toISOString(), wifiDevices: [{ mac: "AA:BB:CC:00:00:09" }, { mac: "aa:bb:cc:4f:a2:10" }] },
      { id: "old", status: "active", activatedAt: new Date(+now - 7 * 3600e3).toISOString(), wifiDevices: [{ mac: "AA:BB:CC:4F:A2:10" }] },
      { id: "placed", status: "active", activatedAt: new Date(+now - 600e3).toISOString(), redeemedPlace: "AP-Gate", wifiDevices: [{ mac: "AA:BB:CC:4F:A2:10" }] },
    ],
    wifiDeviceGrants: [
      { id: "g1", status: "approved", mac: "AA:BB:CC:19:C7:5E" },
      { id: "g2", status: "approved", mac: "AA:BB:CC:4F:A2:10", place: "AP-Market", placeSince: "2026-11-27T07:00:00.000Z" },
      { id: "g3", status: "revoked", mac: "AA:BB:CC:4F:A2:10" },
    ],
  };
  assert.deepEqual(recordPlaces(s, places, now), { redeemed: 1, slots: 1 });
  assert.deepEqual(s.vouchers.map((v) => v.redeemedPlace), ["AP-Market", undefined, "AP-Gate"], "only a recent redemption, never overwritten");
  assert.deepEqual([s.wifiDeviceGrants[0].place, s.wifiDeviceGrants[0].placeSince], ["AP-Junction", now.toISOString()]);
  assert.equal(s.wifiDeviceGrants[1].placeSince, "2026-11-27T07:00:00.000Z", "unchanged: nothing written");
  assert.equal(s.wifiDeviceGrants[2].place, undefined, "a revoked slot is left alone");
});

test("the worker reads the controller only when it is on, and records into the store", async () => {
  assert.equal(devicePlacesEnabled({}), false);
  assert.equal(devicePlacesEnabled({ DEVICE_PLACES_ENABLED: "true" }), true);
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.wifiDeviceGrants = [{ id: "g1", status: "approved", mac: "AA:BB:CC:19:C7:5E" }]; });
  const off = createDevicePlaces({ store, networkSetup: { omadaClients: async () => null }, now: () => now });
  assert.equal(await off.run(), null, "no live controller: nothing happens");
  const on = createDevicePlaces({ store, networkSetup: { omadaClients: async () => [{ mac: "AA:BB:CC:19:C7:5E", ap: "AP-Junction" }] }, now: () => now });
  assert.deepEqual(await on.run(), { redeemed: 0, slots: 1 });
  assert.equal((await store.snapshot()).wifiDeviceGrants[0].place, "AP-Junction");
  const failing = createDevicePlaces({ store, networkSetup: { omadaClients: async () => { throw Error("controller down"); } }, now: () => now, logger: { warn() {} } });
  assert.equal(await failing.run(), null, "a controller error is logged, not thrown");
});

test("the Omada client list is read page by page and keeps each client's MAC and access point", async () => {
  const requested = [];
  const fetcher = async (url) => {
    requested.push(new URL(url).pathname + new URL(url).search);
    const body = url.includes("/authorize/token") ? { errorCode: 0, result: { accessToken: "t", expiresIn: 3600 } }
      : { errorCode: 0, result: { totalRows: 1, data: [{ mac: "AA-BB-CC-4F-A2-10", apName: "AP-Market", active: true }] } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  };
  const omada = new OmadaProvisioner({ url: "https://omada.example.test", controllerId: "c1", siteId: "s1", clientId: "id", clientSecret: "secret" }, { fetcher });
  assert.deepEqual(await omada.clients(), [{ mac: "AA-BB-CC-4F-A2-10", ap: "AP-Market", active: true }]);
  assert.ok(requested.some((path) => path === "/openapi/v1/c1/sites/s1/clients?page=1&pageSize=100"));
});
