const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

function createOperationKey() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `op-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function formatFcfa(amount) {
  const num = Math.round(Number(amount || 0));
  return `${(Number.isFinite(num) ? num : 0).toLocaleString("en-US")} FCFA`;
}

export function renderResellerLedgerMarkup(ledger, { role = "owner" } = {}) {
  const summary = ledger || {};
  const totals = summary.totals || {};
  const resellers = Array.isArray(summary.resellers) ? summary.resellers : [];
  const remittances = Array.isArray(summary.remittances) ? summary.remittances : [];
  const adjustments = Array.isArray(summary.adjustments) ? summary.adjustments : [];
  const isReseller = role === "reseller" || summary.scope === "self";
  const canManage = role === "owner" && summary.canManageRemittances !== false;

  if (!resellers.length) {
    return `<section class="reseller-ledger-section" data-reseller-ledger>
      <div class="section-heading">
        <div>
          <p class="section-kicker">Reseller operations</p>
          <h3>${isReseller ? "My reseller inventory & earnings" : "Reseller inventory & cash remittance ledger"}</h3>
        </div>
      </div>
      <p class="reseller-ledger-empty">No reseller staff accounts configured yet. Add a staff account with the <code>reseller</code> role to track assigned stock, commissions, and cash handoffs.</p>
    </section>`;
  }

  const resellerOptions = resellers
    .map(
      (r) =>
        `<option value="${escapeHtml(r.resellerId)}">${escapeHtml(r.displayName || r.username)} (${escapeHtml(r.username)}) — ${escapeHtml(r.commissionPercent)}% commission</option>`,
    )
    .join("");

  return `<section class="reseller-ledger-section" data-reseller-ledger>
    <div class="section-heading">
      <div>
        <p class="section-kicker">${isReseller ? "My reseller account" : "Reseller operations"}</p>
        <h3>${isReseller ? "My inventory, sales & cash remittance" : "Reseller inventory, sales & cash remittance ledger"}</h3>
      </div>
      <span class="payment-chip" data-reseller-debt-chip>Outstanding: ${escapeHtml(formatFcfa(totals.outstandingBalance))}</span>
    </div>
    <div class="sales-grid reseller-ledger-totals" data-reseller-totals>
      <article class="sales-card">
        <p class="section-kicker">Assigned stock</p>
        <strong data-total-assigned>${escapeHtml(totals.assignedVouchers || 0)} vouchers</strong>
        <span>${escapeHtml(totals.unsoldVouchers || 0)} unsold (${escapeHtml(formatFcfa(totals.unsoldFaceValue))}) · ${escapeHtml(totals.redeemedVouchers || 0)} redeemed</span>
      </article>
      <article class="sales-card">
        <p class="section-kicker">Redeemed sales</p>
        <strong data-total-cash-collected>${escapeHtml(formatFcfa(totals.cashCollected))}</strong>
        <span>Gross cash collected on redeemed resale codes</span>
      </article>
      <article class="sales-card">
        <p class="section-kicker">${isReseller ? "Commission earned" : "Reseller commissions"}</p>
        <strong data-total-commission>${escapeHtml(formatFcfa(totals.commissionEarned))}</strong>
        <span>Net payable to owner: ${escapeHtml(formatFcfa(totals.netPayableToOwner))}</span>
      </article>
      <article class="sales-card">
        <p class="section-kicker">Cash remitted &amp; balance</p>
        <strong data-total-outstanding>${escapeHtml(formatFcfa(totals.outstandingBalance))} due</strong>
        <span>Remitted to owner: ${escapeHtml(formatFcfa(totals.remittedTotal))} · Credit: ${escapeHtml(formatFcfa(totals.creditBalance))}</span>
      </article>
    </div>

    <div class="table-scroll">
      <table class="reseller-ledger-table nd-table" data-reseller-table>
        <thead>
          <tr>
            <th>Reseller</th>
            <th>Stock (Unsold / Redeemed / Total)</th>
            <th>Cash collected</th>
            <th>Commission</th>
            <th>Owed to owner</th>
            <th>Remitted</th>
            <th>Outstanding</th>
          </tr>
        </thead>
        <tbody>
          ${resellers
            .map(
              (r) => `<tr data-reseller-row="${escapeHtml(r.resellerId)}">
                <td>
                  <strong>${escapeHtml(r.displayName || r.username)}</strong>
                  <div class="table-subtext">@${escapeHtml(r.username)}${r.role && r.role !== "reseller" ? ` (${escapeHtml(r.role)})` : ""}${r.active ? "" : " (inactive)"}</div>
                </td>
                <td data-cell="stock">${escapeHtml(r.unsoldVouchers)} unsold / ${escapeHtml(r.redeemedVouchers)} sold / ${escapeHtml(r.assignedVouchers)} total</td>
                <td data-cell="collected">${escapeHtml(formatFcfa(r.cashCollected))}</td>
                <td data-cell="commission">${escapeHtml(formatFcfa(r.commissionEarned))} (${escapeHtml(r.commissionPercent)}%)</td>
                <td data-cell="net-payable">${escapeHtml(formatFcfa(r.netPayableToOwner))}</td>
                <td data-cell="remitted">${escapeHtml(formatFcfa(r.remittedTotal))}</td>
                <td data-cell="outstanding"><strong>${escapeHtml(formatFcfa(r.outstandingBalance))}</strong>${r.creditBalance ? `<small>Credit: ${escapeHtml(formatFcfa(r.creditBalance))}</small>` : ""}</td>
              </tr>`,
            )
            .join("")}
        </tbody>
      </table>
    </div>

    ${
      canManage
        ? `<div class="reseller-ledger-actions">
            <form class="reseller-ledger-form" data-reseller-remittance-form>
              <h4>Record a cash handoff</h4>
              <label>Reseller
                <select name="resellerId" required>${resellerOptions}</select>
              </label>
              <label>Amount received (FCFA)
                <input type="number" name="amount" min="1" step="1" placeholder="15000" required>
              </label>
              <label>Handoff note (optional)
                <input type="text" name="note" maxlength="200" placeholder="Cash received at main office">
              </label>
              <button type="submit" class="nd-btn">Record remittance</button>
            </form>
            <form class="reseller-ledger-form" data-reseller-commission-form>
              <h4>Commission split</h4>
              <label>Reseller
                <select name="resellerId" required>${resellerOptions}</select>
              </label>
              <label>Commission percentage (%)
                <input type="number" name="commissionPercent" min="0" max="100" step="0.5" value="${escapeHtml(resellers[0]?.commissionPercent ?? 10)}" required>
              </label>
              <label class="checkbox">
                <input type="checkbox" name="applyToUnsoldStock" value="true">
                Apply new rate to existing unsold stock (completed sales keep agreed rate)
              </label>
              <button type="submit" class="nd-btn nd-btn--secondary">Save commission %</button>
            </form>
            <form class="reseller-ledger-form" data-reseller-adjustment-form>
              <h4>Record a balance correction</h4>
              <p>Positive amounts add to the amount due; negative amounts credit the reseller. Completed sales remain in history.</p>
              <label>Reseller<select name="resellerId" required>${resellerOptions}</select></label>
              <label>Correction (FCFA)<input type="number" name="amount" min="-100000000" max="100000000" step="1" required></label>
              <label>Reason<input name="reason" maxlength="200" required></label>
              <button type="submit" class="nd-btn nd-btn--secondary">Record adjustment</button>
            </form>
          </div>`
        : ""
    }
    <div data-reseller-ledger-message role="status" aria-live="polite"></div>

    <details class="reseller-remittance-history" ${remittances.length ? "open" : ""}>
      <summary>Audited cash remittance handoffs (${escapeHtml(remittances.length)})</summary>
      ${
        remittances.length
          ? `<div class="table-scroll">
              <table class="nd-table" data-remittance-history-table>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Reseller</th>
                    <th>Amount remitted</th>
                    <th>Recorded by</th>
                    <th>Note</th>
                  </tr>
                </thead>
                <tbody>
                  ${remittances
                    .map(
                      (item) => `<tr data-remittance-id="${escapeHtml(item.id)}">
                        <td>${escapeHtml(item.createdAt ? new Date(item.createdAt).toLocaleString() : "—")}</td>
                        <td>${escapeHtml(item.resellerName || item.resellerUsername)}</td>
                        <td><strong>${escapeHtml(formatFcfa(item.amount))}</strong></td>
                        <td>${escapeHtml(item.recordedBy || "owner")}</td>
                        <td>${escapeHtml(item.note || "—")}</td>
                      </tr>`,
                    )
                    .join("")}
                </tbody>
              </table>
            </div>`
          : `<p>No cash remittances recorded yet.</p>`
      }
    </details>
    <details class="reseller-remittance-history"><summary>Audited balance corrections (${escapeHtml(adjustments.length)})</summary>
      ${adjustments.length ? `<ul>${adjustments.map(item => `<li>${escapeHtml(item.createdAt)} · ${escapeHtml(item.resellerName)} · ${escapeHtml(formatFcfa(item.amount))} · ${escapeHtml(item.reason)} · ${escapeHtml(item.recordedBy)}</li>`).join("")}</ul>` : "<p>No balance corrections recorded.</p>"}
    </details>
  </section>`;
}

export function mountResellerLedger(container, { initialLedger, role = "owner", scopeKey, call } = {}) {
  if (!container) return { refresh: async () => {} };
  let currentLedger = initialLedger;
  const operations = new Map();
  for (const type of ["remittance", "adjustment"]) {
    const state = { storageKey: scopeKey ? `ndahi-reseller-${type}:${scopeKey}` : "", pending: null, error: "" };
    try {
      const saved = state.storageKey && sessionStorage.getItem(state.storageKey);
      if (saved) {
        state.pending = JSON.parse(saved);
        if (!/^[A-Za-z0-9_-]{16,120}$/.test(state.pending.key || "") || !state.pending.payload?.resellerId || !Number.isInteger(state.pending.payload.amount)) throw new Error("Invalid saved operation");
      }
    } catch { state.error = "Saved ledger action access is unavailable. Use a browser with session storage before recording cash or corrections."; }
    operations.set(type, state);
  }
  function bindFinancialForm(form, type, messageEl) {
    if (!form || typeof call !== "function") return;
    const state = operations.get(type), textField = type === "remittance" ? "note" : "reason";
    if (state.pending) {
      for (const name of ["resellerId", "amount", textField]) form.elements[name].value = state.pending.payload[name] ?? "";
      for (const control of form.querySelectorAll("input, select")) control.disabled = true;
      form.dataset.operationKey = state.pending.key;
      if (messageEl && !messageEl.textContent) messageEl.textContent = "An earlier ledger action may already be recorded. Retry the saved action to confirm it before entering another.";
    }
    form.onsubmit = async event => {
      event.preventDefault();
      const button = form.querySelector('button[type="submit"]');
      if (button.disabled) return;
      button.disabled = true;
      try {
        if (state.error || !state.storageKey) throw new Error(state.error || "Reload the signed-in ledger before recording a change.");
        if (!state.pending) {
          if ([...operations.values()].some(other => other !== state && other.pending)) throw new Error("Confirm the earlier saved ledger action before recording another.");
          const payload = Object.fromEntries(new FormData(form));
          payload.amount = Number(payload.amount); payload[textField] = String(payload[textField] || "").trim();
          state.pending = { key: createOperationKey(), payload };
          const serialized = JSON.stringify(state.pending);
          try {
            sessionStorage.setItem(state.storageKey, serialized);
            if (sessionStorage.getItem(state.storageKey) !== serialized) throw new Error("Storage unavailable");
          } catch { state.pending = null; throw new Error("Enable session storage before recording this change; nothing was submitted."); }
        }
        const response = await call(`/api/admin/resellers/${type === "remittance" ? "remittances" : "adjustments"}`, {
          method: "POST", headers: { "idempotency-key": state.pending.key },
          body: JSON.stringify({ ...state.pending.payload, operationKey: state.pending.key }),
        });
        sessionStorage.removeItem(state.storageKey); state.pending = null;
        currentLedger = response.resellerLedger || currentLedger;
        const label = response.reseller?.displayName || response.reseller?.username || "reseller";
        const amount = response[type]?.amount;
        render(type === "remittance"
          ? response.replayed ? `Already recorded ${formatFcfa(amount)} cash remittance from ${label} (duplicate submission prevented).` : `Recorded ${formatFcfa(amount)} cash remittance from ${label}.`
          : `${response.replayed ? "Already recorded" : "Recorded"} ${formatFcfa(amount)} balance correction for ${label}.`);
      } catch (error) {
        // Retain the exact key and immutable payload across unknown replies,
        // navigation and reload. Validation rejections have no committed action.
        if (error.status >= 400 && error.status < 500) {
          try { sessionStorage.removeItem(state.storageKey); state.pending = null; } catch { /* retain the saved action */ }
        }
        render(error.message || "Could not confirm the change. Retry the saved action.");
      } finally { if (button.isConnected) button.disabled = false; }
    };
  }

  function render(statusMessage = "") {
    container.innerHTML = renderResellerLedgerMarkup(currentLedger, { role });
    const messageEl = container.querySelector("[data-reseller-ledger-message]");
    if (messageEl && statusMessage) {
      messageEl.textContent = statusMessage;
    }

    bindFinancialForm(container.querySelector("[data-reseller-remittance-form]"), "remittance", messageEl);
    bindFinancialForm(container.querySelector("[data-reseller-adjustment-form]"), "adjustment", messageEl);

    const commissionForm = container.querySelector("[data-reseller-commission-form]");
    if (commissionForm && typeof call === "function") {
      const selectEl = commissionForm.querySelector('select[name="resellerId"]');
      const inputEl = commissionForm.querySelector('input[name="commissionPercent"]');
      if (selectEl && inputEl) {
        selectEl.onchange = () => {
          const row = (currentLedger?.resellers || []).find((r) => r.resellerId === selectEl.value);
          if (row) inputEl.value = String(row.commissionPercent);
        };
      }
      commissionForm.onsubmit = async (event) => {
        event.preventDefault();
        const submitBtn = commissionForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        try {
          const formData = new FormData(commissionForm);
          const payload = {
            resellerId: formData.get("resellerId"),
            commissionPercent: Number(formData.get("commissionPercent")),
            applyToUnsoldStock: formData.get("applyToUnsoldStock") === "true",
          };
          const response = await call("/api/admin/resellers/commission", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          currentLedger = response.resellerLedger || currentLedger;
          render(
            `Updated commission split for ${response.reseller?.displayName || response.reseller?.username || "reseller"} to ${response.reseller?.commissionPercent}%.`,
          );
        } catch (error) {
          if (messageEl) messageEl.textContent = error.message || "Could not update commission rate.";
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      };
    }
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
