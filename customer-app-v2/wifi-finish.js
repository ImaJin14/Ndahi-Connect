// Finish Wi-Fi sign-in (#372, canvas: PhoneWifiConnected; owner 27 Nov: tap to
// connect, as drawn). After a PIN or passkey sign-in on NDAHI Wi-Fi with a
// running bundle, the device takes a slot only when the customer taps Connect
// this device. The facts are this device (from the browser, a display hint
// only), the bundle and what's left of it, and the device slots of a Personal
// Unlimited bundle. An earlier bundle keeps its own terms: its data left.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { deviceKind } from "/shared/device-kind.js";
import { fmt, timeLeft } from "./active-bundle.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
export const isPhone = (userAgent) => ["android_phone", "iphone"].includes(deviceKind(userAgent));
export function finishFacts({ bundle, slots, userAgent = navigator.userAgent, now = Date.now() }) {
  const kind = deviceKind(userAgent), rows = [];
  if (kind) rows.push([L("finishThisDevice"), L("finishKind_" + kind)]);
  if (bundle) {
    const data = Number.isFinite(bundle.quotaBytes) && bundle.quotaBytes !== null, ends = Date.parse(bundle.expiresAt);
    const left = data ? fmt(Math.max(0, bundle.quotaBytes - (Number(bundle.usedBytes) || 0))) : Number.isFinite(ends) ? timeLeft(ends - now) : "";
    rows.push([L("finishBundle"), [bundle.plan?.name || "", left ? L("finishLeft", { left }) : ""].filter(Boolean).join(" · ")]);
  }
  if (slots && Number.isInteger(slots.total)) rows.push([L("finishSlots"), L("finishSlotsUsed", { used: (slots.rows || []).length, total: slots.total })]);
  return rows.map(([term, value]) => `<div class="wifi-finish__row"><dt>${h(term)}</dt><dd>${h(value)}</dd></div>`).join("");
}
