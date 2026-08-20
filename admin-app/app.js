const api = window.NDAHI_CONFIG.apiUrl,
  $ = (s) => document.querySelector(s),
  rows = (items, render) => items.map(render).join("");
let bundleIndex = new Map();
let activeAdminTab = "connections";
let csrfToken = "";
let passkeyEnrollmentRunning = false;
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  const message = document.querySelector("#actionMessage") || document.querySelector("#app");
  message.textContent = event.reason?.message || "The action could not be completed.";
});
async function call(path, options = {}) {
  const r = await fetch(api + path, {
      credentials: "include",
      ...options,
      headers: {
        "content-type": "application/json",
        ...(options.method && options.method !== "GET" && csrfToken ? { "x-csrf-token": csrfToken } : {}),
        ...(options.headers || {}),
      },
    }),
    j = await r.json();
  if (r.status === 401) {
    location.href = "/login";
    throw Error("Login required");
  }
  if (r.status === 503) {
    sessionStorage.setItem("ndahi-admin-login-notice", j.error || "Administration is temporarily unavailable while setup is completed.");
    location.replace("/login");
    throw Error("Service setup incomplete");
  }
  if (!r.ok) throw Error(j.error);
  return j;
}
async function load() {
  const x = await call("/api/admin/dashboard");
  csrfToken = x.csrfToken;
  const customerOptions = rows(
      x.customers,
      (c) => `<option value="${c.id}">${c.name} — ${c.phone}</option>`,
    ),
    bundleOptions = rows(
      x.bundles,
      (b) => `<option value="${b.id}">${b.name}</option>`,
    );
  bundleIndex = new Map(x.bundles.map((bundle) => [bundle.id, bundle]));
  $("#app").innerHTML = `<div id="actionMessage" class="error" role="alert" aria-live="assertive"></div>
${x.deployment?.mode === "setup" ? `<section class="setup-banner" role="status"><div><p class="section-kicker">Setup mode</p><h2>Finish connecting production services</h2><p>The dashboard and stored data are available. Customer purchases stay paused until every required service is connected and <code>BOOTSTRAP_MODE</code> is set to <code>false</code>.</p></div><div class="setup-services">${Object.entries(x.deployment.providers).map(([name, ready]) => `<span class="status-chip ${ready ? "status-good" : "status-warning"}">${name}: ${ready ? "ready" : "needs setup"}</span>`).join("")}</div></section>` : ""}
<div class="metrics">${
    Object.entries(x.metrics).map(([k, v]) =>
      `<div class="metric"><b>${v}</b>${k}</div>`
    ).join("")
  }</div>
<div class="admin-tabs" role="tablist" aria-label="Admin dashboard sections">
  ${[
    ["connections", "Connections"],
    ["bundles", "Bundles"],
    ["voucher-create", "Generate voucher"],
    ["customers", "Customers"],
    ["vouchers", "Vouchers"],
    ["payments", "Payments"],
    ["audit", "Audit"],
  ].map(([id, label]) => `<button role="tab" id="tab-${id}" aria-controls="panel-${id}" aria-selected="${activeAdminTab === id}" tabindex="${activeAdminTab === id ? "0" : "-1"}" data-tab="${id}">${label}</button>`).join("")}
</div><div class="tab-panels">
<section class="card integration-card tab-panel" id="panel-connections" role="tabpanel" aria-labelledby="tab-connections" data-tab-panel="connections" ${activeAdminTab === "connections" ? "" : "hidden"}><div class="section-heading"><div><p class="section-kicker">System health</p><h2>Connections & security</h2></div><span class="payment-chip">Payments: ${x.integrations.payments}</span></div><div class="integration-grid">
  <article class="integration-item"><div class="integration-copy"><div class="integration-title"><h3>MikroTik</h3><span class="status-chip ${x.integrations.mikrotik === "live" ? "status-good" : "status-warning"}">${x.integrations.mikrotik}</span></div><p>Refresh hotspot usage and quota readings from the router.</p></div><button class="secondary-action" id="syncUsage">Sync usage</button></article>
  <article class="integration-item"><div class="integration-copy"><div class="integration-title"><h3>Omada</h3><span class="status-chip ${x.integrations.omada === "live" ? "status-good" : "status-warning"}">${x.integrations.omada}</span></div><p>Check controller connectivity and access-point availability.</p></div><button class="secondary-action" id="checkOmada">Check connection</button></article>
  <article class="integration-item"><div class="integration-copy"><div class="integration-title"><h3>Account security</h3><span class="status-chip ${x.profile.mfaEnabled ? "status-good" : "status-warning"}">MFA ${x.profile.mfaEnabled ? "on" : "off"}</span></div><p>Protect the ${x.profile.role} account with an authenticator app.</p></div><form id="mfa"><button type="button" class="secondary-action" id="enrollPasskey">Add passkey</button><button type="button" class="secondary-action" id="enrollMfa">${x.profile.mfaEnabled ? "Reset authenticator" : "Configure MFA"}</button>${x.profile.mfaEnabled ? '<button type="button" class="text-action" id="disableMfa">Disable</button>' : ""}<div id="mfaEnrollment"></div></form></article>
</div><div id="integrationMessage" role="status" aria-live="polite"></div></section>
<section class="card tab-panel" id="panel-bundles" role="tabpanel" aria-labelledby="tab-bundles" data-tab-panel="bundles" ${activeAdminTab === "bundles" ? "" : "hidden"}><h2>Bundle management</h2><h3>Create bundle</h3><form id="bundle"><input name="name" aria-label="Bundle name" placeholder="Name" required><input name="price" aria-label="Price in FCFA" type="number" min="0" placeholder="FCFA" required><input name="quotaGb" aria-label="Quota in gigabytes" type="number" min="0" step="0.1" placeholder="GB (blank = unlimited)"><input name="validityHours" aria-label="Validity in hours" type="number" min="1" placeholder="Hours" required><input name="deviceLimit" aria-label="Device limit" type="number" min="1" placeholder="Devices" required><button>Create</button></form><form id="bundleEdit" hidden><input name="bundleId" type="hidden"><input name="name" aria-label="Bundle name" placeholder="Name" required><input name="price" aria-label="Price in FCFA" type="number" min="0" required><input name="quotaGb" aria-label="Quota in gigabytes" type="number" min="0" step="0.1" placeholder="Unlimited"><input name="validityHours" aria-label="Validity in hours" type="number" min="1" required><input name="deviceLimit" aria-label="Device limit" type="number" min="1" required><button>Save changes</button><button type="button" data-cancel-edit>Cancel</button></form><div id="bundleMessage" role="status" aria-live="polite"></div><table><thead><tr><th>Name</th><th>Price</th><th>Quota</th><th>Validity</th><th>Devices</th><th>Type</th><th>Actions</th></tr></thead><tbody>${
    rows(x.bundles, (b) =>
      `<tr><td>${b.name}</td><td>${b.price} FCFA</td><td>${
        b.quotaGb ?? "Unlimited"
      } GB</td><td>${b.validityHours} hours</td><td>${b.deviceLimit}</td><td>${
        b.custom ? "Custom" : "System"
      }</td><td><button data-edit-bundle="${b.id}">Edit</button>${
        b.custom ? ` <button data-delete-bundle="${b.id}">Delete</button>` : ""
      }</td></tr>`)
  }</tbody></table></section>
<section class="card tab-panel" id="panel-voucher-create" role="tabpanel" aria-labelledby="tab-voucher-create" data-tab-panel="voucher-create" ${activeAdminTab === "voucher-create" ? "" : "hidden"}><div class="section-heading"><div><p class="section-kicker">Voucher inventory</p><h2>Generate vouchers</h2></div></div><form id="generate" class="voucher-builder">
  <label>Purpose<select name="purpose" id="voucherPurpose"><option value="resale">Resale inventory</option><option value="assigned">Assign to customer</option></select></label>
  <label id="voucherCustomer" hidden>Customer<select name="customerId">${customerOptions}</select></label>
  <label>Bundle type<select name="planMode" id="voucherPlanMode"><option value="existing">Existing bundle</option><option value="custom">Custom voucher</option></select></label>
  <label id="voucherExistingPlan">Bundle<select name="planId">${bundleOptions}</select></label>
  <div id="voucherCustomFields" class="custom-voucher-fields" hidden>
    <label>Voucher name<input name="name" maxlength="80" placeholder="Weekend resale"></label>
    <label>Resale price (FCFA)<input name="price" type="number" min="0" placeholder="1000"></label>
    <label>Data allowance (GB)<input name="quotaGb" type="number" min="0.1" step="0.1" placeholder="Blank = unlimited"></label>
    <label>Validity after activation (hours)<input name="validityHours" type="number" min="1" placeholder="168"></label>
    <label>Device limit<input name="deviceLimit" type="number" min="1" value="1"></label>
  </div>
  <label id="voucherQuantity">Quantity<input name="quantity" type="number" min="1" max="100" value="1"></label>
  <p class="form-help" id="voucherHelp">Codes remain inactive and unassigned until the buyer first redeems them.</p>
  <button>Generate resale vouchers</button>
</form><div id="generated" role="status" aria-live="polite"></div></section>
<section class="card tab-panel" id="panel-customers" role="tabpanel" aria-labelledby="tab-customers" data-tab-panel="customers" ${activeAdminTab === "customers" ? "" : "hidden"}><h2>Customers and devices</h2><table>${
    rows(x.customers, (c) =>
      `<tr><td>${c.name}</td><td>${c.phone}</td><td>${
        c.status || "active"
      }</td><td><button data-customer="${c.id}" data-suspended="${c.status === "suspended"}">${c.status === "suspended" ? "Restore account" : "Suspend"}</button>${c.authenticatorEnrolled ? ` <button class="secondary-action" data-reset-authenticator="${c.id}">Reset authenticator</button>` : ""}</td></tr>`)
  }</table><h3>Active device sessions</h3><table>${
    rows(x.sessions, (s) =>
      `<tr><td>${s.label}</td><td>${s.deviceId}</td><td>${s.status}</td><td>${
        s.status === "online"
          ? `<button data-session="${s.id}">Disconnect</button>`
          : ""
      }</td></tr>`)
  }</table></section>
<section class="card tab-panel" id="panel-vouchers" role="tabpanel" aria-labelledby="tab-vouchers" data-tab-panel="vouchers" ${activeAdminTab === "vouchers" ? "" : "hidden"}><h2>Vouchers</h2><table>${
    rows(x.vouchers, (v) =>
      `<tr><td><code>${v.code}</code></td><td>${v.plan?.name}</td><td>${v.status}</td><td>${v.activeDevices}/${v.deviceLimit}</td><td>${
        v.status === "active"
          ? `<button data-voucher="${v.id}">Revoke</button>`
          : ""
      }</td></tr>`)
  }</table></section>
<section class="card tab-panel" id="panel-payments" role="tabpanel" aria-labelledby="tab-payments" data-tab-panel="payments" ${activeAdminTab === "payments" ? "" : "hidden"}><h2>Payments and usage</h2><table>${
    rows(x.payments, (p) =>
      `<tr><td>${p.amount} ${p.currency}</td><td>${p.provider}</td><td>${p.providerReference}</td><td>${p.status}</td><td>${
        p.status === "paid"
          ? `<button data-refund="${p.id}">Refund</button>`
          : ""
      }</td></tr>`)
  }</table></section>
<section class="card tab-panel" id="panel-audit" role="tabpanel" aria-labelledby="tab-audit" data-tab-panel="audit" ${activeAdminTab === "audit" ? "" : "hidden"}><h2>Audit log</h2><table>${
    rows(x.auditLogs, (a) =>
      `<tr><td>${
        new Date(a.at).toLocaleString()
      }</td><td>${a.action}</td><td>${a.ip}</td></tr>`)
  }</table></section></div>`;
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const activateTab = (tab, moveFocus = false) => {
    activeAdminTab = tab.dataset.tab;
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute("aria-selected", String(selected));
      item.tabIndex = selected ? 0 : -1;
    }
    for (const panel of document.querySelectorAll("[data-tab-panel]")) {
      panel.hidden = panel.dataset.tabPanel !== activeAdminTab;
    }
    if (moveFocus) tab.focus();
  };
  for (const [index, tab] of tabs.entries()) {
    tab.onclick = () => activateTab(tab);
    tab.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      activateTab(tabs[nextIndex], true);
    };
  }
  const updateVoucherBuilder = () => {
    const resale = $("#voucherPurpose").value === "resale",
      custom = $("#voucherPlanMode").value === "custom",
      form = $("#generate");
    $("#voucherCustomer").hidden = resale;
    $("#voucherQuantity").hidden = !resale;
    $("#voucherExistingPlan").hidden = custom;
    $("#voucherCustomFields").hidden = !custom;
    $("#voucherHelp").textContent = resale
      ? "Codes remain inactive and unassigned until the buyer first redeems them."
      : "The voucher activates immediately and is linked to the selected customer.";
    form.querySelector('button[type="submit"], button:not([type])').textContent = resale
      ? "Generate resale vouchers"
      : "Generate assigned voucher";
    for (const input of $("#voucherCustomFields").querySelectorAll("input")) {
      input.required = custom && input.name !== "quotaGb";
    }
  };
  $("#voucherPurpose").onchange = updateVoucherBuilder;
  $("#voucherPlanMode").onchange = updateVoucherBuilder;
  updateVoucherBuilder();
  $("#bundle").onsubmit = async (e) => {
    e.preventDefault();
    await call("/api/admin/bundles", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    load();
  };
  $("#bundleEdit").onsubmit = async (e) => {
    e.preventDefault();
    await call("/api/admin/bundles/update", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    load();
  };
  $("#generate").onsubmit = async (e) => {
    e.preventDefault();
    const result = await call("/api/admin/vouchers/generate", {
      method: "POST",
      body: JSON.stringify(Object.fromEntries(new FormData(e.target))),
    });
    const vouchers = result.vouchers || [result.voucher];
    $("#generated").innerHTML = `<div class="generated-heading"><div><strong>${vouchers.length} voucher${vouchers.length === 1 ? "" : "s"} generated</strong><p>${result.voucher.status === "available" ? "Ready for resale. Validity starts on first redemption." : "Assigned and active."}</p></div><button type="button" class="secondary-action" id="downloadVouchers">Download CSV</button></div><div class="generated-codes">${vouchers.map((voucher) => `<code>${voucher.code}</code>`).join("")}</div>`;
    $("#downloadVouchers").onclick = () => {
      const csv = ["code,bundle,status", ...vouchers.map((voucher) => `${voucher.code},"${String(result.plan.name).replaceAll('"', '""')}",${voucher.status}`)].join("\n"),
        link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
      link.download = `ndahi-vouchers-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    };
  };
  $("#syncUsage").onclick = async () => {
    const result = await call("/api/admin/integrations/sync-usage", {
      method: "POST",
      body: "{}",
    });
    $("#integrationMessage").textContent =
      `Updated ${result.updated} of ${result.readings} usage records.`;
  };
  $("#checkOmada").onclick = async () => {
    const result = await call("/api/admin/integrations/omada");
    $("#integrationMessage").textContent = result.connected
      ? `Omada connected (${result.accessPoints.length} access points).`
      : result.error;
  };
  $("#enrollPasskey").onclick = async () => {
    if (passkeyEnrollmentRunning) return;
    const button = $("#enrollPasskey");
    passkeyEnrollmentRunning = true;
    button.disabled = true;
    button.textContent = "Waiting for device…";
    try {
      let result = await call("/api/admin/profile/passkeys/options", { method: "POST", body: "{}" });
      if (result.options.rp?.id && result.options.rp.id !== location.hostname) {
        throw Error(`Open the admin panel at http://${result.options.rp.id}:8081 before enrolling this passkey.`);
      }
      const credential = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: result.options });
      result = await call("/api/admin/profile/passkeys/verify", { method: "POST", body: JSON.stringify({ challengeId: result.challengeId, response: credential }) });
      $("#integrationMessage").textContent = `Passkey enrolled. This account now has ${result.passkeys} passkey${result.passkeys === 1 ? "" : "s"}.`;
    } catch (error) {
      $("#integrationMessage").textContent = error.name === "AbortError" || /abort signal/i.test(error.message)
        ? "The browser cancelled the passkey prompt. Close any other passkey prompt, reload this page, and select Add passkey once."
        : error.message;
    } finally {
      passkeyEnrollmentRunning = false;
      button.disabled = false;
      button.textContent = "Add passkey";
    }
  };
  $("#enrollMfa").onclick = async () => {
    const result = await call("/api/admin/profile/mfa/enroll", {
      method: "POST",
      body: "{}",
    });
    $("#mfaEnrollment").innerHTML =
      `<p>Add this secret to your authenticator: <code>${result.secret}</code></p><input id="totpCode" inputmode="numeric" maxlength="6" placeholder="Authenticator code"><button type="button" id="confirmMfa">Confirm</button>`;
    $("#confirmMfa").onclick = async () => {
      await call("/api/admin/profile/mfa/confirm", {
        method: "POST",
        body: JSON.stringify({ code: $("#totpCode").value }),
      });
      load();
    };
  };
  if ($("#disableMfa")) $("#disableMfa").onclick = async () => {
    await call("/api/admin/profile/mfa", {
      method: "POST",
      body: JSON.stringify({ enabled: false }),
    });
    load();
  };
}
$("#app").onclick = async (e) => {
  if (e.target.dataset.editBundle) {
    const bundle = bundleIndex.get(e.target.dataset.editBundle),
      form = $("#bundleEdit");
    form.hidden = false;
    $("#bundle").hidden = true;
    for (
      const [name, value] of Object.entries({
        bundleId: bundle.id,
        name: bundle.name,
        price: bundle.price,
        quotaGb: bundle.quotaGb ?? "",
        validityHours: bundle.validityHours,
        deviceLimit: bundle.deviceLimit,
      })
    ) form.elements[name].value = value;
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  if (e.target.hasAttribute("data-cancel-edit")) {
    $("#bundleEdit").hidden = true;
    $("#bundle").hidden = false;
    return;
  }
  if (e.target.dataset.deleteBundle) {
    if (!confirm("Delete this custom bundle? This cannot be undone.")) return;
    try {
      await call("/api/admin/bundles/delete", {
        method: "POST",
        body: JSON.stringify({ bundleId: e.target.dataset.deleteBundle }),
      });
    } catch (error) {
      $("#bundleMessage").textContent = error.message;
      return;
    }
  } else if (e.target.dataset.voucher) {
    if (!confirm("Revoke this voucher and disconnect its access?")) return;
    await call("/api/admin/vouchers/revoke", {
      method: "POST",
      body: JSON.stringify({ voucherId: e.target.dataset.voucher }),
    });
  } else if (e.target.dataset.resetAuthenticator) {
    if (!confirm("Reset this customer's authenticator? Their active portal sessions will be signed out.")) return;
    await call("/api/admin/customers/reset-authenticator", {
      method: "POST",
      body: JSON.stringify({ customerId: e.target.dataset.resetAuthenticator }),
    });
  } else if (e.target.dataset.customer) {
    const restoring = e.target.dataset.suspended === "true";
    if (!confirm(restoring ? "Restore this customer account?" : "Suspend this customer and disconnect active vouchers?")) return;
    await call("/api/admin/customers/suspend", {
      method: "POST",
      body: JSON.stringify({ customerId: e.target.dataset.customer, suspended: e.target.dataset.suspended !== "true" }),
    });
  } else if (e.target.dataset.session) {
    if (!confirm("Disconnect this device session?")) return;
    await call("/api/admin/devices/disconnect", {
      method: "POST",
      body: JSON.stringify({ sessionId: e.target.dataset.session }),
    });
  } else if (e.target.dataset.refund) {
    if (!confirm("Request a full refund for this payment?")) return;
    await call("/api/admin/payments/refund", {
      method: "POST",
      body: JSON.stringify({ paymentId: e.target.dataset.refund }),
    });
  } else return;
  load();
};
$("#logout").onclick = async () => {
  await call("/api/admin/logout", { method: "POST", body: "{}" });
  location.href = "/login";
};
load();
