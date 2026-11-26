// Connections (canvas: AdminConnections, #380; owner decisions 25 Nov): one
// card per service with its state, what was measured and when, and "Test
// connection"; then Admin security. The readings come from the API's checks
// (lib/service-health.mjs): the router's ping and uplink traffic, its hotspot
// sessions, how fast Mobile Money payments confirm, and email delivery.
// Standalone access points have no controller, so that card has no test.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const TONE = { ok: "ok", slow: "slow", down: "down" };

// "Checked 40 s ago", "Checked 1 min ago", or the result of a test just run.
export function checkedLine(card, now = Date.now()) {
  // Only a real answer (or none) from the router or controller is "responded";
  // payments and email are worked out from the latest data, and test mode or
  // a service not set up asks nothing.
  if (card.tested) {
    if (["ok", "slow"].includes(card.state) && !["mtn", "orange", "email"].includes(card.id)) return L("adminHealthTestedResponded");
    if (["down", "unknown"].includes(card.state) && !["mtn", "orange", "email"].includes(card.id)) return L("adminHealthTestedNoAnswer");
    return L("adminHealthCheckedJustNow");
  }
  const at = Date.parse(card.checkedAt);
  if (!Number.isFinite(at)) return L("adminHealthNotChecked");
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 5) return L("adminHealthCheckedJustNow");
  if (seconds < 60) return L("adminHealthCheckedSeconds", { seconds: Math.max(5, Math.round(seconds / 5) * 5) });
  if (seconds < 3600) return L("adminHealthCheckedMinutes", { minutes: Math.floor(seconds / 60) });
  return L("adminHealthCheckedHours", { hours: Math.floor(seconds / 3600) });
}

// "18.2 Mbps" in English, "18,2 Mbit/s" in French.
const numbers = (values) => Object.fromEntries(Object.entries(values || {}).map(([k, v]) => [k, typeof v === "number" ? v.toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-GB") : v]));

export function serviceCard(card) {
  const tone = TONE[card.state] || "neutral", detail = card.detail || {};
  const testable = card.testable !== false && card.state !== "standalone";
  return `<article class="admin-service" data-service="${h(card.id)}"><div class="admin-service__head"><strong>${h(L("adminHealthName_" + card.id))}</strong><span class="admin-service__pill admin-service__pill--${tone}">${h(L("adminHealthState_" + card.state))}</span></div>
<p class="admin-service__detail">${h(L(detail.key || "adminHealthPending", numbers(detail.values)))}</p><p class="admin-service__checked" data-checked-at="${h(card.checkedAt || "")}"${card.tested ? " data-tested" : ""}>${h(checkedLine(card))}</p>
${testable ? `<button type="button" class="admin-service__test" data-test-service="${h(card.id)}">${h(L("adminTestConnection"))}</button>` : ""}</article>`;
}

export function serviceCards(x) {
  return (x.serviceHealth || []).map(serviceCard).join("");
}

// "Test connection": the one service again, now; its card shows the result.
export function mountServiceTests(grid, call) {
  if (!grid) return;
  grid.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-test-service]");
    if (!button || button.disabled) return;
    const id = button.dataset.testService;
    button.disabled = true;
    button.textContent = L("adminTestingConnection");
    try {
      const { check } = await call("/api/admin/service-health/test", { method: "POST", body: JSON.stringify({ service: id }) });
      const old = grid.querySelector(`[data-service="${CSS.escape(id)}"]`);
      if (old && check) {
        old.outerHTML = serviceCard({ ...check, id, tested: true });
        grid.querySelector(`[data-service="${CSS.escape(id)}"] [data-test-service]`)?.focus();
      }
    } catch (error) {
      button.disabled = false;
      button.textContent = L("adminTestConnection");
      const line = button.closest(".admin-service")?.querySelector(".admin-service__checked");
      if (line) line.textContent = error.message || L("adminHealthTestedNoAnswer");
    }
  });
  // Keep "Checked 40 s ago" true while the screen is open.
  const timer = setInterval(() => {
    if (!grid.isConnected) { clearInterval(timer); return; }
    if (grid.closest("[hidden]")) return;
    grid.querySelectorAll(".admin-service__checked:not([data-tested])").forEach((line) => {
      const card = line.closest(".admin-service");
      line.textContent = checkedLine({ id: card?.dataset.service, checkedAt: line.dataset.checkedAt });
    });
  }, 15000);
}

// Admin security: staff sign-in, staff by role, stuck router commands.
export function adminSecurity(x) {
  const staff = (x.administrators || []).filter((a) => a.active !== false), counts = {};
  staff.forEach((a) => { counts[a.role] = (counts[a.role] || 0) + 1; });
  const roles = ["owner", "operator", "auditor", "reseller"].filter((role) => counts[role]).map((role) => L(counts[role] === 1 ? "adminStaffOne" : "adminStaffMany", { count: counts[role], role: L("adminRoleWord_" + role) })).join(" · ");
  const stuck = (x.networkCommands && x.networkCommands.deadLetters) || 0;
  const item = (label, value, tone) => `<div><p class="admin-security__label">${h(label)}</p><p class="admin-security__value${tone ? " admin-security__value--" + tone : ""}">${value}</p></div>`;
  // Stuck commands open the router checks below; none stuck reads as drawn.
  const stuckValue = stuck ? `<a class="admin-security__stuck" href="#routerChecks" data-open-router-checks>${h(L("adminCommandsStuck", { count: stuck }))}</a>` : h(L("adminCommandsStuck", { count: stuck }));
  return `${item(L("adminStaffSignIn"), h(L(x.staffSignIn === "pin_passkey" ? "adminStaffSignInPinPasskey" : "adminStaffSignInPin")), "good")}${roles ? item(L("adminStaffAccounts"), h(roles)) : ""}${x.networkCommands ? item(L("adminCommandsWaiting"), stuckValue, stuck ? "bad" : "") : ""}<a class="admin-security__link" href="/dashboard#audit">${h(L("adminOpenAudit"))} <span aria-hidden="true">→</span></a>`;
}
