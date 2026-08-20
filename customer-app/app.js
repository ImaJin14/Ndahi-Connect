const api = window.NDAHI_CONFIG.apiUrl,
  $ = (selector) => document.querySelector(selector),
  deviceId = localStorage.getItem("ndahi-device") || crypto.randomUUID(),
  fmt = (value) => value === null ? "Unlimited" : `${(value / 1e9).toFixed(2)} GB`;
localStorage.setItem("ndahi-device", deviceId);

async function call(path, options = {}) {
  const response = await fetch(api + path, { credentials: "include", ...options, headers: { "content-type": "application/json", ...(options.headers || {}) } }),
    result = await response.json();
  if (response.status === 401 || response.status === 503) {
    if (response.status === 503) sessionStorage.setItem("ndahi-login-notice", result.error || "Customer access is temporarily unavailable while setup is completed.");
    location.replace("/login");
    throw Error(response.status === 401 ? "Login required" : "Service setup incomplete");
  }
  if (!response.ok) throw Error(result.error || "Request failed");
  return result;
}

async function runButton(button, pendingText, task) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = pendingText;
  try { return await task(); } finally { button.disabled = false; button.textContent = original; }
}

async function load() {
  const result = await call("/api/account/dashboard"), active = result.activeBundle,
    usage = active?.usagePercentage ?? 0;
  $("#dashboard").innerHTML = `<div class="dashboard-grid">
    <section class="surface"><p class="eyebrow">Active bundle</p><h2>${active ? active.plan.name : "No active bundle"}</h2>${active ? `<progress class="usage-progress" max="100" value="${usage}" aria-label="${usage.toFixed(1)}% of bundle used"></progress><div class="stats"><div class="stat"><b>${fmt(active.remainingBytes)}</b><small>Remaining</small></div><div class="stat"><b>${usage.toFixed(1)}%</b><small>Used</small></div><div class="stat"><b>${new Date(active.expiresAt).toLocaleDateString()}</b><small>Expires</small></div></div>` : "<p>Choose a package to get connected.</p>"}</section>
    <section class="surface"><h2>Connected devices</h2>${active?.sessions.length ? active.sessions.map((session) => `<div class="device"><div><b>${session.label}</b><br><small>${session.deviceId.slice(0, 14)}…</small></div><button type="button" data-session="${session.id}">Disconnect</button></div>`).join("") : "<p>No devices are currently connected.</p>"}${active ? `<p>${active.activeDevices} of ${active.deviceLimit} device slots in use</p>` : ""}</section>
    <section class="surface full"><p class="eyebrow">Account security</p><h2>Passkeys</h2><p>Use your device lock, fingerprint, or security key to sign in without entering a voucher.</p><button type="button" id="addCustomerPasskey">Add a passkey</button><p>${result.customer.passkeys || 0} passkey${result.customer.passkeys === 1 ? "" : "s"} enrolled</p></section>
    <section class="surface full"><h2>Bundle history</h2><div class="table-scroll"><table><thead><tr><th>Bundle</th><th>Status</th><th>Activated</th><th>Expires</th></tr></thead><tbody>${result.vouchers.map((item) => `<tr><td>${item.plan.name}</td><td>${item.status}</td><td>${new Date(item.activatedAt).toLocaleDateString()}</td><td>${new Date(item.expiresAt).toLocaleDateString()}</td></tr>`).join("")}</tbody></table></div></section>
    <section class="surface full"><h2>Payment history</h2><div class="table-scroll"><table><thead><tr><th>Date</th><th>Provider</th><th>Amount</th><th>Status</th></tr></thead><tbody>${result.payments.map((payment) => `<tr><td>${new Date(payment.createdAt).toLocaleDateString()}</td><td>${payment.provider}</td><td>${payment.amount.toLocaleString()} ${payment.currency}</td><td>${payment.status}</td></tr>`).join("")}</tbody></table></div></section>
  </div>`;
}

$("#redeem").onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter || event.target.querySelector("button");
  $("#redeemMessage").textContent = "";
  try {
    await runButton(button, "Connecting…", async () => {
      const result = await call("/api/vouchers/redeem", { method: "POST", body: JSON.stringify({ ...Object.fromEntries(new FormData(event.target)), deviceId }) });
      $("#redeemMessage").innerHTML = `<div class="success">Connected successfully. ${result.voucher.activeDevices}/${result.voucher.deviceLimit} slots are now in use.</div>`;
      await load();
    });
  } catch (error) { $("#redeemMessage").innerHTML = `<p class="error">${error.message}</p>`; }
};

$("#dashboard").onclick = async (event) => {
  const passkeyButton = event.target.closest("#addCustomerPasskey");
  if (passkeyButton) {
    try {
      await runButton(passkeyButton, "Opening passkey…", async () => {
        let result = await call("/api/account/passkeys/options", {
          method: "POST", body: "{}",
        });
        const credential = await SimpleWebAuthnBrowser.startRegistration({
          optionsJSON: result.options,
        });
        result = await call("/api/account/passkeys/verify", {
          method: "POST",
          body: JSON.stringify({
            challengeId: result.challengeId, response: credential,
          }),
        });
        $("#dashboardMessage").textContent = `Passkey added. ${result.passkeys} enrolled.`;
        await load();
      });
    } catch (error) {
      $("#dashboardMessage").textContent = error.name === "AbortError" ||
          /abort signal/i.test(error.message)
        ? "The browser cancelled passkey setup. Reload and try once."
        : error.message;
    }
    return;
  }
  const button = event.target.closest("button[data-session]");
  if (!button) return;
  try {
    await runButton(button, "Disconnecting…", async () => {
      await call("/api/account/devices/disconnect", { method: "POST", body: JSON.stringify({ sessionId: button.dataset.session }) });
      await load();
    });
  } catch (error) { $("#dashboardMessage").textContent = error.message; }
};

$("#logout").onclick = async (event) => {
  try {
    await runButton(event.currentTarget, "Logging out…", () => call("/api/account/logout", { method: "POST", body: "{}" }));
    location.href = "/login";
  } catch (error) { $("#dashboardMessage").textContent = error.message; }
};

load().catch((error) => { $("#dashboard").innerHTML = `<p class="error">${error.message}</p>`; });
