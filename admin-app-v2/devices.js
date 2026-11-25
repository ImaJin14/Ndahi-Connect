// Live Wi-Fi devices (canvas: AdminDevices; #381). One row per customer from
// the last router reading (owner, 24 Nov), and a pop-up listing each device
// with Disconnect, Disconnect all and Open customer.
// - Disconnect ends the session only (`retainApproval`); Revoke device on the
//   customer's page frees a slot.
// - A Home WISP router is one device: NDAHI can't see what is behind it.
// - The access points run standalone and report nothing, so the access-point
//   filter has only "All access points" and the Access point and Signal cells
//   show "—" (owner, 25 Nov).
// The rows come with the device counts every 5 seconds; the screen updates in
// place, an open pop-up included.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const ZONE = "Africa/Douala";
const day = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE });
const clock = (at) => new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
// "08:12" today, "Mon 18:02" on another day.
const since = (value) => {
  if (!Number.isFinite(Date.parse(value))) return "—";
  if (day(value) === day(Date.now())) return clock(value);
  const weekday = new Date(value).toLocaleDateString(locale(), { weekday: "short", timeZone: ZONE }).replace(/\.$/, "");
  return `${weekday[0].toUpperCase()}${weekday.slice(1)} ${clock(value)}`;
};
// "ends Wed 25 Nov", or "ends today 21:10".
const ends = (value) => {
  if (!Number.isFinite(Date.parse(value))) return "";
  if (day(value) === day(Date.now())) return L("adminDevicesEndsToday", { time: clock(value) });
  return L("adminDevicesEnds", { date: new Date(value).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: ZONE }).replace(/,/g, "") });
};
// "5.0 GB", "310 MB", as drawn (decimal units).
const data = (bytes) => {
  const n = Number(bytes) || 0;
  return n >= 1e9 ? L("adminDevicesGb", { n: (n / 1e9).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 }) })
    : L("adminDevicesMb", { n: Math.round(n / 1e6).toLocaleString(locale()) });
};
// Shown masked, as drawn: the last three parts only.
const masked = (mac) => (mac ? "••:" + String(mac).split(":").slice(-3).join(":") : "—");
// "7 days", "24 hours", "5 hours", as drawn.
const validity = (hours) => (!hours ? "" : hours > 24 && hours % 24 === 0 ? L("adminDevicesDays", { n: hours / 24 }) : L(hours === 1 ? "adminDevicesHour" : "adminDevicesHours", { n: hours }));
const who = (row) => row.name || (row.code ? L("adminDevicesVoucher", { code: row.code }) : row.customerId ? L("adminUnnamedCustomer") : L("adminDevicesVoucherOnly"));
const plan = (row) => row.router ? L("adminDevicesPlanHome")
  : row.accessType === "personal_unlimited" ? [L("adminDevicesPlanPersonal"), validity(row.validityHours)].filter(Boolean).join(" · ")
    : L("adminDevicesPlanLegacy", { plan: row.planName || L("adminDevicesPlanUnknown") });
const full = (row) => Boolean(row.slots) && row.devices.length >= row.slots;
const count = (row) => row.router ? L("adminDevicesOneRouter")
  : row.slots ? L(row.slots === 1 ? "adminDevicesSlotsOne" : "adminDevicesSlots", { n: row.devices.length, slots: row.slots })
    : L(row.devices.length === 1 ? "adminDevicesCountOne" : "adminDevicesCount", { n: row.devices.length });
const pending = (d) => d.disconnect && ["disconnecting", "retrying"].includes(d.disconnect.status);

// The line beside the title: "● 9 devices · 5 customers online · updated 20 s ago".
export function liveSummaryText(summary, rows) {
  if (summary.live === false) return L("adminWifiNotLive");
  if (summary.state === "failed") return L("adminWifiFailed");
  const devices = rows.reduce((n, row) => n + row.devices.length, 0);
  const age = Number.isFinite(Date.parse(summary.syncedAt)) ? Math.max(0, Math.round((Date.now() - Date.parse(summary.syncedAt)) / 1000)) : null;
  const updated = age === null ? "" : age < 60 ? L("adminDevicesUpdatedSeconds", { n: age }) : age < 3600 ? L("adminDevicesUpdatedMinutes", { n: Math.round(age / 60) }) : L("adminDevicesUpdatedHours", { n: Math.round(age / 3600) });
  return [L(devices === 1 ? "adminDevicesSummaryOne" : "adminDevicesSummary", { n: devices }), L(rows.length === 1 ? "adminDevicesCustomersOne" : "adminDevicesCustomers", { n: rows.length }), updated].filter(Boolean).join(" · ");
}

export function mountLiveDevices(container, { call, canManage, refresh }) {
  let rows = [], query = "", openId = "", returnTo = "";
  container.innerHTML = `<div class="admin-devices__bar"><div class="admin-devices__aps" role="group" aria-label="${h(L("adminDevicesApLabel"))}"><button type="button" class="admin-devices__ap" aria-pressed="true">${h(L("adminDevicesAllAps"))}</button></div>
<label class="nd-visually-hidden" for="liveDeviceSearch">${h(L("adminDevicesSearchLabel"))}</label><input id="liveDeviceSearch" class="admin-devices__search" type="search" placeholder="${h(L("adminDevicesSearchPlaceholder"))}" autocomplete="off"></div>
<p id="liveDeviceMessage" class="nd-meta admin-devices__message" role="status" aria-live="polite"></p>
<section class="admin-devices__card" aria-label="${h(L("adminDevicesCustomersLabel"))}"><div class="nd-table-wrap"><table class="admin-devices__table"><thead><tr><th scope="col">${h(L("adminDevicesColCustomer"))}</th><th scope="col">${h(L("adminDevicesColOnline"))}</th><th scope="col">${h(L("adminDevicesColAp"))}</th><th scope="col">${h(L("adminDevicesColToday"))}</th><th scope="col">${h(L("adminDevicesColSince"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminDevicesColAction"))}</span></th></tr></thead><tbody id="liveDeviceRows"></tbody></table></div>
<p class="admin-devices__note">${h(L("adminDevicesNote"))}</p></section>
<dialog class="admin-devices__dialog" id="liveDeviceDialog" aria-labelledby="liveDeviceDialogTitle"></dialog>`;
  const $ = (selector) => container.querySelector(selector), dialog = $("#liveDeviceDialog");
  const visible = () => {
    const q = query.trim().toLowerCase();
    return q ? rows.filter((row) => [row.name, row.phone, row.code, row.code?.replace(/-/g, "")].some((value) => value && String(value).toLowerCase().includes(q))) : rows;
  };
  const avatar = (row, size = "") => `<span class="admin-devices__avatar${size}${row.customerId ? "" : " is-code"}" aria-hidden="true">${h(row.customerId ? (who(row)[0] || "?").toUpperCase() : "#")}</span>`;
  function renderRows() {
    // The rows are redrawn with each reading; a focused row button keeps focus.
    const focused = document.activeElement?.dataset?.liveRow;
    const list = visible();
    $("#liveDeviceRows").innerHTML = list.length ? list.map((row) => `<tr${row.id === openId ? ' class="is-open"' : ""}><td><span class="admin-devices__who">${avatar(row)}<span><strong>${h(who(row))}</strong><span class="admin-devices__plan">${h(plan(row))}</span></span></span></td>
<td><span class="admin-devices__count${full(row) ? " is-full" : ""}">${h(count(row))}</span></td><td>—</td><td>${h(data(row.todayBytes))}</td><td>${h(since(row.since))}</td>
<td class="admin-devices__go"><button type="button" class="admin-devices__view" data-live-row="${h(row.id)}" aria-haspopup="dialog" aria-label="${h(L("adminDevicesViewLabel", { name: who(row) }))}">${h(row.devices.length > 1 ? L("adminDevicesView", { n: row.devices.length }) : L("adminDevicesViewOne"))}</button></td></tr>`).join("")
      : `<tr><td colspan="6" class="admin-devices__empty">${h(L(rows.length ? "adminDevicesNoMatch" : "adminDevicesNone"))}</td></tr>`;
    container.querySelectorAll("[data-live-row]").forEach((b) => { b.onclick = () => openRow(b.dataset.liveRow); });
    if (focused) container.querySelector(`[data-live-row="${CSS.escape(focused)}"]`)?.focus();
  }
  function renderDialog() {
    const row = rows.find((r) => r.id === openId) || dialog.lastRow;
    if (!row) return;
    dialog.lastRow = row;
    const live = rows.some((r) => r.id === openId), devices = live ? row.devices : [];
    const slotText = row.router ? L("adminDevicesBehindRouter") : row.slots ? L(row.slots === 1 ? "adminDevicesDeviceSlotsOne" : "adminDevicesDeviceSlots", { n: devices.length, slots: row.slots }) : L("adminDevicesCurrentRule");
    const focused = document.activeElement && dialog.contains(document.activeElement) ? document.activeElement.dataset.focusKey : "";
    dialog.innerHTML = `<div class="admin-devices__dhead">${avatar(row, " admin-devices__avatar--lg")}<div class="admin-devices__dtitle"><h2 id="liveDeviceDialogTitle">${h(who(row))} · ${h(row.router ? L("adminDevicesRouterOnline") : L(devices.length === 1 ? "adminDevicesOnlineOne" : "adminDevicesOnline", { n: devices.length }))}</h2>
<p>${h([plan(row), slotText, ends(row.endsAt)].filter(Boolean).join(" · "))}</p></div><button type="button" class="admin-devices__close" data-focus-key="close" aria-label="${h(L("adminDevicesClose"))}">×</button></div>
${row.slots && devices.length >= row.slots ? `<p class="admin-devices__full">${h(L("adminDevicesFull"))}</p>` : ""}
<table class="admin-devices__table admin-devices__dtable"><thead><tr><th scope="col">${h(L("adminDevicesColDevice"))}</th><th scope="col">${h(L("adminDevicesColAp"))}</th><th scope="col">${h(L("adminDevicesColSignal"))}</th><th scope="col">${h(L("adminDevicesColToday"))}</th><th scope="col">${h(L("adminDevicesColSince"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminDevicesColAction"))}</span></th></tr></thead>
<tbody>${devices.map((d) => {
      const name = d.router ? L("adminDevicesHomeRouter") : d.name || L("adminUnnamedDevice"), slot = d.router ? L("adminDevicesRegisteredRouter") : row.slots ? (d.slot ? L("adminDevicesSlot", { n: d.slot }) : L("adminDevicesNoSlot")) : L("adminDevicesCurrentPlan");
      const blocked = pending(d) || (!d.router && (!d.fresh || !d.sessionId || !d.startedAt));
      return `<tr><td><strong class="admin-devices__dname">${h(name)}</strong><span class="admin-devices__mono">${h(masked(d.mac))} · ${h(slot)}</span></td><td>—</td><td>—</td><td>${h(data(d.todayBytes))}</td><td>${h(since(d.startedAt))}</td>
<td class="admin-devices__go">${canManage ? `<button type="button" class="admin-devices__kick" data-focus-key="${h(d.id)}" data-live-device="${h(d.id)}" ${blocked ? "disabled" : ""} aria-label="${h(L("adminDevicesKickLabel", { device: name, name: who(row) }))}">${h(L(pending(d) ? "adminDisconnecting" : "adminDisconnect"))}</button>` : ""}</td></tr>`;
    }).join("")}</tbody></table>
${devices.length ? "" : `<p class="admin-devices__gone" role="status">${h(L("adminDevicesAllGone"))}</p>`}
<p class="admin-devices__dnote">${h(L("adminDevicesDisconnectNote", { revoke: "%REVOKE%" })).replace("%REVOKE%", `<strong>${h(L("adminDevicesRevoke"))}</strong>`)}</p>
<div class="admin-devices__dfoot"><a class="admin-devices__view admin-devices__open${row.customerId ? "" : " is-hidden"}" data-focus-key="open" href="/dashboard#customer/${encodeURIComponent(row.customerId || "")}"${row.customerId ? "" : ' tabindex="-1" aria-hidden="true"'}>${h(L("adminDevicesOpenCustomer"))}</a>${canManage && devices.length ? `<button type="button" class="admin-devices__all" data-focus-key="all" data-live-all>${h(L("adminDevicesDisconnectAll", { n: devices.length }))}</button>` : ""}</div>`;
    dialog.querySelector(".admin-devices__close").onclick = () => dialog.close();
    // Open customer leaves the screen: the pop-up closes first.
    dialog.querySelector(".admin-devices__open").onclick = () => dialog.close();
    dialog.querySelectorAll("[data-live-device]").forEach((b) => { b.onclick = () => kick(row, row.devices.find((d) => d.id === b.dataset.liveDevice), b); });
    const all = dialog.querySelector("[data-live-all]");
    if (all) all.onclick = () => kickAll(row, all);
    if (focused) dialog.querySelector(`[data-focus-key="${CSS.escape(focused)}"]`)?.focus();
  }
  function openRow(id) {
    openId = id; returnTo = id;
    renderRows(); renderDialog();
    if (!dialog.open) dialog.showModal();
    dialog.querySelector(".admin-devices__close")?.focus();
  }
  dialog.addEventListener("close", () => {
    openId = ""; dialog.lastRow = null; renderRows();
    container.querySelector(`[data-live-row="${CSS.escape(returnTo)}"]`)?.focus();
  });
  // Clicking the shade outside the pop-up closes it, like ×. Leaving the
  // screen (Open customer, the menu) closes it too, so no hidden pop-up keeps
  // the rest of the page inert.
  dialog.addEventListener("click", (event) => { if (event.target === dialog) dialog.close(); });
  window.addEventListener("hashchange", () => { if (dialog.open) dialog.close(); });
  async function act(button, task) {
    if (button) button.disabled = true;
    $("#liveDeviceMessage").textContent = "";
    try { await task(); await refresh(); }
    catch (error) { $("#liveDeviceMessage").textContent = error.message; if (dialog.open) dialog.close(); }
    finally { if (button?.isConnected) button.disabled = false; }
  }
  const kick = (row, d, button) => act(button, () => call("/api/admin/wifi-devices/disconnect", { method: "POST",
    body: JSON.stringify(d.router ? { voucherId: row.voucherId } : { voucherId: row.voucherId, mac: d.mac, sessionId: d.sessionId, startedAt: d.startedAt, retainApproval: true }) }));
  const kickAll = (row, button) => act(button, () => call("/api/admin/wifi-devices/disconnect-all", { method: "POST",
    body: JSON.stringify(row.customerId ? { customerId: row.customerId } : { voucherId: row.voucherId }) }));
  $("#liveDeviceSearch").oninput = (event) => { query = event.target.value; renderRows(); };
  return {
    // Called with each reading (summary plus rows).
    update(result) {
      rows = Array.isArray(result?.customers) ? result.customers : [];
      renderRows();
      if (dialog.open) renderDialog();
    },
  };
}
