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
  // The voucher list exposes only customerId. Resolve labels through the
  // existing scoped customer search, for owners/operators only; no contact
  // reads or persistent cache for restricted roles.
  const customers = new Map();
  const read = (path, options = {}) => call(path, { ...options, preservePageOnUnavailable: true });
  const listCall = async (path, options) => {
    const result = await read(path, options);
    if (!canManagePayments || !path.startsWith('/api/admin/records?') || new URLSearchParams(path.split('?')[1]).get('collection') !== 'vouchers') return result;
    const ids = [...new Set((result.items || []).map(v => v.customerId).filter(Boolean))];
    const labels = await Promise.all(ids.map(async id => {
      if (!customers.has(id)) {
        const pending = read(`/api/admin/records?${new URLSearchParams({ collection: 'customers', pageSize: 20, q: id })}`)
          .then(found => found.items?.find(c => c.id === id)?.name || null)
          .catch(() => null);
        customers.set(id, pending);
      }
      const name = await customers.get(id);
      if (!name) customers.delete(id); // Retry a temporary failure on a later refresh.
      return [id, name];
    }));
    const names = new Map(labels);
    return { ...result, items: result.items.map(v => ({ ...v, customerName: names.get(v.customerId) })) };
  };
  const button = (attrs, label, quiet) => `<button type="button" class="nd-btn nd-btn--compact ${quiet ? "nd-btn--quiet" : "nd-btn--secondary"}" ${attrs}>${h(label)}</button>`;
  const ready = mountRecords(container, {
    call: listCall,
    collection: "vouchers",
    title: L("adminRecentVouchers"),
    headers: [L("adminColCode"), L("adminFieldBundle"), ...(canManagePayments ? [L("adminGiveFor")] : []), L("adminGiveType"), L("adminColStatus"), { label: L("adminColAction") }],
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
      const forCustomer = v.customerId ? `<a href="/dashboard#customer/${encodeURIComponent(v.customerId)}">${h(v.customerName || L("adminGiveCustomerAccount"))}</a>` : v.permissions?.manage ? h(L("adminGiveUnassigned")) : "—";
      return `<tr><td data-voucher-code-control></td><td>${h(v.plan?.name || "—")}</td>${canManagePayments ? `<td>${forCustomer}</td>` : ""}<td>${h(saleLabel(v) || "—")}</td><td>${voucherStatus(v.status)}</td><td>${actions ? `<details class="voucher-record-actions"><summary class="nd-btn nd-btn--compact nd-btn--secondary">${h(L("adminGiveActions"))}</summary><div class="admin-actions">${actions}</div></details>` : ""}</td></tr>`;
    },
  });
  // Keep the source's compact default list while retaining operational tools.
  const filters = container.querySelector('.records-filters');
  if (filters) {
    const disclosure = document.createElement('details'), summary = document.createElement('summary');
    disclosure.className = 'voucher-record-filters'; summary.className = 'nd-btn nd-btn--compact nd-btn--secondary'; summary.textContent = L('adminGiveFilters');
    filters.before(disclosure); disclosure.append(summary, filters);
  }
  return ready;
}
