import { escapeHtml as h } from "/shared/safe-html.js";

const size = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;

export function wifiDeviceList({ devices = [], deviceLimit, syncedAt, disconnects = [] }) {
  const stale = !syncedAt || !Number.isFinite(Date.parse(syncedAt)) || Date.now() - Date.parse(syncedAt) > 120000;
  const rows = devices.map((device) => {
    const operation = device.disconnect;
    const pending = operation && ["disconnecting", "retrying"].includes(operation.status);
    const disabled = pending || stale || !device.sessionId || !device.startedAt;
    return `<div class="device"><div><b>${device.name ? h(device.name) : `Unnamed device · ending ${h(device.mac.slice(-5))}`}${device.main ? " · Main device" : ""}</b><br><small>${device.nameLastReported ? "Last reported name · " : ""}${device.name ? `Ending ${h(device.mac.slice(-5))} · ` : ""}${h(device.address || "Address pending")} · ${h(size(device.usedBytes))} this session${device.uptime ? ` · online ${h(device.uptime)}` : ""}</small>${operation ? `<p role="status">${h(operation.message)}</p>` : ""}</div><button type="button" ${device.main ? "data-main-disconnect" : "data-wifi-device"}="${h(device.mac)}" data-wifi-session="${h(device.sessionId || "")}" data-wifi-started="${h(device.startedAt || "")}" ${disabled ? "disabled" : ""}>${pending ? "Disconnecting…" : device.main ? "Verify to disconnect" : operation && operation.status === "failed" ? "Retry disconnect" : "Disconnect"}</button></div>`;
  }).join("");
  const latest = {};
  disconnects.forEach((operation) => { latest[operation.mac] = operation; });
  const notices = Object.keys(latest).map((mac) => latest[mac]).filter((operation) =>
    !devices.some((d) => d.mac === operation.mac && d.disconnect) && ["failed", "superseded", "disconnected"].includes(operation.status)
  ).map((operation) => `<p role="status">Device ending ${h(operation.mac.slice(-5))}: ${h(operation.message)}</p>`).join("");
  return `${rows || `<p>${stale ? "Waiting for a current device list…" : "No devices were reported at the last Wi-Fi check."}</p>`}${deviceLimit ? `<p>${h(devices.length)} of ${h(deviceLimit)} device slots in use${syncedAt ? ` · updated ${h(new Date(syncedAt).toLocaleTimeString())}` : ""}</p>` : ""}${stale ? '<p role="status">The device list may be out of date. Waiting for a Wi-Fi update; slots are not confirmed free.</p>' : ""}${notices}<button type="button" class="secondary-action" data-refresh-wifi>Refresh devices</button>`;
}

export const allSlotsInUse = ({ devices = [], deviceLimit }) => Boolean(deviceLimit) && devices.length >= deviceLimit;
