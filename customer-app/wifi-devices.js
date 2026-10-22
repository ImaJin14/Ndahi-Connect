import { escapeHtml as h } from "/shared/safe-html.js";

const size = (bytes) => bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${Math.round(bytes / 1e6)} MB`;

export function wifiDeviceList({ devices = [], deviceLimit, syncedAt, approvedDevices = [], secondaryApprovalExpiryMinutes }) {
  const stale = !syncedAt || !Number.isFinite(Date.parse(syncedAt)) || Date.now() - Date.parse(syncedAt) > 120000;
  const rows = devices.map((device) => {
    const operation = device.disconnect;
    const approval = approvedDevices.find((g) => g.mac === device.mac && !g.routerChanged);
    const pending = operation && ["disconnecting", "retrying"].includes(operation.status) || (approval && approval.removal) && approval.removal !== "dead_letter";
    const disabled = pending || stale || !device.sessionId || !device.startedAt || Boolean((approval && approval.removal));
    return `<div class="device"><div><b>${device.name ? h(device.name) : `Unnamed device · ending ${h(device.mac.slice(-5))}`}${device.main ? " · Main device" : ""}</b><br><small>${device.nameLastReported ? "Last reported name · " : ""}${device.name ? `Ending ${h(device.mac.slice(-5))} · ` : ""}${h(device.address || "Address pending")} · ${h(size(device.usedBytes))} this session${device.uptime ? ` · online ${h(device.uptime)}` : ""}</small>${operation ? `<p role="status">${h(operation.message)}</p>` : ""}${(approval && approval.removal) ? `<p role="status">${approval.removal === "dead_letter" ? "Saved approval revoked. Router removal needs support review." : "Saved approval revoked. Waiting for router removal; its slot is not confirmed free."}</p>` : ""}</div><button type="button" ${device.main ? "data-main-disconnect" : "data-wifi-device"}="${h(device.mac)}" data-wifi-session="${h(device.sessionId || "")}" data-wifi-started="${h(device.startedAt || "")}" ${disabled ? "disabled" : ""}>${pending ? "Disconnecting…" : device.main ? "Verify to disconnect" : operation && operation.status === "failed" ? "Retry disconnect" : "Disconnect"}</button>${approval && !approval.removal ? `<button type="button" data-forget-device="${h(approval.id)}">Forget device</button>` : ""}</div>`;
  }).join("");
  const saved = approvedDevices.filter((g) => g.routerChanged || !devices.some((d) => d.mac === g.mac)).map((g) =>
    `<div class="device" data-saved-device><div><strong>${h(g.name || "Unnamed device")} · ending ${h(g.mac.slice(-5))}${g.main ? " · Main device" : ""}</strong><p>${g.removal ? g.removal === "dead_letter" ? "Approval revoked. Router removal needs support review." : "Approval revoked. Router removal is pending." : g.routerChanged ? "Approval belongs to a previous router." : "Saved approval · not reported connected"}</p></div>${g.removal ? "" : `<button type="button" data-forget-device="${h(g.id)}">Forget device</button>`}</div>`).join("");
  return `${rows || `<p>${stale ? "Waiting for a current device list…" : "No devices were reported at the last Wi-Fi check."}</p>`}${saved}${deviceLimit ? `<p>${h(devices.length)} of ${h(deviceLimit)} device slots in use${syncedAt ? ` · updated ${h(new Date(syncedAt).toLocaleTimeString())}` : ""}</p>` : ""}${stale ? '<p role="status">The device list may be out of date. Waiting for a Wi-Fi update; slots are not confirmed free.</p>' : ""}<button type="button" class="secondary-action" data-refresh-wifi>Refresh devices</button><p>${secondaryApprovalExpiryMinutes === 30 ? "Secondary approval expires after 30 minutes of confirmed disconnection. " : ""}Main-device approval is kept. Forget device removes approval immediately; router cleanup must finish before new approval.</p>`;
}

export const allSlotsInUse = ({ devices = [], deviceLimit }) => Boolean(deviceLimit) && devices.length >= deviceLimit;
