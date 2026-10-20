import { escapeHtml as h } from "/shared/safe-html.js";
import { isPending, runButton } from "/shared/pending.js";

let stopPrevious = () => {};
export async function mountNetworkSetup(root, call) {
  stopPrevious();
  if (!root) return;
  let stopped = false, timer, state, selectedJob;
  stopPrevious = () => { stopped = true; clearTimeout(timer); };
  const request = (action, data = {}) => call(`/api/admin/network/setup/${action}`, action === "status" ? {} : { method: "POST", body: JSON.stringify(data) });
  root.innerHTML = `<div class="section-heading"><div><p class="section-kicker">Network setup</p><h2>Connect and configure your equipment</h2></div></div>
    <p>Start with a wired management connection. Connect the server to your router and controller through a private tunnel, and enable their HTTPS management APIs.</p>
    <p id="networkPrerequisites" role="status">Checking setup…</p>
    <section><h3>Buying with no active data</h3><p>Inspect the saved router's access rules and routes for the portal and API. This check does not change router settings. Users must be able to buy on NDAHI Wi-Fi before their first bundle and after their data runs out.</p><button type="button" id="networkPurchaseCheck">Check purchase access</button><div id="networkPurchaseReport" aria-live="polite"></div></section>
    <div class="network-setup-grid">
    <form id="networkRouterConnection"><h3>1. Connect MikroTik</h3>
      <label>Connection mode<select name="mode"><option value="live">Live equipment</option><option value="simulation">Simulation — no equipment changes</option></select></label>
      <label>Router HTTPS address<input name="url" type="url" placeholder="https://router.management.example"></label>
      <label>Service username<input name="username" autocomplete="off"></label>
      <label>Service password<input name="password" type="password" autocomplete="new-password" placeholder="Leave blank to keep saved password"></label>
      <button>Save router connection</button><button type="button" data-discover="router" class="secondary-action">Discover router</button>
    </form>
    <form id="networkOmadaConnection"><h3>1. Connect Omada</h3><p id="networkOmadaNote" hidden></p>
      <label>Controller HTTPS address<input name="url" type="url" required placeholder="https://controller.management.example:8043"></label>
      <label>Controller ID<input name="controllerId" required></label><label>Site ID<input name="siteId" required></label>
      <label>WLAN group ID<input name="wlanId" required></label><label>Open API client ID<input name="clientId" required autocomplete="off"></label>
      <label>Open API client secret<input name="clientSecret" type="password" autocomplete="new-password" placeholder="Leave blank to keep saved secret"></label>
      <button>Save controller connection</button><button type="button" data-discover="omada" class="secondary-action">Discover access points</button>
    </form></div>
    <div id="networkInventory" aria-live="polite"></div>
    <section><h3>Voucher enforcement</h3><p id="networkEnforcementStatus"></p><p>Activate a tested hotspot to send vouchers, quotas, and expiry limits to this router. A hotspot configured manually is checked for HTTPS login, guest DHCP, clock synchronization, and scheduler support before activation. Individual device disconnection requires a trusted hotspot MAC mapping; browser device IDs are not sufficient.</p><label class="network-checkbox"><input type="checkbox" id="networkEnforcementTested"> I tested Wi-Fi, hotspot login and internet access, and verified the router clock is synchronized.</label><button type="button" id="networkActivate" disabled>Use saved router for vouchers</button></section>
    <section><h3>Assisted device connections</h3><p id="networkPairingStatus"></p><p>Require approval for additional devices. The main browser issues a five-minute code that the requesting device enters. Enabling rotates router passwords away from public voucher codes and clears old remembered logins; current connected devices are retained as approved. Verify pre-login portal/API access and test on site before enabling.</p><label class="network-checkbox"><input type="checkbox" id="networkPairingTested"> I verified portal access before Wi-Fi login and will test pairing and device limits on site.</label><button type="button" id="networkPairingEnable">Enable assisted connections</button><button type="button" id="networkPairingDisable" class="secondary-action">Disable assisted connections</button><p>Disabling stops new requests and approvals. Devices already connected keep their current Wi-Fi sessions.</p></section>
    <div class="network-setup-grid">
    <form id="networkRouterConfig"><h3>2. Configure hotspot</h3>
      <label>Internet uplink<select name="wan" required><option value="">Discover router first</option></select></label>
      <label>Dedicated AP port<select name="apPort" required><option value="">Discover router first</option></select></label>
      <label>Gateway / prefix<input name="gateway" required value="10.20.0.1/22"></label>
      <label>DHCP range start<input name="poolStart" required value="10.20.0.20"></label>
      <label>DHCP range end<input name="poolEnd" required value="10.20.3.250"></label>
      <label>DNS servers<input name="dns" required value="1.1.1.1,8.8.8.8"></label>
      <label>Hotspot DNS name<input name="hotspotName" required value="connect.ndahi.local"></label>
      <button>Preview router changes</button>
    </form>
    <form id="networkWifiConfig"><h3>2. Configure Wi-Fi</h3>
      <p id="networkWifiSupport">Discover the controller to check supported actions.</p>
      <label>SSID<select name="ssidId"><option value="">Create a new SSID</option></select></label>
      <label>Wi-Fi name<input name="name" required maxlength="32" value="NDAHI Connect"></label>
      <label>Wireless security<select name="security"><option value="open">Open hotspot — voucher login</option><option value="wpa2">WPA2 personal plus voucher login</option></select></label>
      <label>Wi-Fi password<input name="password" type="password" autocomplete="new-password"></label>
      <label>VLAN ID (0 for untagged)<input name="vlan" type="number" min="0" max="4094" value="0"></label>
      <p>Client isolation is enabled. Tagged VLANs need matching gateway and switch configuration.</p>
      <button disabled>Preview Wi-Fi changes</button>
    </form></div>
    <form id="networkAdopt"><h3>Adopt an access point</h3><label>AP MAC address<select name="mac" required><option value="">Discover access points first</option></select></label><button disabled>Preview adoption</button></form>
    <p id="networkMessage" role="status" aria-live="polite"></p>
    <section id="networkPreview" hidden></section>
    <section><h3>Provisioning history</h3><button type="button" id="networkRefresh" class="secondary-action">Refresh jobs</button><div id="networkJobs"></div></section>
    <section id="networkRecovery" hidden></section>`;
  const $ = (s) => root.querySelector(s);
  const message = (text) => { $("#networkMessage").textContent = text; };
  async function busy(button, task) {
    try { await runButton(button, "Working…", task); }
    catch (error) { message(error.message || "Network request failed."); }
    finally {
      if (button.id === "networkActivate" && state) {
        button.disabled = isPending(button) || state.runtimeRouterEnabled || !state.enabled;
      }
      if (button.id === "networkPairingEnable" && state) button.disabled = isPending(button) || state.assistedConnectionsEnabled || !state.runtimeRouterEnabled;
      if (button.id === "networkPairingDisable" && state) button.disabled = isPending(button) || !state.assistedConnectionsEnabled;
    }
  }
  function renderPreview(job) {
    selectedJob = job;
    const plan = job.plan, target = $("#networkPreview");
    target.hidden = false;
    target.innerHTML = `<h3>3. Review ${h(job.kind)} changes</h3><p>${job.mode === "simulation" ? "SIMULATION — this will not configure physical equipment." : "These changes will be sent to your equipment."}</p>
      ${plan.conflicts.length ? `<h4>Resolve these conflicts</h4><ul>${plan.conflicts.map((v) => `<li>${h(v)}</li>`).join("")}</ul>` : ""}
      <ul>${(plan.warnings || []).map((v) => `<li>${h(v)}</li>`).join("")}</ul>
      ${plan.operations ? `<div class="network-table"><table><thead><tr><th>Action</th><th>Resource</th><th>Settings</th></tr></thead><tbody>${plan.operations.map((op) => `<tr><td>${h(op.action)}</td><td>${h(op.path)}</td><td><pre>${h(JSON.stringify(op.values, null, 2))}</pre></td></tr>`).join("")}</tbody></table></div>` : `<ul>${(plan.changes || []).map((v) => `<li>${h(v)}</li>`).join("")}</ul>`}
      <label class="network-checkbox"><input type="checkbox" id="networkReviewed"> I reviewed these changes and have a wired recovery connection.</label>
      <button type="button" id="networkApply" ${plan.conflicts.length || (job.mode === "live" && !state.enabled) ? "disabled" : ""}>${job.mode === "simulation" ? "Run simulation" : "Apply reviewed changes"}</button>`;
    $("#networkApply").onclick = () => busy($("#networkApply"), async () => {
      if (!$("#networkReviewed").checked) throw Error("Review and acknowledge the proposed changes first.");
      await request("apply", { jobId: selectedJob.id, reviewed: true });
      target.hidden = true; message("Provisioning job queued. Progress appears below."); await refresh();
    });
    target.scrollIntoView({ behavior: "smooth", block: "start" });
  }
  async function refresh() {
    state = await request("status");
    if (stopped) return;
    root.dataset.setupPending = String(state.jobs.some((j) => ["queued", "running", "awaiting_confirmation", "recovery_required"].includes(j.status)));
    $("#networkPrerequisites").textContent = !state.encryptionReady ? "Server setup required: configure NETWORK_CONFIG_KEY before saving connections." : `Live provisioning ${state.enabled ? "enabled" : "disabled"}. Approved management addresses: ${state.allowedOrigins.join(", ") || "none — configure NETWORK_ALLOWED_ORIGINS on the server"}.`;
    $("#networkEnforcementStatus").textContent = state.runtimeRouterEnabled ? "The saved router is active for voucher enforcement." : "Voucher operations currently use the existing server integration.";
    $("#networkActivate").disabled = isPending($("#networkActivate")) || state.runtimeRouterEnabled || !state.enabled;
    $("#networkPairingStatus").textContent = state.assistedConnectionsEnabled ? "Assisted connections are enabled for the saved router." : "New device approvals are paused. Previously enabled private access credentials stay enforced.";
    $("#networkPairingEnable").disabled = state.assistedConnectionsEnabled || !state.runtimeRouterEnabled;
    $("#networkPairingDisable").disabled = !state.assistedConnectionsEnabled;
    if (state.omadaStandalone) {
      for (const id of ["#networkOmadaConnection", "#networkWifiConfig", "#networkAdopt"]) $(id).querySelectorAll("input, select, button").forEach((control) => { control.disabled = true; });
      $("#networkOmadaNote").hidden = false;
      $("#networkOmadaNote").textContent = "Access points run standalone (OMADA_MODE=standalone), so no controller is connected.";
      $("#networkWifiSupport").textContent = "Configure the SSID, VLAN and client isolation on the access point itself.";
    }
    $("#networkJobs").innerHTML = state.jobs.length ? state.jobs.map((j) => `<article class="network-job"><h4>${h(j.kind)} · ${h(j.mode)} · ${h(j.status.replaceAll("_", " "))}</h4><p>${h(j.step || "Preview ready")}</p><small>${h(new Date(j.at).toLocaleString())} · ${h(j.id)}</small>
      ${j.confirmBefore && j.status === "awaiting_confirmation" ? `<p>Keep changes before ${h(new Date(j.confirmBefore).toLocaleTimeString())}; otherwise the router rolls back.</p><label class="network-checkbox"><input type="checkbox" data-tested="${h(j.id)}"> I tested Wi-Fi, voucher login, internet access, and management connectivity.</label><button data-job-action="confirm" data-id="${h(j.id)}">Keep changes</button>` : ""}
      ${["awaiting_confirmation", "recovery_required"].includes(j.status) ? `<button class="secondary-action" data-job-action="rollback" data-id="${h(j.id)}">Roll back</button><button class="secondary-action" data-job-action="refresh" data-id="${h(j.id)}">Check device status</button>` : ""}
      ${j.status === "recovery_required" ? `<label class="network-checkbox"><input type="checkbox" data-resolved="${h(j.id)}"> I completed and verified recovery directly on the equipment.</label><button class="secondary-action" data-job-action="resolve" data-id="${h(j.id)}">Record manual recovery</button>` : ""}
      ${["preview", "queued"].includes(j.status) ? `<button class="secondary-action" data-job-action="cancel" data-id="${h(j.id)}">Cancel job</button>` : ""}
      ${j.backup ? `<button class="secondary-action" data-job-action="recovery" data-id="${h(j.id)}">Backup recovery details</button>` : ""}</article>`).join("") : "<p>No provisioning jobs yet.</p>";
    root.querySelectorAll("[data-job-action]").forEach((button) => { button.onclick = () => busy(button, async () => {
      const action = button.dataset.jobAction, jobId = button.dataset.id;
      const result = await request(action, { jobId, tested: root.querySelector(`[data-tested="${CSS.escape(jobId)}"]`)?.checked === true, recovered: root.querySelector(`[data-resolved="${CSS.escape(jobId)}"]`)?.checked === true });
      if (action === "recovery") {
        const target = $("#networkRecovery"); target.hidden = false; target.setAttribute("data-sensitive-output", "");
        target.innerHTML = `<h3>Backup recovery</h3><p>${h(result.instructions)}</p><p>File: <code>${h(result.backup)}</code></p><label>Backup password<input readonly type="password" value="${h(result.password)}"></label><button type="button" id="networkShowBackup">Show password</button><button type="button" id="networkHideRecovery">Close recovery details</button>`;
        $("#networkShowBackup").onclick = () => { const field = target.querySelector("input"); field.type = field.type === "password" ? "text" : "password"; };
        $("#networkHideRecovery").onclick = () => { target.replaceChildren(); target.hidden = true; };
      } else { message(result.job.step); await refresh(); }
    }); });
    clearTimeout(timer);
    // Do not replace confirmation checkboxes while an owner is testing/reviewing.
    if (state.jobs.some((j) => ["queued", "running"].includes(j.status))) timer = setTimeout(() => refresh().catch((e) => message(e.message)), 2500);
  }
  for (const [kind, id] of [["router", "#networkRouterConnection"], ["omada", "#networkOmadaConnection"]]) {
    $(id).onsubmit = (e) => { e.preventDefault(); busy(e.target.querySelector("button:not([type]), button[type=submit]"), async () => {
      const data = Object.fromEntries(new FormData(e.target));
      await request("connection", { ...data, kind });
      e.target.querySelectorAll('input[type="password"]').forEach((v) => { v.value = ""; });
      message(`${kind} connection saved. Discover equipment to continue.`); await refresh();
    }); };
  }
  root.querySelectorAll("[data-discover]").forEach((button) => { button.onclick = () => busy(button, async () => {
    const kind = button.dataset.discover, result = await request("discover", { kind }), d = result.discovery;
    if (kind === "router") {
      $("#networkInventory").textContent = `${result.mode}: ${d.identity} — ${d.model}, RouterOS ${d.version}`;
      for (const field of ["wan", "apPort"]) $("#networkRouterConfig").elements[field].innerHTML = d.interfaces.map((v) => `<option value="${h(v.name)}">${h(v.name)}${v.running ? " (connected)" : ""}</option>`).join("");
      if (d.interfaces.length > 1) $("#networkRouterConfig").elements.apPort.selectedIndex = 1;
    } else {
      $("#networkWifiSupport").textContent = d.message;
      $("#networkWifiConfig button").disabled = !d.capabilities.configureSsid;
      $("#networkAdopt button").disabled = !d.capabilities.adopt;
      $("#networkWifiConfig").elements.ssidId.innerHTML = '<option value="">Create a new SSID</option>' + d.ssids.map((s) => `<option value="${h(s.id)}">${h(s.name)}</option>`).join("");
      $("#networkAdopt").elements.mac.innerHTML = d.accessPoints.map((ap) => `<option value="${h(ap.mac)}">${h(ap.name || ap.mac)} — ${h(ap.model)} (${h(ap.status)})</option>`).join("");
      $("#networkInventory").textContent = `${d.accessPoints.length} access points; ${d.ssids.length} SSIDs.`;
    }
    message("Discovery completed.");
  }); });
  for (const [id, kind, action] of [["#networkRouterConfig", "router", null], ["#networkWifiConfig", "omada", "ssid"], ["#networkAdopt", "omada", "adopt"]]) {
    $(id).onsubmit = (e) => { e.preventDefault(); busy(e.target.querySelector("button:not([type]), button[type=submit]"), async () => {
      const config = { ...Object.fromEntries(new FormData(e.target)), ...(action ? { action } : {}) };
      const result = await request("preview", { kind, config });
      e.target.querySelectorAll('input[type="password"]').forEach((v) => { v.value = ""; });
      renderPreview(result.job); message("Review the proposed changes before applying.");
    }); };
  }
  $("#networkActivate").onclick = () => busy($("#networkActivate"), async () => {
    await request("activate", { tested: $("#networkEnforcementTested").checked });
    message("Saved router activated. New voucher commands now use this connection."); await refresh();
  });
  $("#networkRefresh").onclick = () => busy($("#networkRefresh"), refresh);
  $("#networkPairingEnable").onclick = () => busy($("#networkPairingEnable"), async () => {
    await request("assisted-connections", { enabled: true, tested: $("#networkPairingTested").checked });
    message("Assisted connection pilot enabled. Test a new device before wider use."); await refresh();
  });
  $("#networkPairingDisable").onclick = () => busy($("#networkPairingDisable"), async () => {
    await request("assisted-connections", { enabled: false });
    message("New assisted connections disabled."); await refresh();
  });
  $("#networkPurchaseCheck").onclick = () => busy($("#networkPurchaseCheck"), async () => {
    const target = $("#networkPurchaseReport");
    target.setAttribute("aria-busy", "true");
    target.textContent = "Reading router configuration…";
    try {
      const { report } = await request("purchase-access");
      if (stopped) return;
      target.setAttribute("data-review-output", "");
      target.innerHTML = `<p>Checked ${h(new Date(report.checkedAt).toLocaleString())}. No router changes made.</p><ul>${report.findings.map((f) => `<li><strong>${h(f.status === "configured" ? "Found" : "Review")}: ${h(f.label)}</strong> — ${h(f.detail)}</li>`).join("")}</ul><p>${h(report.nextStep)}</p><button type="button" id="networkCopyPurchaseReport">Copy diagnostic report</button><button type="button" id="networkClosePurchaseReport" class="secondary-action">Close report</button><label>Diagnostic report<textarea id="networkPurchaseReportText" readonly rows="8"></textarea></label>`;
      $("#networkPurchaseReportText").value = JSON.stringify(report, null, 2);
      $("#networkClosePurchaseReport").onclick = () => { target.replaceChildren(); target.removeAttribute("data-review-output"); };
      $("#networkCopyPurchaseReport").onclick = () => busy($("#networkCopyPurchaseReport"), async () => {
        const text = $("#networkPurchaseReportText");
        try { await navigator.clipboard.writeText(text.value); message("Diagnostic report copied. You can share it with support."); }
        catch { text.focus(); text.select(); message(document.execCommand("copy") ? "Diagnostic report copied." : "Select and copy the diagnostic report below."); }
      });
    } catch (error) { target.removeAttribute("data-review-output"); target.textContent = error.message || "Purchase access check unavailable. Verify the saved live router connection."; }
    finally { target.removeAttribute("aria-busy"); }
  });
  try { await refresh(); } catch (e) { message(e.message); }
}
