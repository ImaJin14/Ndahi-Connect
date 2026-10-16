import { escapeHtml as h } from "/shared/safe-html.js";

const size = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;

// Devices on the HotSpot as reported by the router. Phones often use a private
// MAC address per network, so its last two bytes are the most stable label.
export function wifiDeviceList({ devices = [], deviceLimit, syncedAt }) {
  const rows = devices.map((device) => `<div class="device"><div><b>Device ending ${h(device.mac.slice(-5))}</b><br><small>${h(device.address || "Address pending")} · ${h(size(device.usedBytes))} this session${device.uptime ? ` · online ${h(device.uptime)}` : ""}</small></div><button type="button" data-wifi-device="${h(device.mac)}">Disconnect</button></div>`).join("");
  return `${rows || "<p>No devices are on NDAHI Wi-Fi right now.</p>"}${deviceLimit ? `<p>${h(devices.length)} of ${h(deviceLimit)} device slots in use${syncedAt ? ` · updated ${h(new Date(syncedAt).toLocaleTimeString())}` : ""}</p>` : ""}`;
}

export const allSlotsInUse = ({ devices = [], deviceLimit }) => Boolean(deviceLimit) && devices.length >= deviceLimit;
