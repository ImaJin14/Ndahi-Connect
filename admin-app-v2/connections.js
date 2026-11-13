// Redesigned Connections (canvas: AdminConnections): one card per service the
// dashboard reports on, the admin security summary, and v1's router checks.
// The API has no per-service check times, uplink speed or per-network payment
// health, so cards show the configured state and what it means instead.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const STATE = { ok: ["adminServiceOk", "success"], test: ["adminServiceTest", "warning"], off: ["adminServiceOff", "danger"], standalone: ["adminServiceStandalone", ""] };
const card = (name, state, detail, action) => {
  const [label, tone] = STATE[state];
  return `<article class="admin-service"><div class="admin-service__head"><strong>${h(name)}</strong><span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(L(label))}</span></div><p class="admin-service__detail">${h(detail)}</p>${action || ""}</article>`;
};
const button = (id, label) => `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary nd-btn--block" id="${id}">${h(label)}</button>`;

export function serviceCards(x) {
  const i = x.integrations || {}, cards = [];
  const router = i.mikrotik === "live" ? "ok" : i.mikrotik === "mock" ? "test" : "off";
  cards.push(card(L("adminServiceRouter"), router,
    router === "ok" ? L("adminServiceRouterLive", { count: (x.wifi && x.wifi.activeCount) || 0 }) : router === "test" ? L("adminServiceRouterTest") : L("adminServiceRouterOff"),
    button("syncUsage", L("adminSyncUsage"))));
  const omada = i.omada === "live" ? "ok" : i.omada === "standalone" ? "standalone" : i.omada === "mock" ? "test" : "off";
  cards.push(card(L("adminServiceOmada"), omada,
    L(omada === "ok" ? "adminServiceOmadaLive" : omada === "standalone" ? "adminServiceOmadaStandalone" : omada === "test" ? "adminServiceTestDetail" : "adminServiceOmadaOff"),
    omada === "standalone" ? "" : button("checkOmada", L("adminCheckConnection"))));
  if (i.payments && i.payments !== "restricted") {
    const pay = i.payments === "mock" ? "test" : "ok";
    cards.push(card(L("adminServicePayments"), pay, pay === "ok" ? L("adminServicePaymentsLive", { provider: i.payments === "mesomb" ? "MeSomb" : i.payments === "flutterwave" ? "Flutterwave" : i.payments }) : L("adminServiceTestDetail")));
  }
  if (i.email && i.email !== "restricted") {
    const mail = i.email === "mock" ? "test" : i.email === "not-configured" ? "off" : "ok";
    cards.push(card(L("adminServiceEmail"), mail, L(mail === "ok" ? "adminServiceEmailLive" : mail === "test" ? "adminServiceTestDetail" : "adminServiceEmailOff")));
  }
  return cards.join("");
}

// Admin security: today's staff sign-in, staff by role, stuck router commands.
export function adminSecurity(x) {
  const staff = (x.administrators || []).filter((a) => a.active !== false), counts = {};
  staff.forEach((a) => { counts[a.role] = (counts[a.role] || 0) + 1; });
  const roles = ["owner", "operator", "auditor", "reseller"].filter((role) => counts[role]).map((role) => L(counts[role] === 1 ? "adminStaffOne" : "adminStaffMany", { count: counts[role], role: L("adminRoleWord_" + role) })).join(" · ");
  const stuck = (x.networkCommands && x.networkCommands.deadLetters) || 0;
  const item = (label, value, tone) => `<div><p class="nd-meta">${h(label)}</p><p class="admin-security__value${tone ? " admin-security__value--" + tone : ""}">${h(value)}</p></div>`;
  return `${item(L("adminStaffSignIn"), L("adminStaffSignInValue"), "good")}${roles ? item(L("adminStaffAccounts"), roles) : ""}${x.networkCommands ? item(L("adminCommandsWaiting"), L("adminCommandsStuck", { count: stuck }), stuck ? "bad" : "") : ""}<a class="admin-link admin-security__link" href="/dashboard#audit">${h(L("adminOpenAudit"))} <span aria-hidden="true">→</span></a>`;
}
