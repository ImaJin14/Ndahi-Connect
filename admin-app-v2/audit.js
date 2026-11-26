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
// "10 Nov 17:25", as designed (no comma between the date and the time).
const when = (value) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at);
  return `${date.toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE })} ${date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ZONE })}`;
};

// "voucher.resale_batch_generated" → "Created a resale voucher batch" (EN/FR),
// or the action spelled out, starting with a capital, when there is no
// wording for it yet.
export function auditAction(action, entry) {
  const a = entry || {}, m = a.meta || {};
  // Details the drawn rows carry: "Created voucher batch × 20", "Changed
  // stock 3 → 2", "Suspended customer", "Signed in with PIN + passkey".
  if (action === "admin.login.succeeded" && a.method === "pin_passkey") return L("adminAudit_admin_login_pin_passkey");
  if (action === "voucher.resale_batch_generated" && Number.isInteger(m.quantity)) return L("adminAudit_voucher_batch_count", { count: m.quantity });
  if (action === "store.stock.adjust" && Number.isInteger(m.from) && Number.isInteger(m.to)) return L("adminAudit_store_stock_change", { from: m.from, to: m.to });
  if (action === "store.orders.update" && /^[a-z-]{2,30}$/.test(m.orderAction || "") && TRANSLATIONS.en["adminAudit_store_" + m.orderAction.replace(/-/g, "_")]) return L("adminAudit_store_" + m.orderAction.replace(/-/g, "_"));
  if (action === "customer.suspension_changed" && ["suspended", "active"].includes(m.status)) return L(m.status === "suspended" ? "adminAudit_customer_suspended" : "adminAudit_customer_restored");
  const key = "adminAudit_" + String(action || "").replace(/[^a-z0-9]/gi, "_");
  if (TRANSLATIONS.en[key]) return L(key);
  const words = String(action || "—").replace(/[._]/g, " ").trim();
  return words[0].toUpperCase() + words.slice(1);
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

// Who, as designed (AdminAudit): "Owner", or the role and name ("Operator ·
// Brenda"); automatic work ("system", deployment scripts) reads "System". A
// removed account keeps its recorded username.
const ROLE_LABELS = { owner: "adminRoleOwner", operator: "adminRoleOperator", auditor: "adminRoleAuditor", reseller: "adminRoleReseller" };
export function auditWho(a) {
  if (a.actorRole === "owner") return L("adminRoleOwner");
  if (ROLE_LABELS[a.actorRole]) return `${L(ROLE_LABELS[a.actorRole])} · ${a.actorName || a.actor}`;
  if (!a.actor || a.actor === "system" || /^deployment:/.test(a.actor)) return L("adminAuditSystem");
  return a.actor;
}

// The drawn chips (owner, 25 Nov, #378); the server maps each to its areas.
export const AUDIT_AREAS = [["", "adminAuditAll"], ["money", "adminAuditMoney"], ["store", "adminAuditStore"], ["vouchers", "adminAuditVouchersArea"], ["customers", "adminAuditCustomers"], ["signins", "adminAuditSignIns"]];

// What the entry was on, worded: "Admin" for sign-ins, "Bundle · 6•• •• 12 45".
export function auditOn(a) {
  if (a.targetKind === "admin") return L("adminAuditOnAdmin");
  if (a.targetKind === "bundle") return L("adminAuditOnBundle", { phone: a.target });
  return a.target || auditTarget(a.meta);
}

// The chip, search and page live in the address: #audit?type=money&q=…&page=2.
export function auditAddressState(hash) {
  const at = String(hash || "").indexOf("?"), params = new URLSearchParams(at < 0 ? "" : String(hash).slice(at + 1));
  const type = params.get("type") || "", page = Number(params.get("page"));
  return { status: AUDIT_AREAS.some(([area]) => area === type) ? type : "", q: (params.get("q") || "").slice(0, 100), page: Number.isInteger(page) && page > 0 ? page : 1 };
}
export function auditAddress({ status, q, page }) {
  const params = new URLSearchParams();
  if (status) params.set("type", status);
  if (q) params.set("q", q);
  if (page > 1) params.set("page", String(page));
  const query = params.toString();
  return "#audit" + (query ? "?" + query : "");
}

// Coming back through the menu (#audit) keeps the chosen chip in the address.
let lastState = null;
export function syncAuditAddress() {
  if (lastState && location.hash === "#audit" && auditAddress(lastState) !== "#audit") history.replaceState(history.state, "", auditAddress(lastState));
}

export function mountAuditRecords(container, { call, searchHost }) {
  const initial = auditAddressState(location.hash);
  window.addEventListener("hashchange", syncAuditAddress);
  if (initial.q && searchHost?.closest("details")) searchHost.closest("details").open = true;
  return mountRecords(container, {
    initial,
    // Only while the audit log is the open screen: never rewrite another view's address.
    onState: (state) => { lastState = state; if (/^#audit(\?|$)/.test(location.hash) && location.hash !== auditAddress(state)) history.replaceState(history.state, "", auditAddress(state)); },
    call,
    collection: "audit",
    title: L("adminAuditEntries"),
    headers: [L("adminColWhen"), L("adminColWho"), L("adminColActionDone"), L("adminColOn")],
    empty: L("adminAuditNone"),
    kit: {
      heading: false,
      singlePage: "hide",
      searchHost,
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
    row: (a) => `<tr><td>${h(when(a.at))}</td><td>${h(auditWho(a))}</td><td><strong>${h(auditAction(a.action, a))}</strong></td><td>${h(auditOn(a))}</td></tr>`,
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
