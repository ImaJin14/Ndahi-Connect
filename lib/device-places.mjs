// Where a device is (owner, 26 Nov 2026, on #344 and #341): the access point
// the Omada controller reports for a MAC the router saw. Read-only: nothing is
// sent to the controller or the router. Off unless DEVICE_PLACES_ENABLED=true,
// which the owner sets for the on-site check
// (docs/operations/device-places-onsite-test.md); until then no place shows.
//
// - A voucher started in the last six hours with no place yet takes the
//   access point of the first device the router read on it: the voucher page
//   says "Redeemed by J. Fon on an Android phone at AP-Market".
// - Each approved device slot (#334) keeps the access point the controller
//   last saw it on and since when: customer detail's Devices tab says
//   "online at AP-Market since 08:12".
// Only a change is written, so a quiet network writes nothing.

const RECENT = 6 * 36e5;
const MAC = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
export const normalMac = (mac) => String(mac || "").trim().toUpperCase().replace(/-/g, ":");

// MAC -> { ap } for each client the controller has on an access point now.
export function placeIndex(clients) {
  const places = new Map();
  for (const c of clients || []) {
    const mac = normalMac(c?.mac), ap = typeof c?.ap === "string" ? c.ap.trim().slice(0, 80) : "";
    if (MAC.test(mac) && ap && c.active !== false) places.set(mac, { ap });
  }
  return places;
}

// Records the places on the vouchers and device slots in `s`. Returns counts.
export function recordPlaces(s, places, now) {
  const at = new Date(now), changed = { redeemed: 0, slots: 0 };
  for (const v of s.vouchers || []) {
    if (v.status !== "active" || v.redeemedPlace || !(+at - Date.parse(v.activatedAt) <= RECENT)) continue;
    const first = (v.wifiDevices || []).find((d) => places.has(normalMac(d?.mac)));
    if (!first) continue;
    v.redeemedPlace = places.get(normalMac(first.mac)).ap;
    changed.redeemed++;
  }
  for (const g of s.wifiDeviceGrants || []) {
    const place = g.status === "approved" && places.get(normalMac(g.mac));
    if (!place || g.place === place.ap) continue;
    g.place = place.ap;
    g.placeSince = at.toISOString();
    changed.slots++;
  }
  return changed;
}

export const devicePlacesEnabled = (env = {}) => env.DEVICE_PLACES_ENABLED === "true";

export function createDevicePlaces({ store, networkSetup, now = () => new Date(), logger }) {
  let running = false;
  async function run() {
    if (running) return null;
    running = true;
    try {
      const clients = await networkSetup.omadaClients();
      if (!clients) return null;
      const places = placeIndex(clients);
      if (!places.size) return { redeemed: 0, slots: 0 };
      return await store.transaction((s) => recordPlaces(s, places, now()),
        { load: [{ rows: { vouchers: { status: ["active"] }, wifiDeviceGrants: { status: ["approved"] } } }] });
    } catch (error) {
      logger?.warn?.("device_places.failed", { message: String(error?.message || error).slice(0, 200) });
      return null;
    } finally {
      running = false;
    }
  }
  return { run };
}
