// Devices (canvas: PhoneDevices). /dashboard#devices opens the "Manage devices"
// section as its own page: back arrow, title and how many devices are in use,
// the device list, the Private Wi-Fi tip, main-device and pairing controls, and
// how to add another device. On Home it stays a disclosure.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const BACK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18 9 12l6-6"></path></svg>';

export const devicesCount = (used, limit) => L("portalDevicesInUse", { used, limit });

export function devicesHead({ used, limit }) {
  return `<div class="portal-devices__head"><a class="portal-devices__back" href="/dashboard#home" aria-label="${h(L("portalBackHome"))}">${BACK}</a><h2 id="devicesTitle" tabindex="-1">${h(L("portalDevicesTitle"))}</h2>${limit ? `<span class="nd-pill portal-devices__count" id="devicesCount">${h(devicesCount(used, limit))}</span>` : ""}</div>${limit ? `<p class="portal-devices__intro">${h(limit === 1 ? L("portalDevicesLimitOne") : L("portalDevicesLimit", { count: limit }))}</p>` : ""}`;
}

export function devicesTip({ hotspot, active }) {
  return hotspot && active ? `<p class="portal-devices__tip">${h(L("portalDevicesTip"))}</p>` : "";
}

export function devicesAdd({ hotspot, active }) {
  return active ? `<details class="portal-devices__add"><summary class="nd-btn nd-btn--block">${h(L("portalDevicesAdd"))}</summary><p>${h(L(hotspot ? "portalDevicesAddHotspot" : "portalDevicesAddSignedIn"))}</p></details>` : "";
}

// The device poll re-renders the list; keep the count in the head in step.
export function updateDevicesCount(list) {
  const count = document.getElementById("devicesCount");
  if (count && list && list.deviceLimit) count.textContent = devicesCount((list.devices || []).length, list.deviceLimit);
}
