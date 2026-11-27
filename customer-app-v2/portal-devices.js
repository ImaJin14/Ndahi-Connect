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

// A button, not a disclosure: journeys address the section's one summary.
// "Add another device" shows a pairing code for the new device to type (#407;
// owner 27 Nov): a forest card like the request reference, a countdown, and
// New code / Close. Where the bundle doesn't share, the old help stays.
export function devicesAdd({ hotspot, active }) {
  return active ? `<div class="portal-devices__add"><button type="button" class="nd-btn nd-btn--block" data-devices-add aria-expanded="false" aria-controls="devicesAddHelp">${h(L("portalDevicesAdd"))}</button>
    <section class="portal-devices__pair" id="devicesAddHelp" aria-label="${h(L("portalPairCodeLabel"))}" hidden><div class="portal-devices__pair-card" data-pairing-card hidden><p class="portal-devices__pair-label">${h(L("portalPairCodeLabel"))}</p><p class="portal-devices__pair-code" data-pairing-code></p><p class="portal-devices__pair-note">${h(L("portalPairCodeNote"))}</p></div>
    <p class="portal-devices__pair-expiry" data-pairing-expiry role="status"></p><p class="portal-devices__pair-help" data-pairing-help hidden>${h(L(hotspot ? "portalDevicesAddHotspot" : "portalDevicesAddSignedIn"))}</p>
    <div class="portal-devices__pair-actions"><button type="button" class="nd-btn nd-btn--secondary" data-pairing-new hidden>${h(L("portalPairCodeNew"))}</button><button type="button" class="nd-btn nd-btn--secondary" data-pairing-close>${h(L("portalPairCodeClose"))}</button></div></section></div>` : "";
}

let countdown;
export function mountDevicesAdd(call) {
  const button = document.querySelector("[data-devices-add]"), panel = document.getElementById("devicesAddHelp");
  if (!button || !panel) return;
  const $ = (selector) => panel.querySelector(selector);
  const close = () => { clearInterval(countdown); button.setAttribute("aria-expanded", "false"); panel.hidden = true; button.focus(); };
  async function issue() {
    clearInterval(countdown);
    $("[data-pairing-help]").hidden = true; $("[data-pairing-card]").hidden = true; $("[data-pairing-new]").hidden = true;
    $("[data-pairing-expiry]").textContent = L("portalPairCodeGetting");
    try {
      const { code, expiresAt } = await call("/api/account/device-management/pairing/code", { method: "POST", body: "{}" });
      $("[data-pairing-code]").textContent = code.slice(0, 3) + " " + code.slice(3);
      $("[data-pairing-card]").hidden = false; $("[data-pairing-new]").hidden = false;
      const tick = () => {
        const left = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 1000));
        $("[data-pairing-expiry]").textContent = left ? L("portalPairCodeExpires", { time: Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0") }) : L("portalPairCodeExpired");
        if (!left) { clearInterval(countdown); $("[data-pairing-card]").hidden = true; }
      };
      tick(); countdown = setInterval(tick, 1000);
    } catch (error) {
      // A bundle that doesn't share, or none running: the way to connect another device instead.
      $("[data-pairing-expiry]").textContent = error?.message || "";
      $("[data-pairing-help]").hidden = !["PAIRING_UNSUPPORTED", "NO_ACTIVE_BUNDLE"].includes(error?.code);
    }
  }
  button.onclick = () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    panel.hidden = !open;
    if (open && call) void issue(); else if (open) $("[data-pairing-help]").hidden = false; else clearInterval(countdown);
  };
  $("[data-pairing-new]").onclick = () => void issue();
  $("[data-pairing-close]").onclick = close;
}

// The device poll re-renders the list; keep the count in the head in step.
export function updateDevicesCount(list) {
  const count = document.getElementById("devicesCount");
  if (document.body.dataset.deviceSlots === "true") return; // the slots view keeps its own count (#349)
  if (count && list && list.deviceLimit) count.textContent = devicesCount((list.devices || []).length, list.deviceLimit);
}
