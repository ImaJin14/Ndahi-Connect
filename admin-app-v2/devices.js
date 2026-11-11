// Redesigned Live devices (canvas: AdminDevices): devices on active bundles
// from the last router reading, who they belong to, and v1's confirmed
// Disconnect. The router reports no access point, signal or per-device
// usage, so those canvas columns (and the access-point filter) are not shown.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { mountRecords } from "/records.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const ZONE = "Africa/Douala";
const time = (value) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const today = new Date().toLocaleDateString("en-CA", { timeZone: ZONE }) === new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE });
  const clock = new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
  return today ? clock : `${new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE })}, ${clock}`;
};

export function mountDeviceRecords(container, { call, canManage }) {
  return mountRecords(container, {
    call,
    collection: "wifiDevices",
    title: L("adminTitleDevices"),
    refreshMs: 5000,
    headers: [L("adminColDevice"), L("adminColCustomer"), L("adminColAddress"), L("adminColStatus"), L("adminColOnlineSince"), { label: L("adminColAction") }],
    empty: L("adminDevicesNone"),
    kit: {
      heading: false,
      statusFilter: false,
      searchLabel: L("adminDevicesSearch"),
      placeholder: L("adminDevicesPlaceholder"),
      previous: L("adminPagePrevious"),
      next: L("adminPageNext"),
      text: {
        loading: L("adminLoading"),
        failed: L("adminDevicesFailedToLoad"),
        retry: L("adminTryAgain"),
        none: L("adminDevicesNone"),
        summary: (page, pages, total) => L("adminPageSummary", { page, pages, total }),
      },
    },
    row: (d) => {
      const stale = !d.fresh, pending = d.disconnect && ["disconnecting", "retrying"].includes(d.disconnect.status);
      const [label, tone] = pending ? ["adminDeviceDisconnecting", "info"] : d.disconnect && d.disconnect.status === "failed" ? ["adminDeviceDisconnectFailed", "danger"] : stale ? ["adminDeviceStale", "warning"] : ["adminDeviceConnected", "success"];
      const button = canManage ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-wifi-voucher="${h(d.voucherId)}" data-wifi-mac="${h(d.mac)}" data-wifi-session="${h(d.sessionId || "")}" data-wifi-started="${h(d.startedAt || "")}" ${stale || pending || !d.sessionId || !d.startedAt ? "disabled" : ""}>${h(L(pending ? "adminDisconnecting" : "adminDisconnect"))}</button>` : "";
      const who = d.customerName ? `<a class="admin-name" href="/dashboard#customer/${encodeURIComponent(d.customerId)}">${h(d.customerName)}</a>` : h(d.customerId ? L("adminUnnamedCustomer") : "—");
      return `<tr><td><strong>${h(d.name || L("adminUnnamedDevice"))}</strong>${d.main ? ` <span class="nd-pill">${h(L("adminMainDevice"))}</span>` : ""}<span class="admin-cell__sub">${h(d.mac)}</span></td><td>${who}</td><td>${h(d.address || "—")}</td><td><span class="nd-pill nd-pill--${tone}">${h(L(label))}</span>${d.disconnect && d.disconnect.message ? `<span class="admin-cell__sub">${h(d.disconnect.message)}</span>` : ""}</td><td>${h(time(d.startedAt))}</td><td>${button}</td></tr>`;
    },
  });
}

// The line beside the title (canvas: "● 6 online · updated 20 s ago"),
// worded as v1 does: devices confirmed in the last router reading.
const STATES = { ready: "adminWifiReady", idle: "adminWifiIdle", refreshing: "adminWifiRefreshing", retrying: "adminWifiRetrying", failed: "adminWifiFailed", stale: "adminWifiStale" };
export function deviceSummaryText(summary) {
  if (summary.live === false) return L("adminWifiNotLive");
  const count = summary.unreadVouchers && !summary.activeCount ? L("adminWifiUnknown") : L("adminWifiConnected", { count: summary.activeCount });
  const older = summary.staleCount ? L("adminWifiOlder", { count: summary.staleCount }) : "";
  const checked = summary.syncedAt ? L("adminWifiChecked", { time: time(summary.syncedAt) }) : "";
  return [count, older, L(STATES[summary.state] || "adminWifiUnavailable"), checked].filter(Boolean).join(" · ");
}
