// Redesigned Audit log (canvas: AdminAudit): every staff action with who did
// it, in plain words, filtered by area. The log is read-only; Export saves the
// whole log (the API keeps the latest 1,000 entries) as CSV.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format, TRANSLATIONS } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { mountRecords } from "/records.js";
import { saveFile } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const ZONE = "Africa/Douala";
const when = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ZONE }) : "—";
};

// "voucher.resale_batch_generated" → "Created a resale voucher batch" (EN/FR),
// or the action spelled out when there is no wording for it yet.
export function auditAction(action) {
  const key = "adminAudit_" + String(action || "").replace(/[^a-z0-9]/gi, "_");
  return TRANSLATIONS.en[key] ? L(key) : String(action || "—").replace(/[._]/g, " ");
}

// What the action was on, from its details: a name, a count or a short id.
export function auditTarget(meta) {
  const m = meta || {};
  if (m.username) return m.username;
  if (m.name) return m.name;
  if (Array.isArray(m.voucherIds) && m.voucherIds.length > 1) return L("adminAuditVouchers", { count: m.voucherIds.length });
  const id = m.orderReference || m.customerId || m.paymentId || m.voucherId || (Array.isArray(m.voucherIds) && m.voucherIds[0]) || m.bundleId || m.resellerId || m.commandId || m.userId || m.mac;
  return id ? (String(id).length > 14 ? String(id).slice(0, 8) + "…" : String(id)) : "—";
}

export const AUDIT_AREAS = [["", "adminAuditAll"], ["payment", "adminAuditMoney"], ["store", "adminAuditStore"], ["voucher", "adminAuditVouchersArea"], ["customer", "adminAuditCustomers"], ["admin", "adminAuditStaff"], ["network", "adminAuditNetwork"]];

export function mountAuditRecords(container, { call }) {
  return mountRecords(container, {
    call,
    collection: "audit",
    title: L("adminAuditEntries"),
    headers: [L("adminColWhen"), L("adminColWho"), L("adminColActionDone"), L("adminColOn")],
    empty: L("adminAuditNone"),
    kit: {
      heading: false,
      searchLabel: L("adminAuditSearch"),
      placeholder: L("adminAuditPlaceholder"),
      chipsLabel: L("adminAuditType"),
      chips: AUDIT_AREAS.map(([area, key]) => [area, L(key)]),
      previous: L("adminPagePrevious"),
      next: L("adminPageNext"),
      text: {
        loading: L("adminLoading"),
        failed: L("adminAuditFailedToLoad"),
        retry: L("adminTryAgain"),
        none: L("adminAuditNone"),
        summary: (page, pages, total) => L("adminPageSummary", { page, pages, total }),
      },
    },
    row: (a) => `<tr><td>${h(when(a.at))}</td><td>${h(a.actor || "system")}</td><td><strong>${h(auditAction(a.action))}</strong></td><td>${h(auditTarget(a.meta))}</td></tr>`,
  });
}

// CSV cells a spreadsheet will not run as formulas.
const cell = (value) => {
  let text = String(value == null ? "" : value);
  if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
};

export async function exportAudit(call) {
  const rows = [["at", "actor", "action", "ip", "details"]];
  for (let page = 1; page <= 20; page++) {
    const result = await call(`/api/admin/records?${new URLSearchParams({ collection: "audit", page, pageSize: 100 })}`);
    result.items.forEach((a) => rows.push([a.at, a.actor, a.action, a.ip, JSON.stringify(a.meta || {})]));
    if (page >= result.pages) break;
  }
  saveFile(`ndahi-audit-${new Date().toISOString().slice(0, 10)}.csv`, new Blob([rows.map((row) => row.map(cell).join(",")).join("\n")], { type: "text/csv" }));
}
