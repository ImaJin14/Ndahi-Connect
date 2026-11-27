// Device slots (#349, canvas: PhoneDevices; owner 27 Nov): a running Personal
// Unlimited bundle's slots on the Devices page. Each slot: the device, online or
// last seen, its masked Wi-Fi address, and Remove (an inline confirm with the
// PIN; the slot frees once the router confirms). Replace shows only on a device
// that isn't in a slot (it opens Replace a device, #350); a phone that holds a
// slot gets "Show a pairing code" (#407) instead. Other bundles keep today's page.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { wifiHint } from "./wifi-pairing.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const PHONE = "M7 2h10v20H7ZM11 18h2", LAPTOP = "M4 5h16v11H4ZM2 19h20", PLUS = "M12 5v14M5 12h14";
const icon = (path) => `<span class="portal-slot__ic" aria-hidden="true"><svg width="20" height="20" viewBox="0 0 24 24" focusable="false" fill="none" stroke="#003b2b" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"></path></svg></span>`;
const ago = (at) => { const minutes = Math.max(1, Math.round((Date.now() - Date.parse(at)) / 60000)); return minutes < 60 ? L("slotsMinutesAgo", { count: minutes }) : minutes < 2880 ? L("slotsHoursAgo", { count: Math.round(minutes / 60) }) : L("slotsDaysAgo", { count: Math.round(minutes / 1440) }); };
function terms(slots) {
  const hours = Number(slots.validityHours), days = hours / 24;
  const length = !hours ? "" : Number.isInteger(days) ? L(days === 1 ? "slotsOneDay" : "slotsDays", { count: days }) : L(hours === 1 ? "slotsOneHour" : "slotsHours", { count: hours });
  return [slots.plan, length, L(slots.total === 1 ? "slotsOneDevice" : "slotsDevices", { count: slots.total })].filter(Boolean).join(" · ");
}
const replaceHref = (row) => { const hint = wifiHint(); return "/replace-device.html?" + new URLSearchParams({ slot: row.id, ...(hint ? { mac: hint.mac, address: hint.address } : {}) }); };

export function slotsCount(slots) { return L("slotsCount", { used: slots.rows.length, total: slots.total }); }
export function deviceSlotsContent(slots) {
  const mine = slots.rows.some((row) => row.current), full = slots.rows.length >= slots.total;
  const cards = [];
  slots.rows.forEach((row, i) => {
    const name = row.current ? L("slotsThisPhone") : row.name || L("slotsUnnamed");
    const meta = row.removing ? L("slotsRemoving") : row.online ? L("slotsOnlineNow") : row.lastSeenAt ? L("slotsLastSeen", { ago: ago(row.lastSeenAt) }) : L("slotsOffline");
    cards.push(`<div class="portal-slot" data-slot-row="${h(row.id)}"><div class="portal-slot__top">${icon(/laptop|book|pc\b|desktop|windows|mac/i.test(row.name || "") ? LAPTOP : PHONE)}<span class="portal-slot__who"><span class="portal-slot__n">${h(L("slotsSlot", { n: i + 1 }))}</span><strong>${h(name)}</strong><span class="portal-slot__meta">${h(meta)}</span></span><span class="portal-slot__dot${row.online ? " portal-slot__dot--on" : ""}" aria-hidden="true"></span></div>`
      + (row.removing ? "" : `<div class="portal-slot__row"><span class="portal-slot__mac">${h(L("slotsAddress", { mac: row.mac }))}</span>${mine ? "" : `<a class="portal-slot__sm" href="${h(replaceHref(row))}">${h(L("slotsReplace"))}</a>`}<button type="button" class="portal-slot__sm portal-slot__remove" data-slot-remove="${h(row.id)}" aria-label="${h(L("slotsRemoveName", { name }))}">${h(L("slotsRemove"))}</button></div>`)
      + `<div class="portal-slot__ask" data-slot-ask="${h(row.id)}" role="alertdialog" aria-label="${h(L("slotsRemoveName", { name }))}" hidden><span>${h(L("slotsRemoveAsk", { name }))}</span><label class="portal-slot__pinlabel">${h(L("slotsPin"))}<input class="portal-slot__pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4,6}" maxlength="6"></label><span class="portal-slot__error" role="alert"></span><span class="portal-slot__asks"><button type="button" class="portal-slot__sm" data-slot-keep>${h(L("slotsKeep"))}</button><button type="button" class="portal-slot__sm portal-slot__sm--danger" data-slot-confirm>${h(L("slotsRemove"))}</button></span></div></div>`);
  });
  for (let i = slots.rows.length; i < slots.total; i++) cards.push(`<div class="portal-slot portal-slot--empty"><div class="portal-slot__top">${icon(PLUS)}<span class="portal-slot__who"><span class="portal-slot__n">${h(L("slotsSlot", { n: i + 1 }))}</span><strong>${h(L("slotsEmpty"))}</strong><span class="portal-slot__meta">${h(L("slotsFree"))}</span></span></div><p class="portal-slot__fill">${h(L("slotsFill"))}</p></div>`);
  const foot = full && !mine ? `<a class="portal-slots__btn" href="${h("/replace-device.html" + (wifiHint() ? "?" + new URLSearchParams({ mac: wifiHint().mac, address: wifiHint().address }) : ""))}">${h(L("slotsReplaceDevice"))}</a>`
    : `<button type="button" class="portal-slots__btn" data-slots-code>${h(L("slotsShowCode"))}</button>`;
  return `<div class="portal-slots" data-device-slots><p class="portal-slots__lede"><strong>${h(terms(slots))}.</strong> ${h(L("slotsLede"))}</p>${cards.join("")}`
    + (full ? `<p class="portal-slots__full"><strong>${h(L("slotsFullTitle"))}</strong> ${h(L("slotsFullBody"))}</p>` : "")
    + `<details class="portal-slots__faq"><summary>${h(L("slotsFaq"))}</summary><p>${h(L("slotsFaqBody"))}</p></details><div class="portal-slots__foot">${foot}</div></div>`;
}
// Remove: the drawn inline confirm, with the PIN (owner); the slot frees once the router confirms.
export function mountDeviceSlots(root, { call, onChanged }) {
  for (const button of root.querySelectorAll("[data-slot-remove]")) button.onclick = () => {
    const ask = root.querySelector(`[data-slot-ask="${CSS.escape(button.dataset.slotRemove)}"]`);
    ask.hidden = false; ask.querySelector("input").focus();
  };
  for (const ask of root.querySelectorAll("[data-slot-ask]")) {
    ask.querySelector("[data-slot-keep]").onclick = () => { ask.hidden = true; ask.querySelector("input").value = ""; ask.querySelector(".portal-slot__error").textContent = ""; };
    ask.querySelector("[data-slot-confirm]").onclick = async (event) => {
      const button = event.currentTarget, pin = ask.querySelector("input").value, error = ask.querySelector(".portal-slot__error");
      if (!/^\d{4,6}$/.test(pin)) { error.textContent = L("slotsPinNeeded"); return; }
      button.disabled = true; error.textContent = "";
      try { await call("/api/account/device-management/forget", { method: "POST", body: JSON.stringify({ approvalId: ask.dataset.slotAsk, pin }) }); await onChanged(); }
      catch (failure) { error.textContent = failure.message || L("slotsRemoveFailed"); button.disabled = false; }
    };
  }
  // "Show a pairing code" opens the code panel under Add another device (#407).
  const code = root.querySelector("[data-slots-code]");
  if (code) code.onclick = () => { const add = document.querySelector("[data-devices-add]"); if (add && add.getAttribute("aria-expanded") !== "true") add.click(); document.getElementById("devicesAddHelp")?.scrollIntoView({ block: "nearest" }); };
}
