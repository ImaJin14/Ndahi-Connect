const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );

export function formatFcfa(amount) {
  const num = Math.round(Number(amount || 0));
  return `${(Number.isFinite(num) ? num : 0).toLocaleString("en-US")} FCFA`;
}

export function renderResellerLedgerMarkup(ledger, { role = "owner" } = {}) {
  const summary = ledger || {};
  const totals = summary.totals || {};
  const resellers = Array.isArray(summary.resellers) ? summary.resellers : [];
  const remittances = Array.isArray(summary.remittances) ? summary.remittances : [];
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
        <span>Remitted to owner: ${escapeHtml(formatFcfa(totals.remittedTotal))}</span>
      </article>
    </div>

    <div class="table-scroll">
      <table class="reseller-ledger-table" data-reseller-table>
        <thead>
          <tr>
            <th>Reseller</th>
            <th>Stock (Unsold / Redeemed / Total)</th>
            <th>Cash collected</th>
            <th>Commission</th>
            <th>Net owed</th>
            <th>Remitted</th>
            <th>Outstanding balance</th>
          </tr>
        </thead>
        <tbody>
          ${resellers
            .map(
              (r) => `<tr data-reseller-row="${escapeHtml(r.resellerId)}">
                <td>
                  <strong>${escapeHtml(r.displayName || r.username)}</strong>
                  <div class="table-subtext">@${escapeHtml(r.username)}${r.active ? "" : " (inactive)"}</div>
                </td>
                <td data-cell="stock">${escapeHtml(r.unsoldVouchers)} unsold / ${escapeHtml(r.redeemedVouchers)} sold / ${escapeHtml(r.assignedVouchers)} total</td>
                <td data-cell="collected">${escapeHtml(formatFcfa(r.cashCollected))}</td>
                <td data-cell="commission">${escapeHtml(formatFcfa(r.commissionEarned))} (${escapeHtml(r.commissionPercent)}%)</td>
                <td data-cell="net-payable">${escapeHtml(formatFcfa(r.netPayableToOwner))}</td>
                <td data-cell="remitted">${escapeHtml(formatFcfa(r.remittedTotal))}</td>
                <td data-cell="outstanding"><strong>${escapeHtml(formatFcfa(r.outstandingBalance))}</strong></td>
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
              <h4>Record cash remittance handoff</h4>
              <label>Reseller
                <select name="resellerId" required>${resellerOptions}</select>
              </label>
              <label>Amount remitted (FCFA)
                <input type="number" name="amount" min="1" step="1" placeholder="15000" required>
              </label>
              <label>Handoff note (optional)
                <input type="text" name="note" maxlength="200" placeholder="Cash received at main office">
              </label>
              <button type="submit">Record remittance</button>
            </form>
            <form class="reseller-ledger-form" data-reseller-commission-form>
              <h4>Configure reseller commission split</h4>
              <label>Reseller
                <select name="resellerId" required>${resellerOptions}</select>
              </label>
              <label>Commission percentage (%)
                <input type="number" name="commissionPercent" min="0" max="100" step="0.5" value="${escapeHtml(resellers[0]?.commissionPercent ?? 10)}" required>
              </label>
              <button type="submit" class="secondary-action">Save commission %</button>
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
              <table data-remittance-history-table>
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
  </section>`;
}

export function mountResellerLedger(container, { initialLedger, role = "owner", call } = {}) {
  if (!container) return { refresh: async () => {} };
  let currentLedger = initialLedger;

  function render(statusMessage = "") {
    container.innerHTML = renderResellerLedgerMarkup(currentLedger, { role });
    const messageEl = container.querySelector("[data-reseller-ledger-message]");
    if (messageEl && statusMessage) {
      messageEl.textContent = statusMessage;
    }

    const remittanceForm = container.querySelector("[data-reseller-remittance-form]");
    if (remittanceForm && typeof call === "function") {
      remittanceForm.onsubmit = async (event) => {
        event.preventDefault();
        const submitBtn = remittanceForm.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        try {
          const payload = Object.fromEntries(new FormData(remittanceForm));
          payload.amount = Number(payload.amount);
          const response = await call("/api/admin/resellers/remittances", {
            method: "POST",
            body: JSON.stringify(payload),
          });
          currentLedger = response.resellerLedger || currentLedger;
          render(
            `Recorded ${formatFcfa(response.remittance?.amount)} cash remittance from ${response.reseller?.displayName || response.reseller?.username || "reseller"}.`,
          );
        } catch (error) {
          if (messageEl) messageEl.textContent = error.message || "Could not record remittance.";
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      };
    }

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
          const payload = Object.fromEntries(new FormData(commissionForm));
          payload.commissionPercent = Number(payload.commissionPercent);
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
