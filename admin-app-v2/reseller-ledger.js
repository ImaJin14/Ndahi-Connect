// Resellers, stock and cash (canvas: AdminResellers; #390). Owner decisions,
// 25 Nov (#390):
// - one commission rate for every reseller: "Commission split: N% · Change" in
//   the page head; Change opens the rate form kept below. Codes keep the rate
//   recorded on them (#261);
// - the ledger shows each reseller's @sign-in name in place of [LOCATION];
// - balance corrections and the handoff and correction histories stay below
//   the drawn screen;
// - amounts in English use the comma, as on every other admin screen.
// Figures come from the ledger API; recording money keeps its idempotency key
// and saved payload across unknown replies, navigation and reloads.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const ZONE = "Africa/Douala";

function createOperationKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

// Whole FCFA: "52,000 FCFA" in English, "52 000 FCFA" in French.
export function formatFcfa(amount) {
  const num = Math.round(Number(amount || 0));
  return `${(Number.isFinite(num) ? num : 0).toLocaleString(locale())} FCFA`;
}
const stamp = (value) => {
  const at = new Date(value);
  if (!Number.isFinite(+at)) return "—";
  return `${at.toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE })} ${at.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ZONE })}`;
};
const percent = (value) => new Intl.NumberFormat(currentLanguage() === "fr" ? "fr-FR" : "en-GB", { style: "percent", maximumFractionDigits: 2 }).format(Number(value) / 100);
// Net owed, as drawn: cash collected − commission − remitted, with any recorded
// correction included. Below zero the reseller has paid ahead.
const owed = (r) => (Number(r.netPayableToOwner) || 0) - (Number(r.remittedTotal) || 0);

function ledgerMarkup(ledger, { canManage }) {
  const resellers = Array.isArray(ledger?.resellers) ? ledger.resellers : [];
  const remittances = Array.isArray(ledger?.remittances) ? ledger.remittances : [];
  const adjustments = Array.isArray(ledger?.adjustments) ? ledger.adjustments : [];
  if (!resellers.length) return `<section class="nd-panel admin-resellers__ledger" aria-label="${h(L("adminResellersLedgerLabel"))}" data-reseller-ledger><p class="nd-meta">${h(L("adminResellersNone"))}</p></section>`;
  const heads = ["adminResellersColReseller", "adminResellersColStock", "adminResellersColSales", "adminResellersColCash", "adminResellersColCommission", "adminResellersColRemitted", "adminResellersColOwed"]
    .map((key) => `<th scope="col">${h(L(key))}</th>`).join("");
  const labels = ["adminResellersColStock", "adminResellersColSales", "adminResellersColCash", "adminResellersColCommission", "adminResellersColRemitted", "adminResellersColOwed"].map((key) => h(L(key)));
  const rows = resellers.map((r) => {
    const due = owed(r);
    return `<tr data-reseller-row="${h(r.resellerId)}"><td><strong>${h(r.displayName || r.username)}</strong><span class="admin-resellers__who">@${h(r.username)}</span></td>`
      + `<td data-cell="stock" data-label="${labels[0]}">${h(r.assignedVouchers === 1 ? L("adminResellersCodesOne") : L("adminResellersCodes", { count: r.assignedVouchers || 0 }))}</td>`
      + `<td data-cell="sales" data-label="${labels[1]}">${h(r.redeemedVouchers || 0)}</td><td data-cell="collected" data-label="${labels[2]}">${h(formatFcfa(r.cashCollected))}</td>`
      + `<td data-cell="commission" data-label="${labels[3]}">${h(formatFcfa(r.commissionEarned))}</td><td data-cell="remitted" data-label="${labels[4]}">${h(formatFcfa(r.remittedTotal))}</td>`
      + `<td data-cell="owed" data-label="${labels[5]}"><strong class="admin-resellers__owed${due > 0 ? " admin-resellers__owed--due" : ""}">${h(formatFcfa(due))}</strong></td></tr>`;
  }).join("");
  const options = resellers.map((r) => `<option value="${h(r.resellerId)}">${h(r.displayName || r.username)}</option>`).join("");
  return `<section class="nd-panel admin-resellers__ledger" aria-label="${h(L("adminResellersLedgerLabel"))}" data-reseller-ledger>
  <div class="nd-table-wrap"><table class="nd-table admin-resellers__table"><thead><tr>${heads}</tr></thead><tbody>${rows}</tbody></table></div>
  <p class="admin-resellers__note">${h(L("adminResellersFormula"))}</p>
</section>
${canManage ? `<section class="nd-panel admin-resellers__handoff" aria-labelledby="resellerHandoffTitle">
  <h2 class="nd-h2" id="resellerHandoffTitle">${h(L("adminResellersHandoffTitle"))}</h2>
  <form class="admin-resellers__form" data-reseller-remittance-form>
    <div><label class="admin-resellers__label" for="handoffReseller">${h(L("adminResellersFieldReseller"))}</label><select class="admin-resellers__input" id="handoffReseller" name="resellerId" required>${options}</select></div>
    <div><label class="admin-resellers__label" for="handoffAmount">${h(L("adminResellersFieldAmount"))}</label><input class="admin-resellers__input" id="handoffAmount" type="number" name="amount" min="1" step="1" inputmode="numeric" required></div>
    <button type="submit" class="nd-btn admin-resellers__record">${h(L("adminResellersRecord"))}</button>
  </form>
  <p class="admin-resellers__recorded" role="status" data-reseller-remittance-message hidden></p>
</section>
<details class="admin-options admin-resellers__more" id="rate" data-reseller-advanced>
  <summary>${h(L("adminResellersMore"))}</summary>
  <div class="admin-resellers__more-grid">
    <form class="admin-resellers__subform" data-reseller-commission-form>
      <h3 class="nd-h3">${h(L("adminResellersRateTitle"))}</h3>
      <p class="nd-meta">${h(L("adminResellersRateHelp"))}</p>
      <label class="nd-field"><span class="nd-label">${h(L("adminResellersRateField"))}</span><input class="nd-input" type="number" name="commissionPercent" min="0" max="100" step="0.5" value="${h(ledger.commissionPercent ?? 10)}" required></label>
      <button type="submit" class="nd-btn nd-btn--secondary">${h(L("adminResellersRateSave"))}</button>
      <p class="nd-meta" role="status" data-reseller-commission-message></p>
    </form>
    <form class="admin-resellers__subform" data-reseller-adjustment-form>
      <h3 class="nd-h3">${h(L("adminResellersCorrectionTitle"))}</h3>
      <p class="nd-meta">${h(L("adminResellersCorrectionHelp"))}</p>
      <label class="nd-field"><span class="nd-label">${h(L("adminResellersFieldReseller"))}</span><select class="nd-input" name="resellerId" required>${options}</select></label>
      <label class="nd-field"><span class="nd-label">${h(L("adminResellersCorrectionAmount"))}</span><input class="nd-input" type="number" name="amount" min="-100000000" max="100000000" step="1" required></label>
      <label class="nd-field"><span class="nd-label">${h(L("adminResellersCorrectionReason"))}</span><input class="nd-input" name="reason" maxlength="200" required></label>
      <button type="submit" class="nd-btn nd-btn--secondary">${h(L("adminResellersCorrectionSave"))}</button>
      <p class="nd-meta" role="status" data-reseller-adjustment-message></p>
    </form>
  </div>
</details>` : ""}
<details class="admin-options admin-resellers__history"${remittances.length ? " open" : ""}>
  <summary>${h(L("adminResellersHandoffs", { count: remittances.length }))}</summary>
  ${remittances.length ? `<div class="nd-table-wrap"><table class="nd-table" data-remittance-history-table><thead><tr><th scope="col">${h(L("adminResellersColDate"))}</th><th scope="col">${h(L("adminResellersColReseller"))}</th><th scope="col">${h(L("adminResellersColAmount"))}</th><th scope="col">${h(L("adminResellersColBy"))}</th><th scope="col">${h(L("adminResellersColNote"))}</th></tr></thead>
  <tbody>${remittances.map((item) => `<tr data-remittance-id="${h(item.id)}"><td>${h(stamp(item.createdAt))}</td><td>${h(item.resellerName || item.resellerUsername)}</td><td><strong>${h(formatFcfa(item.amount))}</strong></td><td>${h(item.recordedBy || "—")}</td><td>${h(item.note || "—")}</td></tr>`).join("")}</tbody></table></div>`
    : `<p class="nd-meta">${h(L("adminResellersNoHandoffs"))}</p>`}
</details>
<details class="admin-options admin-resellers__history">
  <summary>${h(L("adminResellersCorrections", { count: adjustments.length }))}</summary>
  ${adjustments.length ? `<ul class="admin-resellers__corrections">${adjustments.map((item) => `<li>${h(stamp(item.createdAt))} · ${h(item.resellerName)} · ${h(formatFcfa(item.amount))} · ${h(item.reason)} · ${h(item.recordedBy)}</li>`).join("")}</ul>`
    : `<p class="nd-meta">${h(L("adminResellersNoCorrections"))}</p>`}
</details>`;
}

// "Commission split: N% · Change" for the page head (owners see Change).
function splitMarkup(ledger, { canManage }) {
  if (!Array.isArray(ledger?.resellers) || !ledger.resellers.length) return "";
  return `${h(L("adminResellersSplit"))} <strong>${h(percent(ledger.commissionPercent ?? 10))}</strong>${canManage ? ` · <button type="button" class="admin-linkbutton" data-rate-change aria-controls="rate">${h(L("adminResellersChange"))}</button>` : ""}`;
}

export function mountResellerLedger(container, { initialLedger, role = "owner", scopeKey, call, staff = {}, splitHost = null } = {}) {
  if (!container) return { refresh: async () => {} };
  let currentLedger = initialLedger;
  const canManage = () => role === "owner" && currentLedger?.canManageRemittances !== false;
  const operations = new Map();
  for (const type of ["remittance", "adjustment"]) {
    const state = { storageKey: scopeKey ? `ndahi-reseller-${type}:${scopeKey}` : "", pending: null, error: "" };
    try {
      const saved = state.storageKey && sessionStorage.getItem(state.storageKey);
      if (saved) {
        state.pending = JSON.parse(saved);
        if (!/^[A-Za-z0-9_-]{16,120}$/.test(state.pending.key || "") || !state.pending.payload?.resellerId || !Number.isInteger(state.pending.payload.amount)) throw new Error("Invalid saved operation");
      }
    } catch { state.error = L("adminResellersNoStorage"); }
    operations.set(type, state);
  }
  const name = (response) => response.reseller?.displayName || response.reseller?.username || L("adminResellersColReseller");
  function bindFinancialForm(form, type, messageEl) {
    if (!form || typeof call !== "function") return;
    const state = operations.get(type), textField = type === "remittance" ? "note" : "reason";
    if (state.pending) {
      for (const field of ["resellerId", "amount", textField]) if (form.elements[field]) form.elements[field].value = state.pending.payload[field] ?? "";
      for (const control of form.querySelectorAll("input, select")) control.disabled = true;
      form.dataset.operationKey = state.pending.key;
      if (messageEl && !messageEl.textContent) { messageEl.textContent = L("adminResellersSavedAction"); messageEl.hidden = false; }
    }
    form.onsubmit = async (event) => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (state.error || !state.storageKey) throw new Error(state.error || L("adminResellersReload"));
        if (!state.pending) {
          if ([...operations.values()].some((other) => other !== state && other.pending)) throw new Error(L("adminResellersConfirmEarlier"));
          const payload = Object.fromEntries(new FormData(form));
          payload.amount = Number(payload.amount); payload[textField] = String(payload[textField] || "").trim();
          state.pending = { key: createOperationKey(), payload };
          const serialized = JSON.stringify(state.pending);
          try {
            sessionStorage.setItem(state.storageKey, serialized);
            if (sessionStorage.getItem(state.storageKey) !== serialized) throw new Error("Storage unavailable");
          } catch { state.pending = null; throw new Error(L("adminResellersNoStorage")); }
        }
        const response = await call(`/api/admin/resellers/${type === "remittance" ? "remittances" : "adjustments"}`, {
          method: "POST", headers: { "idempotency-key": state.pending.key },
          body: JSON.stringify({ ...state.pending.payload, operationKey: state.pending.key }),
        });
        sessionStorage.removeItem(state.storageKey); state.pending = null;
        currentLedger = response.resellerLedger || currentLedger;
        const amount = formatFcfa(response[type]?.amount);
        if (type === "remittance") {
          const record = response.remittance || {};
          render({ remittance: L(response.replayed ? "adminResellersAlreadyRecorded" : "adminResellersRecorded",
            { amount, name: name(response), who: record.recordedBy && record.recordedBy !== staff.username ? record.recordedBy : staff.label || record.recordedBy || "", when: stamp(record.createdAt) }) });
        } else render({ adjustment: L(response.replayed ? "adminResellersCorrectionAgain" : "adminResellersCorrectionSaved", { amount, name: name(response) }) });
      } catch (error) {
        // Keep the exact key and payload across unknown replies, navigation and
        // reload. A validation refusal has no committed action.
        if (error.status >= 400 && error.status < 500) {
          try { sessionStorage.removeItem(state.storageKey); state.pending = null; } catch { /* keep the saved action */ }
        }
        render({ [type]: error.message || L("adminResellersCouldNotConfirm") });
      } finally { if (button.isConnected) button.disabled = false; }
    };
  }

  function render(messages = {}) {
    container.innerHTML = ledgerMarkup(currentLedger, { canManage: canManage() });
    const host = splitHost || document.getElementById("resellerSplit");
    if (host) host.innerHTML = splitMarkup(currentLedger, { canManage: canManage() });
    const show = (selector, text) => { const el = container.querySelector(selector); if (el && text) { el.textContent = text; el.hidden = false; } };
    show("[data-reseller-remittance-message]", messages.remittance);
    show("[data-reseller-adjustment-message]", messages.adjustment);
    show("[data-reseller-commission-message]", messages.commission);
    bindFinancialForm(container.querySelector("[data-reseller-remittance-form]"), "remittance", container.querySelector("[data-reseller-remittance-message]"));
    bindFinancialForm(container.querySelector("[data-reseller-adjustment-form]"), "adjustment", container.querySelector("[data-reseller-adjustment-message]"));
    const advanced = container.querySelector("[data-reseller-advanced]");
    if (advanced && (operations.get("adjustment")?.pending || messages.adjustment || messages.commission)) advanced.open = true;
    // Change: open the rate form below and put the cursor in it.
    const change = host && host.querySelector("[data-rate-change]");
    if (change && advanced) change.onclick = () => {
      advanced.open = true;
      advanced.scrollIntoView({ block: "start", behavior: "smooth" });
      advanced.querySelector('[name="commissionPercent"]')?.focus({ preventScroll: true });
    };
    const commissionForm = container.querySelector("[data-reseller-commission-form]");
    if (commissionForm && typeof call === "function") commissionForm.onsubmit = async (event) => {
      event.preventDefault();
      const button = commissionForm.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        // No reseller named: the one rate for every reseller, for codes issued from now on.
        const response = await call("/api/admin/resellers/commission", { method: "POST", body: JSON.stringify({ commissionPercent: Number(commissionForm.elements.commissionPercent.value) }) });
        currentLedger = response.resellerLedger || currentLedger;
        render({ commission: L("adminResellersRateSaved", { rate: percent(response.commissionPercent) }) });
      } catch (error) {
        render({ commission: error.message || L("adminResellersRateFailed") });
      } finally { if (button.isConnected) button.disabled = false; }
    };
  }

  render();
  return {
    async refresh() {
      if (typeof call !== "function") return;
      currentLedger = await call("/api/admin/resellers/ledger");
      render();
    },
  };
}
