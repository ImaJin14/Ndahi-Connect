// Redesigned Vouchers list (canvas: AdminVouchers, "Recent vouchers"): codes
// with their bundle, when they were made and a status pill. v1's filters,
// row actions and ownership details are kept; the dashboard's delegated click
// handler runs the actions.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { mountRecords } from "/records.js";

const L = (key, values) => format(key, values || {}, currentLanguage());

// Canvas wording: Not used, In use, Used up, Disabled.
const STATUS = {
  available: ["adminVoucherNotUsed", "info"],
  active: ["adminVoucherInUse", "success"],
  exhausted: ["adminVoucherUsedUp", ""],
  expired: ["adminVoucherExpired", ""],
  revoked: ["adminVoucherDisabled", "danger"],
  suspended: ["adminVoucherSuspended", "danger"],
  refunded: ["adminVoucherRefunded", ""],
  renewed: ["adminVoucherRenewed", ""],
  switched: ["adminVoucherSwitched", ""],
  replaced: ["adminVoucherReplaced", ""],
};
export const voucherStatus = (status) => {
  const [key, tone] = STATUS[status] || [null, ""];
  return `<span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(key ? L(key) : String(status || "—"))}</span>`;
};
export const saleLabel = (v) => { const key = v.paymentId ? "adminSaleOnline" : v.saleType === "sold" ? "adminSaleSoldShort" : v.saleType === "gift" ? "adminSaleGiftShort" : v.generatedByAdmin ? "adminSaleUnclassified" : null; return key ? L(key) : ""; };

export function mountVoucherRecords(container, { call, canManagePayments }) {
  const button = (attrs, label, quiet) => `<button type="button" class="nd-btn nd-btn--compact ${quiet ? "nd-btn--quiet" : "nd-btn--secondary"}" ${attrs}>${h(label)}</button>`;
  return mountRecords(container, {
    call,
    collection: "vouchers",
    title: L("adminRecentVouchers"),
    headers: [L("adminColCode"), L("adminFieldBundle"), L("adminColStatus"), { label: L("adminColAction") }],
    empty: L("adminVouchersNone"),
    kit: {
      titleId: "voucherRecordsTitle",
      searchLabel: L("adminVouchersSearch"),
      placeholder: L("adminVouchersPlaceholder"),
      statusLabel: L("adminVouchersFilter"),
      allStatuses: L("adminAllStatuses"),
      dates: { from: L("adminVouchersFrom"), through: L("adminVouchersThrough"), fromText: L("adminActivatedFrom"), throughText: L("adminActivatedThrough"), apply: L("adminApplyDates") },
      previous: L("adminPagePrevious"),
      next: L("adminPageNext"),
      text: {
        loading: L("adminLoading"),
        failed: L("adminVouchersFailedToLoad"),
        retry: L("adminTryAgain"),
        none: L("adminVouchersNone"),
        summary: (page, pages, total) => L("adminPageSummary", { page, pages, total }),
      },
    },
    row: (v) => {
      const printable = ["active", "available"].includes(v.status) && v.permissions?.code !== false && v.code && v.code !== "Restricted";
      const actions = [
        printable ? button(`data-print-voucher="${h(v.id)}" aria-label="${h(L("adminPrintVoucherCode", { code: v.code }))}"`, L("adminPrintShort")) : "",
        v.status === "active" ? button(`data-voucher="${h(v.id)}"`, L("adminRevoke"), true) : "",
        v.paymentId && v.emailStatus !== "sent" ? button(`data-resend-email="${h(v.id)}"`, L("adminRetryEmail"), true) : "",
        v.generatedByAdmin && !v.paymentId && canManagePayments ? ["sold", "gift"].filter((type) => v.saleType !== type).map((type) => button(`data-classify="${h(v.id)}" data-sale-type="${type}"`, L(type === "sold" ? "adminMarkSold" : "adminMarkGift"), true)).join("") : "",
      ].join("");
      const detail = [saleLabel(v), L("adminDevicesUsed", { used: v.activeDevices || 0, limit: v.deviceLimit || 0 })].filter(Boolean).join(" · ");
      return `<tr><td><code class="admin-code">${h(v.code)}</code></td><td>${h(v.plan?.name || "—")}<span class="admin-cell__sub">${h(detail)}</span></td><td>${voucherStatus(v.status)}</td><td><div class="admin-actions">${actions}</div></td></tr>`;
    },
  });
}
