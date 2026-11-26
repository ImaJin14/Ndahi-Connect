// Redesigned Vouchers list (canvas: AdminVouchers, "Recent vouchers", #343):
// each code with its bundle, who it's for, Sold or Gift and a status pill, and
// one search for a code, name or number. Actions are on each voucher's page.
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

export function mountVoucherRecords(container, { call, canManagePayments, resellerName = () => "" }) {
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
  // Recent vouchers (canvas: AdminVouchers, #343; owner 26 Nov): Code, Bundle,
  // For, Type and Status with one search; actions live on each voucher's page.
  const short = (phone) => { const d = String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, ""); return d.length === 9 ? `${d[0]}•• •• ${d.slice(5, 7)} ${d.slice(7)}` : ""; };
  const bundleName = (v) => {
    const name = v.plan?.name || "—";
    // A custom gift reads "Custom · 10 days · 3 devices" (its terms without "Gift from NDAHI · Unlimited").
    return v.plan?.catalogue === "custom_gift" || /^Gift from NDAHI · /.test(name) ? `${L("adminGiveCustomShort")} · ${name.replace(/^Gift from NDAHI · /, "").replace(/^Unlimited · /, "")}` : name;
  };
  const forWhom = (v) => {
    if (v.customerId) return `<a href="/dashboard#customer/${encodeURIComponent(v.customerId)}">${h(v.customerName || L("adminGiveCustomerAccount"))}</a>`;
    if (v.reservation?.status === "waiting" && v.reservation.phone) return h(L("adminVoucherNoAccountYet", { number: short(v.reservation.phone) }));
    if (v.batchReference) return h([L("adminVoucherBatchFor", { batch: v.batchReference }), resellerName(v.assignedResellerId)].filter(Boolean).join(" · "));
    return v.permissions?.manage ? h(L("adminGiveUnassigned")) : "—";
  };
  const status = (v) => v.reservation?.status === "waiting" && v.status === "available" ? `<span class="nd-pill nd-pill--claim">${h(L("adminVoucherStatusWaiting"))}</span>` : voucherStatus(v.status);
  const ready = mountRecords(container, {
    call: listCall,
    collection: "vouchers",
    title: L("adminRecentVouchers"),
    headers: [L("adminColCode"), L("adminFieldBundle"), ...(canManagePayments ? [L("adminGiveFor")] : []), L("adminGiveType"), L("adminColStatus")],
    empty: L("adminVouchersNone"),
    voucherDetails: false,
    kit: {
      titleId: "voucherRecordsTitle",
      searchLabel: L("adminVoucherSearchLabel"),
      placeholder: L("adminVoucherSearchPlaceholder"),
      statusFilter: false,
      // The pager shows only when there is more than one page.
      singlePage: "hide",
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
    // Each code opens its detail page (canvas: AdminVoucherDetail, #258), which has the actions.
    row: (v) => `<tr data-voucher-record="${h(v.id)}"><td><a class="admin-code-link" href="/dashboard#voucher/${encodeURIComponent(v.id)}"><code class="admin-code">${h(v.code)}</code></a></td><td>${h(bundleName(v))}</td>${canManagePayments ? `<td>${forWhom(v)}</td>` : ""}<td>${h(saleLabel(v) || "—")}</td><td>${status(v)}</td></tr>`,
  });
  return ready;
}
