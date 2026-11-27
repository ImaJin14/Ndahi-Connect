// Redesigned Customers (canvas: AdminCustomers) and customer detail
// (AdminCustomerDetail). The list reads each customer's summary from the
// records API; the detail page composes existing admin APIs. Row and support
// actions keep v1's data attributes, so the dashboard's delegated click
// handler runs them (with its confirmations).
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { mountRecords } from "/records.js";
import { maskPhone, paymentFor, paymentMethod, paymentStatus, saveFile } from "/payments.js";
import { requestAdminActionProof } from "/action-proof.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const ZONE = "Africa/Douala";
const gb = (bytes) => `${(Math.max(0, Number(bytes) || 0) / 1e9).toLocaleString(locale(), { maximumFractionDigits: 1 })} GB`;
const day = (value, extra) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE, ...extra }).replace(/\bSept\b/, "Sep") : "—";
};
const VOUCHER_WORDS = { expired: "adminVoucherExpired", exhausted: "adminVoucherUsedUp", revoked: "adminVoucherDisabled", suspended: "adminVoucherSuspended", refunded: "adminVoucherRefunded", replaced: "adminVoucherReplaced", renewed: "adminVoucherRenewed", switched: "adminVoucherSwitched", available: "adminVoucherNotUsed" };
// Store order pills, worded as on the canvas ("To prepare", "Collected").
const ORDER = { awaiting_payment: ["adminOrderAwaitingPayment", "warning"], preparing: ["adminOrderPreparing", "warning"], ready: ["adminOrderReady", "info"], collected: ["adminOrderCollected", ""], review: ["adminOrderReview", "danger"], cancelled: ["adminOrderCancelled", ""], expired: ["adminOrderExpired", ""] };
const orderStatus = (status) => {
  const [key, tone] = ORDER[status] || [null, ""];
  return `<span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(key ? L(key) : String(status || "—").replace(/_/g, " "))}</span>`;
};
// "+237 670 12 34 56" for a Cameroon number; anything else as stored.
const formatPhone = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
  return digits.length === 9 ? `+237 ${digits.slice(0, 3)} ${digits.slice(3, 5)} ${digits.slice(5, 7)} ${digits.slice(7)}` : phone || "";
};
const customerHref = (id) => `/dashboard#customer/${encodeURIComponent(id)}`;
const statusPill = (c) => c.status === "suspended"
  ? `<span class="nd-pill nd-pill--danger">${h(L("adminCustomerSuspended"))}</span>`
  : `<span class="nd-pill nd-pill--success">${h(L("adminCustomerActive"))}</span>`;
const suspendButton = (c, block) => {
  const suspended = c.status === "suspended";
  return `<button type="button" class="nd-btn ${block ? "nd-btn--block" : "nd-btn--compact"} nd-btn--secondary${suspended ? "" : " admin-btn--danger"}" data-customer="${h(c.id)}" data-suspended="${suspended}">${h(L(suspended ? (block ? "adminRestoreCustomer" : "adminRestore") : (block ? "adminSuspendCustomer" : "adminSuspend")))}</button>`;
};

// Time left on an Unlimited bundle (canvas: "2 d 14 h left", "22 days left"),
// from the server's count.
export function timeLeft(ms) {
  if (!Number.isFinite(ms)) return "";
  const minutes = Math.max(0, Math.floor(ms / 6e4)), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  if (days >= 3) return L("adminDaysLeft", { count: days });
  if (days >= 1) return L("adminDaysHoursLeft", { days, hours });
  if (hours >= 1) return L("adminHoursLeft", { count: hours });
  return L("adminMinutesLeft", { count: minutes % 60 });
}

// Customer detail's Time left, as drawn: "2 days 14 h", "1 day 3 h", "14 h".
function detailTimeLeft(ms) {
  if (!Number.isFinite(ms)) return "—";
  const minutes = Math.max(0, Math.floor(ms / 6e4)), days = Math.floor(minutes / 1440), hours = Math.floor((minutes % 1440) / 60);
  if (days >= 1) return L(days === 1 ? "adminDayHoursLeftRow" : "adminDaysHoursLeftRow", { days, hours });
  return hours >= 1 ? L("adminHoursLeftRow", { count: hours }) : L("adminMinutesLeftRow", { count: minutes % 60 });
}
const clock = (value) => new Date(value).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
// "25 Nov · 18:03"; with `weekday`, "Wed 25 Nov 18:03" (the Devices line).
const when = (value, weekday) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  return weekday ? `${day(value, { weekday: "short" }).replace(",", "")} ${clock(value)}` : `${day(value)} · ${clock(value)}`;
};

// "[PLAN 2] · 2 d 14 h left" for an Unlimited bundle; an earlier bundle keeps
// its own terms: "[PLAN 2] · 1.8 GB used · 3.2 GB left". Then "Payment
// waiting", or in the list "None" once nothing runs (Last active says when it
// ended); a suspended customer keeps "[PLAN 1] · expired" (owner, #342:
// https://github.com/ImaJin14/Ndahi-Connect/issues/342#issuecomment-7149689512).
function bundleText(summary, customer) {
  const bundle = summary && summary.bundle;
  if (bundle && bundle.status === "active" && bundle.accessType && Number.isFinite(bundle.msLeft)) return `${bundle.name || "—"} · ${timeLeft(bundle.msLeft)}`;
  // Unlimited bundles show data used, never data left.
  // Staff see what was actually used on every plan; fixed plans also show what is left.
  if (bundle && bundle.status === "active") return `${bundle.name || "—"} · ${L("adminDataUsed", { amount: gb(bundle.usedBytes) })}${bundle.quotaBytes == null ? "" : ` · ${L("adminDataLeft", { amount: gb(bundle.remainingBytes) })}`}`;
  if (summary && summary.paymentWaiting) return L("adminPaymentWaiting");
  if (bundle && customer && customer.status !== "suspended") return L("adminFieldNone");
  if (bundle) return `${bundle.name || "—"} · ${L(VOUCHER_WORDS[bundle.status] || "adminVoucherExpired").toLowerCase()}`;
  return L("adminFieldNone");
}
// Unlimited: device slots used / slots (a registered device holds its slot
// offline too, #334). Earlier bundles: devices online / their device limit.
const devicesText = (summary) => {
  const bundle = summary && summary.bundle;
  if (bundle && bundle.status === "active" && bundle.accessType) return `${bundle.slotsUsed ?? 0} / ${bundle.deviceSlots ?? "—"}`;
  return bundle && bundle.status === "active" ? `${bundle.activeDevices} / ${bundle.deviceLimit == null ? "—" : bundle.deviceLimit}` : "0";
};

// Last active (canvas: AdminCustomers): "Online now", "Today", "Today · ended
// 1 Nov", "Ended 4 Nov" or "Joined 3 Oct", from the customer's activity.
const sameDay = (a, b) => new Date(a).toLocaleDateString("en-CA", { timeZone: ZONE }) === new Date(b).toLocaleDateString("en-CA", { timeZone: ZONE });
const seenDay = (value) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  return sameDay(at, Date.now()) ? L("adminToday") : sameDay(at, Date.now() - 864e5) ? L("adminYesterday") : day(value);
};
function lastActive(a) {
  if (!a) return "—";
  if (a.online) return L("adminOnlineNow");
  if (a.neverBought) return L("adminJoinedOn", { date: day(a.joinedAt) });
  if (a.hasBundle) return seenDay(a.lastSeenAt);
  const ended = day(a.lastEndedAt);
  return a.lastSeenAt && sameDay(a.lastSeenAt, Date.now()) ? `${L("adminToday")} · ${L("adminEndedLower", { date: ended })}` : L("adminEndedOn", { date: ended });
}
function statePill(c) {
  const a = c.activity || { state: c.status === "suspended" ? "suspended" : "active" };
  if (a.state === "suspended") return `<span class="nd-pill nd-pill--danger">${h(L("adminCustomerSuspended"))}</span>`;
  if (a.state === "stale") return `<span class="nd-pill nd-pill--warning">${h(a.neverBought ? L("adminStaleNever") : L("adminStaleDays", { days: a.idleDays }))}</span>`;
  return `<span class="nd-pill nd-pill--success">${h(L("adminCustomerActive"))}</span>`;
}
const FILTERS = [["", "adminFilterAll", "all"], ["active", "adminFilterActive", "active"], ["stale", "adminFilterStale", "stale"], ["suspended", "adminFilterSuspended", "suspended"]];
const STALE_DAYS = [7, 14, 30, 60, 90];

// The list with its Active / Stale / Suspended chips, "Stale after" and, in the
// stale view, the export (canvas: AdminCustomers).
// "[PLAN 1] · 1 GB · 1 day" for the gift bundle choice.
const bundleChoice = (b) => [b.name, b.quotaGb == null ? L("adminUnlimited") : `${b.quotaGb} GB`,
  b.validityHours % 24 === 0 ? L(b.validityHours === 24 ? "adminOneDay" : "adminDays", { count: b.validityHours / 24 }) : L("adminHours", { count: b.validityHours })].join(" · ");
const requestKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^A-Za-z0-9_-]/g, "");

export function mountCustomerRecords(container, { call, searchHost, filtersHost = null, noteHost = null, api = "", bundles = [] }) {
  const filter = { activity: "", staleDays: 30 };
  let lastQ = "", list;
  // Bulk actions (canvas: AdminCustomers, #257): the rows ticked across pages,
  // the open panel, and one request key per send until it succeeds.
  const selected = new Map(), bulk = { panel: null, keys: {} };
  if (filtersHost) {
    filtersHost.innerHTML = `<div class="admin-customers__filters"><div class="nd-chips admin-customers__chips" role="group" aria-label="${h(L("adminShowCustomers"))}">${FILTERS.map(([value, key, count]) =>
      `<button type="button" class="nd-chip admin-customers__chip" aria-pressed="${value === filter.activity}" data-activity="${value}">${h(L(key))} <span class="admin-customers__count" data-count="${count}">0</span></button>`).join("")}</div>
      <label class="admin-customers__stale">${h(L("adminStaleAfter"))}<select class="admin-customers__days">${STALE_DAYS.map((d) => `<option value="${d}"${d === filter.staleDays ? " selected" : ""}>${h(L("adminDays", { count: d }))}</option>`).join("")}</select></label></div>
      <div class="admin-customers__banner" hidden><span class="admin-customers__banner-text"></span><button type="button" class="admin-customers__export">${h(L("adminExportList"))}</button></div>
      <section class="admin-customers__bulk" aria-label="${h(L("adminBulkActions"))}" hidden><div class="admin-customers__bulk-row"><strong class="admin-customers__bulk-count"></strong>
        <button type="button" class="admin-customers__bulk-btn" data-bulk-open="gift" aria-pressed="false">${h(L("adminBulkGift"))}</button><button type="button" class="admin-customers__bulk-btn" data-bulk-open="message" aria-pressed="false">${h(L("adminBulkMessage"))}</button><button type="button" class="admin-customers__bulk-clear">${h(L("adminBulkClear"))}</button></div>
        <div class="admin-customers__bulk-panel" data-bulk-panel="gift" hidden><label for="bulkGiftBundle">${h(L("adminFieldBundle"))}</label><select id="bulkGiftBundle">${bundles.filter((b) => b.active !== false).map((b) => `<option value="${h(b.id)}">${h(bundleChoice(b))}</option>`).join("")}</select>
          <span class="admin-customers__bulk-note">${h(L("adminBulkGiftNote"))}</span><button type="button" class="admin-customers__bulk-send" data-bulk-send="gift"></button></div>
        <div class="admin-customers__bulk-panel admin-customers__bulk-panel--message" data-bulk-panel="message" hidden><label for="bulkMessageText">${h(L("adminBulkMessageLabel"))}</label><textarea id="bulkMessageText" maxlength="500"></textarea>
          <div class="admin-customers__bulk-end"><button type="button" class="admin-customers__bulk-send" data-bulk-send="message"></button></div></div>
        <p class="admin-customers__bulk-error" role="alert" hidden></p></section>
      <p class="admin-customers__sent" role="status" hidden></p>`;
    filtersHost.querySelectorAll("[data-activity]").forEach((chip) => {
      chip.onclick = () => {
        filter.activity = chip.dataset.activity;
        filtersHost.querySelectorAll("[data-activity]").forEach((other) => other.setAttribute("aria-pressed", String(other === chip)));
        void list?.reload();
      };
    });
    filtersHost.querySelector(".admin-customers__days").onchange = (event) => { filter.staleDays = Number(event.target.value); void list?.reload(); };
    filtersHost.querySelectorAll("[data-bulk-open]").forEach((button) => {
      button.onclick = () => { bulk.panel = bulk.panel === button.dataset.bulkOpen ? null : button.dataset.bulkOpen; renderBulk(); };
    });
    filtersHost.querySelector(".admin-customers__bulk-clear").onclick = () => { selected.clear(); bulk.panel = null; syncRows(); renderBulk(); };
    filtersHost.querySelectorAll("[data-bulk-send]").forEach((button) => { button.onclick = () => void sendBulk(button); });
    filtersHost.querySelector(".admin-customers__export").onclick = async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const params = new URLSearchParams({ collection: "customers", activity: filter.activity, staleDays: filter.staleDays, q: lastQ });
        const response = await fetch(`${api}/api/admin/export?${params}`, { credentials: "include" });
        if (!response.ok) throw Error(L("adminExportFailed"));
        saveFile(`ndahi-customers-${filter.activity || "all"}.csv`, await response.blob());
      } catch (error) { button.closest(".admin-customers__banner").querySelector(".admin-customers__banner-text").textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  const bulkHost = () => filtersHost && filtersHost.querySelector(".admin-customers__bulk");
  function renderBulk() {
    const host = bulkHost();
    if (!host) return;
    host.hidden = !selected.size;
    if (!selected.size) bulk.panel = null;
    host.querySelector(".admin-customers__bulk-count").textContent = L("adminBulkSelected", { count: selected.size });
    host.querySelectorAll("[data-bulk-open]").forEach((button) => button.setAttribute("aria-pressed", String(bulk.panel === button.dataset.bulkOpen)));
    host.querySelectorAll("[data-bulk-panel]").forEach((panel) => { panel.hidden = panel.dataset.bulkPanel !== bulk.panel; });
    host.querySelector('[data-bulk-send="gift"]').textContent = L("adminBulkGiveTo", { count: selected.size });
    host.querySelector('[data-bulk-send="message"]').textContent = L("adminBulkSendTo", { count: selected.size });
  }
  function syncRows() {
    container.querySelectorAll("[data-select]").forEach((box) => {
      box.checked = selected.has(box.dataset.select);
      box.closest("tr").classList.toggle("admin-customers__row--on", box.checked);
    });
    const boxes = [...container.querySelectorAll("[data-select]")], all = container.querySelector("[data-select-all]");
    if (all) all.checked = boxes.length > 0 && boxes.every((box) => box.checked);
  }
  container.addEventListener("change", (event) => {
    const box = event.target.closest("[data-select], [data-select-all]");
    if (!box) return;
    if (box.matches("[data-select-all]")) container.querySelectorAll("[data-select]").forEach((row) => { if (box.checked) selected.set(row.dataset.select, row.dataset.name); else selected.delete(row.dataset.select); });
    else if (box.checked) selected.set(box.dataset.select, box.dataset.name); else selected.delete(box.dataset.select);
    filtersHost?.querySelector(".admin-customers__sent")?.setAttribute("hidden", "");
    syncRows(); renderBulk();
  });
  async function sendBulk(button) {
    const action = button.dataset.bulkSend, host = bulkHost(), error = host.querySelector(".admin-customers__bulk-error");
    const input = { action, customerIds: [...selected.keys()], requestKey: bulk.keys[action] ||= requestKey() };
    if (action === "gift") input.planId = host.querySelector("#bulkGiftBundle").value;
    else input.message = host.querySelector("#bulkMessageText").value;
    error.hidden = true;
    button.disabled = true;
    try {
      const proof = action === "gift" ? await requestAdminActionProof({ call, purpose: "customer_bulk_gift", input }) : {};
      const result = await call("/api/admin/customers/bulk", { method: "POST", body: JSON.stringify({ ...input, ...proof }) });
      delete bulk.keys[action];
      const sent = filtersHost.querySelector(".admin-customers__sent");
      sent.textContent = L(action === "gift" ? "adminBulkGiftDone" : "adminBulkMessageDone", { count: result.done }) +
        (result.skipped && result.skipped.length ? ` · ${L("adminBulkSkipped", { count: result.skipped.length })}` : "");
      sent.hidden = false;
      if (action === "message") host.querySelector("#bulkMessageText").value = "";
      selected.clear(); bulk.panel = null; renderBulk();
      void list?.refresh();
    } catch (failure) {
      if (failure && failure.name === "AbortError") return;
      error.textContent = failure.message || L("adminBulkFailed");
      error.hidden = false;
    } finally { button.disabled = false; }
  }
  const showCounts = (result, { q }) => {
    lastQ = q || "";
    if (noteHost) noteHost.textContent = L("adminCustomersFilterNote", { days: filter.staleDays });
    if (!filtersHost || !result.counts) return;
    for (const [, , key] of FILTERS) filtersHost.querySelector(`[data-count="${key}"]`).textContent = result.counts[key];
    const banner = filtersHost.querySelector(".admin-customers__banner");
    banner.hidden = filter.activity !== "stale";
    if (!banner.hidden) filtersHost.querySelector(".admin-customers__banner-text").innerHTML = L("adminStaleBanner", { count: `<strong>${h(L("adminCustomersCount", { count: result.counts.stale }))}</strong>`, days: filter.staleDays });
  };
  list = mountRecords(container, {
    call,
    collection: "customers",
    params: () => ({ activity: filter.activity, staleDays: filter.staleDays }),
    onResult: (result, state) => { showCounts(result, state); queueMicrotask(syncRows); },
    title: L("adminCustomerList"),
    headers: [{ html: `<input type="checkbox" class="admin-customers__check" data-select-all aria-label="${h(L("adminSelectAllShown"))}">` }, L("adminColCustomer"), L("adminColPhone"), L("adminFieldBundle"), L("adminColLastActive"), L("adminColDevices"), L("adminColState"), { label: L("adminColActions") }],
    empty: L("adminCustomersNone"),
    kit: {
      heading: false,
      statusFilter: false,
      searchHost,
      searchLabel: L("adminCustomersSearch"),
      placeholder: L("adminCustomersPlaceholder"),
      previous: L("adminPagePrevious"),
      next: L("adminPageNext"),
      text: {
        loading: L("adminLoading"),
        failed: L("adminCustomersFailedToLoad"),
        retry: L("adminTryAgain"),
        none: L("adminCustomersNone"),
        summary: (page, pages, total) => L("adminPageSummary", { page, pages, total }),
      },
    },
    row: (c) => `<tr${selected.has(c.id) ? ' class="admin-customers__row--on"' : ""}><td class="admin-customers__select"><input type="checkbox" class="admin-customers__check" data-select="${h(c.id)}" data-name="${h(c.name || "")}" aria-label="${h(L("adminSelectCustomer", { name: c.name || L("adminUnnamedCustomer") }))}"${selected.has(c.id) ? " checked" : ""}></td><td><a class="admin-name" href="${customerHref(c.id)}">${h(c.name || L("adminUnnamedCustomer"))}</a></td><td>${h(maskPhone(c.phone))}</td><td>${h(c.activity && c.activity.neverBought && !(c.summary && c.summary.paymentWaiting) ? L("adminNeverBought") : bundleText(c.summary, c))}</td><td>${h(lastActive(c.activity))}</td><td>${h(devicesText(c.summary))}</td><td>${statePill(c)}</td><td class="admin-customers__actions">${c.activity && c.activity.state === "stale" ? `<a class="nd-btn nd-btn--compact nd-btn--secondary" href="${customerHref(c.id)}">${h(L("adminGiveVoucherShort"))}</a>` : ""}${suspendButton(c)}</td></tr>`,
  });
  return list;
}

// Customer detail. Returns false when the customer can't be shown.
export async function showCustomerDetail(host, { call, id, role, canManage, storeRole, setHead, statusHost }) {
  host.innerHTML = `<p class="nd-meta">${h(L("adminLoading"))}</p>`;
  if (statusHost) statusHost.replaceChildren();
  const found = await call(`/api/admin/records?${new URLSearchParams({ collection: "customers", q: id, pageSize: 20 })}`).catch((error) => ({ error }));
  if (!host.isConnected) return false;
  const c = found.items && found.items.find((item) => item.id === id);
  if (!c) {
    host.innerHTML = `<p class="nd-callout nd-callout--warning" role="status">${h(found.error ? found.error.message || L("adminCustomerFailed") : L("adminCustomerMissing"))}</p>`;
    return false;
  }
  const name = c.name || L("adminUnnamedCustomer");
  setHead({
    title: name,
    // The number masked, as drawn (owner, 26 Nov, #341).
    lede: [c.phone ? `+237 ${maskPhone(c.phone)}` : "", c.email, c.createdAt ? L("adminCustomerSince", { date: day(c.createdAt) }) : ""].filter(Boolean).join(" · "),
    avatar: name.trim().charAt(0).toUpperCase(),
  });
  if (statusHost) statusHost.innerHTML = statusPill(c);
  const bundle = c.summary && c.summary.bundle, active = bundle && bundle.status === "active";
  const row = (label, value) => `<div class="admin-row"><span class="admin-row__label">${h(label)}</span><strong>${h(value)}</strong></div>`;
  // Unlimited (canvas: AdminCustomerDetail, #341): time left, device slots,
  // the end and the Home WISP router. Earlier bundles keep data left and devices.
  const unlimited = active && bundle.accessType, personal = unlimited && bundle.accessType === "personal_unlimited";
  const router = bundle && bundle.homeRouter;
  const rows = (unlimited ? [
    row(L("adminActiveBundle"), bundle.name || "—"),
    row(L("adminTimeLeft"), detailTimeLeft(bundle.msLeft)),
    personal ? row(L("adminDeviceSlotsRow"), L("adminSlotsUsedOf", { used: bundle.slotsUsed ?? 0, total: bundle.deviceSlots ?? "—" })) : "",
    bundle.expiresAt ? row(L("adminEnds"), when(bundle.expiresAt)) : "",
    row(L("adminHomeWispRouter"), router && router.registered ? [router.name, router.mac].filter(Boolean).join(" · ") : L("adminNoneRegistered")),
  ] : [
    row(L("adminActiveBundle"), active ? bundle.name || "—" : bundleText(c.summary)),
    active ? row(L("adminDataLeftLabel"), bundle.remainingBytes == null ? L("adminUnlimited") : L("adminDataOf", { left: gb(bundle.remainingBytes), total: gb(bundle.quotaBytes) })) : "",
    active && bundle.expiresAt ? row(L("adminEnds"), day(bundle.expiresAt)) : "",
    active ? row(L("adminColDevices"), devicesText(c.summary)) : "",
  ]).join("");
  // Support actions as drawn (owner, 26 Nov, #341): Send PIN reset email,
  // Remove lost passkeys (owners; with none it says so), Give a voucher,
  // Revoke current subscription and Suspend. Each confirms and is audited.
  const actions = [
    canManage ? `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-send-pin-reset>${h(L("adminSendPinReset"))}</button>` : "",
    role === "owner" ? (c.passkeys > 0 ? `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-remove-customer-passkeys="${h(c.id)}">${h(L("adminRemoveCustomerPasskeys"))}</button>`
      : `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-no-passkeys>${h(L("adminRemoveCustomerPasskeys"))}</button>`) : "",
    canManage && c.status !== "suspended" ? `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-replace-bundle="${h(c.id)}" data-replace-phone="${h(c.phone || "")}">${h(L("adminGiveVoucher"))}</button>` : "",
    canManage ? `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block admin-btn--danger" data-revoke-subscription>${h(L("adminRevokeSubscription"))}</button>` : "",
    suspendButton(c, true),
    // Change number stays for owners (owner, 26 Nov: the only place to change a
    // customer's sign-in number, #398), below the board's five.
    role === "owner" && c.status !== "suspended" ? `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-change-customer-phone="${h(c.id)}">${h(L("adminChangeCustomerPhone"))}</button>` : "",
  ].join("");
  host.innerHTML = `<div class="admin-subtabs" role="tablist" aria-label="${h(L("adminColCustomer"))}">
  ${[["overview", "adminTabOverview"], ["money", "adminTabMoney"], ["devices", "adminTabDevices"]].map(([tab, key], index) => `<button type="button" role="tab" id="customer-tab-${tab}" aria-controls="customer-panel-${tab}" aria-selected="${index ? "false" : "true"}" tabindex="${index ? "-1" : "0"}" data-customer-tab="${tab}">${h(L(key))}</button>`).join("")}
</div>
<div role="tabpanel" id="customer-panel-overview" aria-labelledby="customer-tab-overview" class="admin-customer__overview">
  <section class="nd-panel admin-rows" aria-label="${h(L("adminFieldBundle"))}">${rows}</section>
  <section class="nd-panel admin-support" aria-labelledby="customerSupportTitle"><h2 class="nd-h2" id="customerSupportTitle">${h(L("adminSupportActions"))}</h2>${actions}<p class="admin-saved" role="status" aria-live="polite" data-support-message></p><p class="nd-meta">${h(L("adminSupportNote"))}</p></section>
</div>
<div role="tabpanel" id="customer-panel-money" aria-labelledby="customer-tab-money" hidden><section class="nd-panel admin-rows" aria-label="${h(L("adminTabMoney"))}" data-customer-money><p class="nd-meta">${h(L("adminLoading"))}</p></section></div>
<div role="tabpanel" id="customer-panel-devices" aria-labelledby="customer-tab-devices" hidden><section class="nd-panel admin-rows" aria-label="${h(L("adminTabDevices"))}" data-customer-devices><p class="nd-meta">${h(L("adminLoading"))}</p></section></div>
<dialog class="admin-dialog" id="customerConfirm" aria-labelledby="customerConfirmTitle"><form class="admin-form" data-customer-confirm><h3 class="nd-h3" id="customerConfirmTitle"></h3><p class="nd-meta" data-confirm-body></p>
  <label class="nd-field" data-confirm-reason hidden><span class="nd-label">${h(L("adminAuditReasonShort"))}</span><input class="nd-input" name="reason" maxlength="300" autocomplete="off"></label>
  <div class="admin-form__actions"><button type="button" class="nd-btn nd-btn--secondary" data-confirm-cancel>${h(L("adminCancel"))}</button><button type="submit" class="nd-btn" data-confirm-go></button></div>
  <p class="admin-saved" role="status" aria-live="polite" data-confirm-message></p></form></dialog>`;
  wireSupport(host, { call, c, bundle, name, context: { call, id, role, canManage, storeRole, setHead, statusHost } });

  // Tabs: click or arrow keys; each tab's content loads the first time it opens.
  const tabs = [...host.querySelectorAll("[data-customer-tab]")], loaded = {};
  const open = (tab, focus) => {
    tabs.forEach((button) => {
      const on = button === tab;
      button.setAttribute("aria-selected", String(on));
      button.tabIndex = on ? 0 : -1;
      host.querySelector("#" + button.getAttribute("aria-controls")).hidden = !on;
    });
    if (focus) tab.focus();
    const name = tab.dataset.customerTab;
    if (!loaded[name]) {
      loaded[name] = true;
      if (name === "money") void loadMoney(host.querySelector("[data-customer-money]"), { call, c, storeRole });
      if (name === "devices") void loadDevices(host.querySelector("[data-customer-devices]"), { call, c, canManage });
    }
  };
  tabs.forEach((tab, index) => {
    tab.onclick = () => open(tab);
    tab.onkeydown = (event) => {
      const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
      if (step) { event.preventDefault(); open(tabs[(index + step + tabs.length) % tabs.length], true); }
    };
  });

  // Home router: shown when NDAHI Home answers for this role.
  if (storeRole) call("/api/admin/home").then((home) => {
    const rowsHost = host.querySelector(".admin-customer__overview .admin-rows");
    if (!rowsHost || !home || !home.enabled) return;
    rowsHost.insertAdjacentHTML("beforeend", row(L("adminHomeRouter"), L((home.households || []).some((x) => x.customerId === c.id) ? "adminLinked" : "adminNotLinked")));
  }).catch(() => {});
  return true;
}

// Payments & orders: the customer's payments (found by customer id) and,
// for owners and operators, their store orders, newest first.
async function loadMoney(panel, { call, c, storeRole }) {
  const [payments, store] = await Promise.all([
    call(`/api/admin/records?${new URLSearchParams({ collection: "payments", q: c.id, pageSize: 50 })}`).catch(() => null),
    storeRole ? call("/api/admin/store").catch(() => null) : null,
  ]);
  if (!panel.isConnected) return;
  const lang = currentLanguage();
  const entries = [
    ...((payments && payments.items) || []).filter((p) => p.customerId === c.id).map((p) => ({ at: p.createdAt, html: `<div class="admin-row"><span><strong>${h(paymentFor(p))}</strong> · ${h(day(p.createdAt))} · ${h(paymentMethod(p))}</span>${paymentStatus(p)}</div>` })),
    ...((store && store.orders) || []).filter((o) => o.customerId === c.id).map((o) => {
      const product = o.product && (typeof o.product.name === "object" ? o.product.name[lang] || o.product.name.en : o.product.name);
      return { at: o.createdAt, html: `<div class="admin-row"><span><strong>${h(L("adminOrderLine", { reference: o.reference || o.id, product: product || "—" }))}</strong> · ${h(day(o.createdAt))}</span>${orderStatus(o.status)}</div>` };
    }),
  ].sort((a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0));
  panel.innerHTML = payments === null && !entries.length
    ? `<p class="nd-meta">${h(L("adminCustomerFailed"))}</p>`
    : entries.length ? entries.map((entry) => entry.html).join("") : `<p class="nd-meta">${h(L("adminCustomerNoMoney"))}</p>`;
}

// Devices: Wi-Fi devices seen on the customer's vouchers, with v1's
// confirmed Disconnect.
async function loadDevices(panel, { call, c, canManage }) {
  const bundle = c.summary && c.summary.bundle;
  if (bundle && bundle.status === "active" && bundle.accessType === "personal_unlimited") return showSlots(panel, { host: panel.closest("#customer-panel-devices").parentElement, call, bundle, canManage });
  const result = await call(`/api/admin/records?${new URLSearchParams({ collection: "wifiDevices", q: c.phone || c.id, pageSize: 50 })}`).catch(() => null);
  if (!panel.isConnected) return;
  const devices = ((result && result.items) || []).filter((d) => !d.customerId || d.customerId === c.id);
  if (!result) { panel.innerHTML = `<p class="nd-meta">${h(L("adminCustomerFailed"))}</p>`; return; }
  panel.innerHTML = devices.length ? devices.map((d) => {
    const pending = d.disconnect && ["disconnecting", "retrying"].includes(d.disconnect.status);
    const since = d.startedAt ? L("adminOnlineSince", { time: new Date(d.startedAt).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE }) }) : "";
    const button = canManage ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-wifi-voucher="${h(d.voucherId)}" data-wifi-mac="${h(d.mac)}" data-wifi-session="${h(d.sessionId || "")}" data-wifi-started="${h(d.startedAt || "")}" ${!d.fresh || pending || !d.sessionId || !d.startedAt ? "disabled" : ""}>${h(L(pending ? "adminDisconnecting" : "adminDisconnect"))}</button>` : "";
    return `<div class="admin-row"><span><strong>${h(d.name || L("adminUnnamedDevice"))}</strong> · ${h(d.mac)}${since ? " · " + h(since) : ""}</span>${button}</div>`;
  }).join("") : `<p class="nd-meta">${h(L("adminCustomerNoDevices"))}</p>`;
}

// The page's confirmations (canvas: AdminCustomerDetail, #341): one dialog;
// resolves with the reason typed (or "" when none is asked), or null.
function confirmIn(host, { title, body, go, danger, reason }) {
  const dialog = host.querySelector("#customerConfirm"), form = dialog.querySelector("form");
  dialog.querySelector("#customerConfirmTitle").textContent = title;
  dialog.querySelector("[data-confirm-body]").textContent = body;
  const goButton = dialog.querySelector("[data-confirm-go]"), field = dialog.querySelector("[data-confirm-reason]"), message = dialog.querySelector("[data-confirm-message]");
  goButton.textContent = go;
  goButton.classList.toggle("admin-btn--danger", Boolean(danger));
  field.hidden = !reason;
  form.elements.reason.value = "";
  form.elements.reason.required = Boolean(reason);
  message.textContent = "";
  dialog.showModal();
  (reason ? form.elements.reason : goButton).focus();
  return new Promise((resolve) => {
    const done = (value) => { form.onsubmit = null; dialog.querySelector("[data-confirm-cancel]").onclick = null; dialog.onclose = null; resolve(value); };
    dialog.querySelector("[data-confirm-cancel]").onclick = () => { dialog.close(); done(null); };
    dialog.onclose = () => done(null);
    form.onsubmit = (event) => { event.preventDefault(); const value = reason ? form.elements.reason.value.trim() : ""; if (reason && !value) return; dialog.onclose = null; dialog.close(); done(value); };
  });
}

function wireSupport(host, { call, c, bundle, name, context }) {
  const say = (text) => { const out = host.querySelector("[data-support-message]"); if (out) out.textContent = text; };
  const post = (path, input) => call(path, { method: "POST", body: JSON.stringify(input) });
  host.querySelector("[data-send-pin-reset]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (await confirmIn(host, { title: L("adminPinResetTitle"), body: L("adminPinResetBody", { name }), go: L("adminPinResetSend") }) === null) return button.focus();
    button.disabled = true;
    try { const result = await post("/api/admin/customers/pin-reset-email", { customerId: c.id }); say(L("adminPinResetSent", { email: result.to || "" })); }
    catch (error) { say(error.message); }
    finally { button.disabled = false; button.focus(); }
  });
  host.querySelector("[data-no-passkeys]")?.addEventListener("click", () => say(L("adminNoPasskeys", { name })));
  host.querySelector("[data-revoke-subscription]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!bundle || bundle.status !== "active") return say(L("adminNoSubscription"));
    if (await confirmIn(host, { title: L("adminRevokeSubTitle", { name }), body: L("adminRevokeSubBody"), go: L("adminRevokeSubscription"), danger: true }) === null) return button.focus();
    button.disabled = true;
    try {
      await post("/api/admin/vouchers/revoke", { voucherId: bundle.id });
      await showCustomerDetail(host, context);
      const out = host.querySelector("[data-support-message]"); if (out) out.textContent = L("adminRevokeSubDone");
    } catch (error) { say(error.message); button.disabled = false; }
  });
}

// Devices for a Personal Unlimited bundle (canvas: AdminCustomerDetail, #341):
// "Slot 1 · Android phone · ••:••:••:4F:A2:10 · online at AP-Market since
// 08:12" or "offline, last seen 09:40", with Revoke device; the slot frees
// once the router confirms, and the bundle's end date never changes.
function showSlots(panel, { host, call, bundle, canManage, notice = "" }) {
  const hours = Number(bundle.validityHours) || 0, duration = hours >= 48 && hours % 24 === 0 ? L("adminSlotDays", { count: hours / 24 }) : L("adminSlotHours", { count: hours });
  const slots = bundle.slots || [], r = bundle.replacements || { count: 0 };
  const where = (slot) => slot.removing ? L("adminSlotRemoving")
    : slot.online ? (slot.place ? L(slot.since ? "adminOnlineAtSince" : "adminOnlineAt", { place: slot.place, time: slot.since ? clock(slot.since) : "" })
      : slot.since ? L("adminOnlineSinceShort", { time: clock(slot.since) }) : L("adminOnlineNow"))
      : slot.lastSeenAt ? L("adminOfflineLastSeen", { time: clock(slot.lastSeenAt) }) : L("adminOfflineShort");
  const replaced = !r.count ? L("adminReplacementsNone")
    : r.last && r.last.from && r.last.to ? L("adminReplacementsLast", { count: r.count, date: day(r.last.at), from: r.last.from, to: r.last.to }) : L("adminReplacementsCount", { count: r.count });
  panel.innerHTML = `<p class="admin-slots__head"><strong>${h([L("adminSlotPersonal"), duration, L(bundle.deviceSlots === 1 ? "adminSlotDevice" : "adminSlotDevices", { count: bundle.deviceSlots })].join(" · "))}</strong> · ${h(L("adminSlotsUsedLine", { used: bundle.slotsUsed ?? 0, total: bundle.deviceSlots ?? "—" }))} · ${h(L("adminEndsLower", { date: when(bundle.expiresAt, true) }))}</p>
  ${slots.map((slot, index) => `<div class="admin-row admin-slot"><span><strong>${h(L("adminSlotN", { n: index + 1 }))} · ${h(slot.name || L("adminUnnamedDevice"))}</strong> · <span class="admin-slot__mac">${h(slot.mac)}</span> · ${h(where(slot))}</span>${canManage ? `<button type="button" class="admin-slot__revoke" data-revoke-slot="${h(slot.id)}"${slot.removing ? " disabled" : ""}>${h(L("adminRevokeDevice"))}</button>` : ""}</div>`).join("")}
  <p class="nd-meta admin-slots__note">${h(L("adminRevokeDeviceNote"))} ${h(replaced)}</p><p class="admin-saved" role="status" aria-live="polite" data-slots-message>${h(notice)}</p>`;
  panel.querySelectorAll("[data-revoke-slot]").forEach((button) => button.addEventListener("click", async () => {
    const slot = slots.find((x) => x.id === button.dataset.revokeSlot);
    const reason = await confirmIn(host, { title: L("adminRevokeDeviceTitle", { name: slot.name || L("adminUnnamedDevice") }), body: L("adminRevokeDeviceBody"), go: L("adminRevokeDevice"), danger: true, reason: true });
    if (reason === null) return button.focus();
    button.disabled = true;
    try {
      const result = await call("/api/admin/vouchers/devices/revoke", { method: "POST", body: JSON.stringify({ voucherId: bundle.id, grantId: slot.id, reason }) });
      // The slot shows as being removed until the router confirms; then it frees.
      if (result.revocation === "pending") Object.assign(slot, { removing: true, online: false });
      else bundle.slots = slots.filter((x) => x !== slot);
      showSlots(panel, { host, call, bundle, canManage, notice: L(result.revocation === "pending" ? "adminRevokeDevicePending" : "adminRevokeDeviceDone") });
    } catch (error) { const out = panel.querySelector("[data-slots-message]"); if (out) out.textContent = error.message; button.disabled = false; }
  }));
}
