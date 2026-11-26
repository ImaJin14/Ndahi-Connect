// Network setup (canvas: AdminNetworkSetup, #384; owner decisions 25 Nov).
// Four steps — Router, Access points, Wi-Fi, Review — each showing the drawn
// fields first; the other fields a setup needs sit in a closed "More … settings"
// inside the step (secrets are entered, never shown back). Nothing is applied
// before Review: "Next: access points" and "Preview Wi-Fi changes" make a
// preview, Review shows it as summary rows (one change set at a time), and
// "Apply reviewed changes" queues it. A live change still rolls back unless
// kept after testing. While the access points run standalone (production),
// their steps carry a note only. Voucher enforcement, assisted connections, the
// purchase-access check, the outage area names and the job history sit in a
// closed "More network tools" below.
import { escapeHtml as h } from "/shared/safe-html.js";
import { isPending, runButton } from "/shared/pending.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const STEPS = [["router", "adminSetupRouter"], ["aps", "adminSetupAps"], ["wifi", "adminSetupWifi"], ["review", "adminSetupReview"]];
const ACTIVE = new Set(["queued", "running", "awaiting_confirmation", "confirming", "rolling_back", "recovery_required"]);
// "50:C7:BF:••:••:21", as drawn.
export const maskMac = (mac) => String(mac || "").toUpperCase().split(/[:-]/).map((part, i, all) => (all.length === 6 && (i === 3 || i === 4) ? "••" : part)).join(":");

export function showSetupStep(root, name) {
  const at = STEPS.findIndex(([step]) => step === name);
  root.querySelectorAll("[data-setup-step]").forEach((button, i) => {
    if (i === at) button.setAttribute("aria-current", "step"); else button.removeAttribute("aria-current");
    // Steps before the current one read ✓, as drawn.
    button.classList.toggle("is-done", i < at);
    button.querySelector(".admin-steps__num").textContent = i < at ? "✓" : String(i + 1);
  });
  root.querySelectorAll("[data-setup-panel]").forEach((panel) => { panel.hidden = panel.dataset.setupPanel !== name; });
}

const field = (id, label, control) => `<div><label class="admin-setup__label" for="${id}">${h(label)}</label>${control}</div>`;
const input = (id, attrs) => `<input class="admin-setup__input" id="${id}" ${attrs}>`;
const select = (id, attrs, options) => `<select class="admin-setup__input" id="${id}" ${attrs}>${options}</select>`;

function markup() {
  return `<ol class="admin-steps" aria-label="${h(L("adminSetupSteps"))}">${STEPS.map(([step, label], i) => `<li><button type="button" class="admin-steps__step" data-setup-step="${step}"><span class="admin-steps__num" aria-hidden="true">${i + 1}</span>${h(L(label))}</button></li>`).join("")}</ol>
<section class="admin-setup__panel" aria-label="${h(L("adminNetStepDetails"))}">
  <form id="networkRouterConnection" hidden></form><form id="networkRouterConfig" hidden></form><form id="networkOmadaConnection" hidden></form><form id="networkWifiConfig" hidden></form>
  <div class="admin-setup__step" data-setup-panel="router">
    <h2 class="admin-setup__h2">${h(L("adminNetRouterTitle"))}</h2>
    <div class="admin-setup__grid">
      ${field("netRouterUrl", L("adminNetRouterAddress"), input("netRouterUrl", `name="url" form="networkRouterConnection" type="url" placeholder="https://router.management.example" autocomplete="off"`))}
      ${field("netRouterMode", L("adminNetConnectionMode"), select("netRouterMode", `name="mode" form="networkRouterConnection"`, `<option value="live">${h(L("adminNetModeLive"))}</option><option value="simulation">${h(L("adminNetModeSimulation"))}</option>`))}
      ${field("netWan", L("adminNetUplink"), select("netWan", `name="wan" form="networkRouterConfig" required`, `<option value="">${h(L("adminNetDiscoverFirst"))}</option>`))}
      ${field("netHotspot", L("adminNetHotspotName"), input("netHotspot", `name="hotspotName" form="networkRouterConfig" required value="connect.ndahi.local" autocomplete="off"`))}
    </div>
    <details class="admin-options admin-setup__more"><summary>${h(L("adminNetMoreRouter"))}</summary><div class="admin-setup__grid">
      ${field("netRouterUser", L("adminNetServiceUser"), input("netRouterUser", `name="username" form="networkRouterConnection" autocomplete="off"`))}
      ${field("netRouterPassword", L("adminNetServicePassword"), input("netRouterPassword", `name="password" form="networkRouterConnection" type="password" autocomplete="new-password" placeholder="${h(L("adminNetKeepPassword"))}"`))}
      ${field("netApPort", L("adminNetApPort"), select("netApPort", `name="apPort" form="networkRouterConfig" required`, `<option value="">${h(L("adminNetDiscoverFirst"))}</option>`))}
      ${field("netGateway", L("adminNetGateway"), input("netGateway", `name="gateway" form="networkRouterConfig" required value="10.20.0.1/22"`))}
      ${field("netPoolStart", L("adminNetPoolStart"), input("netPoolStart", `name="poolStart" form="networkRouterConfig" required value="10.20.0.20"`))}
      ${field("netPoolEnd", L("adminNetPoolEnd"), input("netPoolEnd", `name="poolEnd" form="networkRouterConfig" required value="10.20.3.250"`))}
      ${field("netDns", L("adminNetDns"), input("netDns", `name="dns" form="networkRouterConfig" required value="1.1.1.1,8.8.8.8"`))}
    </div><p class="nd-meta" id="networkInventory" aria-live="polite"></p></details>
    <div class="admin-setup__buttons"><button type="button" class="admin-setup__go2" data-discover="router">${h(L("adminNetDiscoverRouter"))}</button><button type="button" class="admin-setup__go" data-setup-next="router">${h(L("adminNetNextAps"))}</button></div>
  </div>
  <div class="admin-setup__step" data-setup-panel="aps" hidden>
    <h2 class="admin-setup__h2">${h(L("adminNetApsTitle"))}</h2>
    <p class="admin-setup__note" data-standalone>${h(L("adminNetApsStandalone"))}</p>
    <div id="networkApRows" data-controller></div>
    <details class="admin-options admin-setup__more" data-controller><summary>${h(L("adminNetMoreAps"))}</summary><div class="admin-setup__grid">
      ${field("netOmadaUrl", L("adminNetControllerAddress"), input("netOmadaUrl", `name="url" form="networkOmadaConnection" type="url" placeholder="https://controller.management.example:8043" autocomplete="off"`))}
      ${field("netOmadaController", L("adminNetControllerId"), input("netOmadaController", `name="controllerId" form="networkOmadaConnection"`))}
      ${field("netOmadaSite", L("adminNetSiteId"), input("netOmadaSite", `name="siteId" form="networkOmadaConnection"`))}
      ${field("netOmadaWlan", L("adminNetWlanId"), input("netOmadaWlan", `name="wlanId" form="networkOmadaConnection"`))}
      ${field("netOmadaClient", L("adminNetClientId"), input("netOmadaClient", `name="clientId" form="networkOmadaConnection" autocomplete="off"`))}
      ${field("netOmadaSecret", L("adminNetClientSecret"), input("netOmadaSecret", `name="clientSecret" form="networkOmadaConnection" type="password" autocomplete="new-password" placeholder="${h(L("adminNetKeepSecret"))}"`))}
    </div></details>
    <div class="admin-setup__buttons"><button type="button" class="admin-setup__go2" data-discover="omada" data-controller>${h(L("adminNetDiscoverAps"))}</button><button type="button" class="admin-setup__go" data-setup-next="aps">${h(L("adminNetNextWifi"))}</button></div>
  </div>
  <div class="admin-setup__step" data-setup-panel="wifi" hidden>
    <h2 class="admin-setup__h2">${h(L("adminNetWifiTitle"))}</h2>
    <p class="admin-setup__note" data-standalone>${h(L("adminNetWifiStandalone"))}</p>
    <div class="admin-setup__grid" data-controller>
      ${field("netSsid", L("adminNetSsid"), input("netSsid", `name="name" form="networkWifiConfig" required maxlength="32" value="NDAHI Connect"`))}
      ${field("netVlan", L("adminNetVlan"), input("netVlan", `name="vlan" form="networkWifiConfig" type="number" min="0" max="4094" value="0"`))}
      ${field("netIsolation", L("adminNetIsolation"), select("netIsolation", "", `<option>${h(L("adminNetIsolationOn"))}</option>`))}
    </div>
    <details class="admin-options admin-setup__more" data-controller><summary>${h(L("adminNetMoreWifi"))}</summary><div class="admin-setup__grid">
      ${field("netSsidId", L("adminNetSsidChoice"), select("netSsidId", `name="ssidId" form="networkWifiConfig"`, `<option value="">${h(L("adminNetSsidNew"))}</option>`))}
      ${field("netSecurity", L("adminNetSecurity"), select("netSecurity", `name="security" form="networkWifiConfig"`, `<option value="open">${h(L("adminNetSecurityOpen"))}</option><option value="wpa2">${h(L("adminNetSecurityWpa2"))}</option>`))}
      ${field("netWifiPassword", L("adminNetWifiPassword"), input("netWifiPassword", `name="password" form="networkWifiConfig" type="password" autocomplete="new-password"`))}
    </div><p class="nd-meta" id="networkWifiSupport">${h(L("adminNetWifiDiscover"))}</p></details>
    <div class="admin-setup__buttons"><button type="button" class="admin-setup__go" data-controller data-wifi-preview disabled>${h(L("adminNetPreviewWifi"))}</button><button type="button" class="admin-setup__go" data-standalone data-setup-next="wifi">${h(L("adminNetNextReview"))}</button></div>
  </div>
  <div class="admin-setup__step" data-setup-panel="review" hidden>
    <h2 class="admin-setup__h2">${h(L("adminNetReviewTitle"))}</h2>
    <p class="admin-setup__note admin-setup__empty">${h(L("adminSetupReviewEmpty"))}</p>
    <div id="networkPreview" class="admin-setup__review" hidden></div>
    <div id="networkApplied" class="admin-setup__review"></div>
    <div class="admin-setup__buttons" id="networkReviewButtons" hidden><button type="button" class="admin-setup__go2" id="networkSimulate">${h(L("adminNetRunSimulation"))}</button><button type="button" class="admin-setup__go" id="networkApply">${h(L("adminNetApply"))}</button></div>
    <p class="nd-meta" id="networkApplyNote" hidden></p>
  </div>
  <p class="admin-setup__message" id="networkMessage" role="status" aria-live="polite"></p>
</section>
<details class="admin-options admin-legacy admin-setup__tools" id="networkTools"><summary>${h(L("adminNetTools"))}</summary><div class="admin-setup__tools-body">
  <section><p>${h(L("adminNetIntro"))}</p><p id="networkPrerequisites" role="status">${h(L("adminNetChecking"))}</p></section>
  <section><h3>${h(L("adminNetPurchaseTitle"))}</h3><p>${h(L("adminNetPurchaseText"))}</p><button type="button" id="networkPurchaseCheck">${h(L("adminNetPurchaseCheck"))}</button><div id="networkPurchaseReport" aria-live="polite"></div></section>
  <section><h3>${h(L("adminNetEnforcementTitle"))}</h3><p id="networkEnforcementStatus"></p><p>${h(L("adminNetEnforcementText"))}</p><label class="network-checkbox"><input type="checkbox" id="networkEnforcementTested"> ${h(L("adminNetEnforcementTested"))}</label><button type="button" id="networkActivate" disabled>${h(L("adminNetActivate"))}</button></section>
  <section><h3>${h(L("adminNetPairingTitle"))}</h3><p id="networkPairingStatus"></p><p>${h(L("adminNetPairingText"))}</p><label class="network-checkbox"><input type="checkbox" id="networkPairingTested"> ${h(L("adminNetPairingTested"))}</label><button type="button" id="networkPairingEnable">${h(L("adminNetPairingEnable"))}</button><button type="button" id="networkPairingDisable" class="secondary-action">${h(L("adminNetPairingDisable"))}</button><p>${h(L("adminNetPairingNote"))}</p></section>
  <section><h3>${h(L("adminNetAreasTitle"))}</h3><p>${h(L("adminNetAreasText"))}</p><form id="networkAreas" class="admin-setup__areas"><label>${h(L("adminNetAreasSite"))}<input name="site" maxlength="40" autocomplete="off"></label><label>${h(L("adminNetAreasList"))}<textarea name="areas" rows="4"></textarea></label><button type="submit">${h(L("adminNetAreasSave"))}</button></form></section>
  <section><h3>${h(L("adminNetHotspotTitle"))}</h3><p>${h(L("adminNetHotspotText"))}</p><form id="networkHotspotName" class="admin-setup__areas"><label>${h(L("adminNetHotspotEn"))}<input name="en" maxlength="40" autocomplete="off"></label><label>${h(L("adminNetHotspotFr"))}<input name="fr" maxlength="40" autocomplete="off"></label><button type="submit">${h(L("adminNetHotspotSave"))}</button></form></section>
  <section><h3>${h(L("adminNetHistory"))}</h3><button type="button" id="networkRefresh" class="secondary-action">${h(L("adminNetRefreshJobs"))}</button><div id="networkJobs"></div></section>
  <section id="networkRecovery" hidden></section>
</div></details>`;
}

let stopPrevious = () => {};
export async function mountNetworkSetup(root, call) {
  stopPrevious();
  if (!root) return;
  let stopped = false, timer, state, reviewed = null;
  stopPrevious = () => { stopped = true; clearTimeout(timer); };
  const request = (action, data = {}) => call(`/api/admin/network/setup/${action}`, action === "status" ? {} : { method: "POST", body: JSON.stringify(data) });
  root.innerHTML = markup();
  const $ = (s) => root.querySelector(s);
  root.querySelectorAll("[data-setup-step]").forEach((button) => { button.onclick = () => showSetupStep(root, button.dataset.setupStep); });
  showSetupStep(root, "router");
  const message = (text) => { $("#networkMessage").textContent = text || ""; };
  async function busy(button, task) {
    try { await runButton(button, L("adminNetWorking"), task); }
    catch (error) { message(error.message || L("adminNetFailed")); }
    finally {
      if (button.id === "networkActivate" && state) button.disabled = isPending(button) || state.runtimeRouterEnabled || !state.enabled;
      if (button.id === "networkPairingEnable" && state) button.disabled = isPending(button) || state.assistedConnectionsEnabled || !state.runtimeRouterEnabled;
      if (button.id === "networkPairingDisable" && state) button.disabled = isPending(button) || !state.assistedConnectionsEnabled;
    }
  }

  // Review: the latest preview as the drawn summary rows (one change set at a time).
  function rows(job) {
    const c = job.plan?.config || {}, row = (label, value) => `<div class="admin-setup__row"><span>${h(label)}</span><span>${h(value)}</span></div>`;
    if (job.kind === "router" && job.planKind === "sharing") return row(L("adminNetSharingRules"), L("adminNetSharingRulesValue"));
    if (job.kind === "router") return [
      row(L("adminNetHotspotName"), c.hotspotName), row(L("adminNetUplink"), c.wan), row(L("adminNetApPort"), c.apPort),
      row(L("adminNetHotspotNetwork"), c.network || c.gateway), row(L("adminNetPool"), `${c.poolStart} – ${c.poolEnd}`), row(L("adminNetDns"), c.dns),
    ].join("");
    if (c.action === "adopt") return row(L("adminNetAdoptRow"), maskMac(c.mac));
    return row(L("adminNetSsidRow", { name: c.name, vlan: c.vlan || 0 }), L("adminNetIsolationRow"));
  }
  function renderReview(job) {
    reviewed = job;
    const target = $("#networkPreview"), conflicts = job.plan?.conflicts || [];
    target.hidden = false;
    target.innerHTML = `${rows(job)}${conflicts.length ? `<div class="admin-setup__conflicts" role="alert"><strong>${h(L("adminNetConflicts"))}</strong><ul>${conflicts.map((v) => `<li>${h(v)}</li>`).join("")}</ul></div>` : ""}
      <details class="admin-setup__every"><summary>${h(L("adminNetEveryChange"))}</summary>${job.plan?.operations ? `<div class="network-table"><table><thead><tr><th>${h(L("adminNetColAction"))}</th><th>${h(L("adminNetColResource"))}</th><th>${h(L("adminNetColSettings"))}</th></tr></thead><tbody>${job.plan.operations.map((op) => `<tr><td>${h(op.action)}</td><td>${h(op.path)}</td><td><pre>${h(JSON.stringify(op.values, null, 2))}</pre></td></tr>`).join("")}</tbody></table></div>` : `<ul>${(job.plan?.changes || []).map((v) => `<li>${h(v)}</li>`).join("")}</ul>`}<ul>${(job.plan?.warnings || []).map((v) => `<li>${h(v)}</li>`).join("")}</ul></details>`;
    renderButtons();
  }
  // Apply is the confirmation (no checkbox, owner 25 Nov). "Run simulation" only
  // where simulation is allowed (never production); each acts on its own kind of preview.
  function renderButtons() {
    const job = reviewed && reviewed.status === "preview" ? reviewed : null, buttons = $("#networkReviewButtons"), note = $("#networkApplyNote");
    $(".admin-setup__empty").hidden = Boolean(job || $("#networkApplied").innerHTML);
    buttons.hidden = !job;
    $("#networkPreview").hidden = !job;
    if (!job) { note.hidden = true; return; }
    const blocked = (job.plan?.conflicts || []).length > 0, simulation = job.mode === "simulation";
    $("#networkSimulate").hidden = !state?.simulationAllowed;
    $("#networkSimulate").disabled = blocked || !simulation || isPending($("#networkSimulate"));
    $("#networkApply").disabled = blocked || simulation || !state?.enabled || isPending($("#networkApply"));
    const why = blocked ? L("adminNetBlockedConflicts") : simulation ? L("adminNetBlockedSimulation") : !state?.enabled ? L("adminNetBlockedDisabled") : "";
    note.textContent = why; note.hidden = !why;
  }
  // After Apply: progress, then "Applied. A backup of the previous settings was
  // saved." with Keep changes / Roll back for a live change (it rolls back otherwise).
  function renderApplied() {
    const job = (state?.jobs || []).find((j) => ACTIVE.has(j.status)) || (reviewed && (state?.jobs || []).find((j) => j.id === reviewed.id && j.status === "completed"));
    const target = $("#networkApplied");
    if (!job) { target.innerHTML = ""; renderButtons(); return; }
    const applied = ["awaiting_confirmation", "completed"].includes(job.status) && job.backup;
    target.innerHTML = `${applied ? `<p class="admin-setup__applied" role="status">${h(L("adminNetApplied"))}</p>` : `<p class="admin-setup__progress" role="status">${h(L("adminNetProgress", { step: job.step || job.status.replaceAll("_", " ") }))}</p>`}
      ${job.status === "awaiting_confirmation" && job.confirmBefore ? `<p>${h(L("adminNetKeepBefore", { time: new Date(job.confirmBefore).toLocaleTimeString(currentLanguage() === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Douala" }) }))}</p><label class="network-checkbox"><input type="checkbox" data-tested="${h(job.id)}"> ${h(L("adminNetTestedKeep"))}</label><div class="admin-setup__buttons"><button type="button" class="admin-setup__go" data-job-action="confirm" data-id="${h(job.id)}">${h(L("adminNetKeep"))}</button><button type="button" class="admin-setup__go2" data-job-action="rollback" data-id="${h(job.id)}">${h(L("adminNetRollback"))}</button></div>` : ""}
      ${job.status === "recovery_required" ? `<div class="admin-setup__buttons"><button type="button" class="admin-setup__go2" data-job-action="rollback" data-id="${h(job.id)}">${h(L("adminNetRollback"))}</button><button type="button" class="admin-setup__go2" data-job-action="refresh" data-id="${h(job.id)}">${h(L("adminNetCheckDevice"))}</button></div><label class="network-checkbox"><input type="checkbox" data-resolved="${h(job.id)}"> ${h(L("adminNetRecovered"))}</label><button type="button" class="secondary-action" data-job-action="resolve" data-id="${h(job.id)}">${h(L("adminNetRecordRecovery"))}</button>` : ""}`;
    bindJobActions(target);
    renderButtons();
  }
  function bindJobActions(scope) {
    scope.querySelectorAll("[data-job-action]").forEach((button) => { button.onclick = () => busy(button, async () => {
      const action = button.dataset.jobAction, jobId = button.dataset.id;
      const result = await request(action, { jobId, tested: root.querySelector(`[data-tested="${CSS.escape(jobId)}"]`)?.checked === true, recovered: root.querySelector(`[data-resolved="${CSS.escape(jobId)}"]`)?.checked === true });
      if (action === "recovery") {
        const target = $("#networkRecovery"); target.hidden = false; target.setAttribute("data-sensitive-output", "");
        target.innerHTML = `<h3>${h(L("adminNetBackupRecovery"))}</h3><p>${h(result.instructions)}</p><p>${h(L("adminNetBackupFile"))} <code>${h(result.backup)}</code></p><label>${h(L("adminNetBackupPassword"))}<input readonly type="password" value="${h(result.password)}"></label><button type="button" id="networkShowBackup">${h(L("adminNetShowPassword"))}</button><button type="button" id="networkHideRecovery">${h(L("adminNetCloseRecovery"))}</button>`;
        $("#networkShowBackup").onclick = () => { const f = target.querySelector("input"); f.type = f.type === "password" ? "text" : "password"; };
        $("#networkHideRecovery").onclick = () => { target.replaceChildren(); target.hidden = true; };
      } else { message(result.job.step); await refresh(); }
    }); });
  }

  async function refresh() {
    state = await request("status");
    if (stopped) return;
    root.dataset.setupPending = String(state.jobs.some((j) => ["queued", "running", "awaiting_confirmation", "recovery_required"].includes(j.status)));
    root.dataset.standalone = String(Boolean(state.omadaStandalone));
    root.querySelectorAll("[data-standalone]").forEach((el) => { el.hidden = !state.omadaStandalone; });
    root.querySelectorAll("[data-controller]").forEach((el) => { el.hidden = Boolean(state.omadaStandalone); });
    if (!state.simulationAllowed) $('#netRouterMode option[value="simulation"]')?.remove();
    const router = (state.connections || []).find((c) => c.kind === "router");
    if (router && document.activeElement?.form?.id !== "networkRouterConnection") {
      if (!$("#netRouterUrl").value && router.url !== "simulation") $("#netRouterUrl").value = router.url;
      if ($(`#netRouterMode option[value="${router.mode}"]`)) $("#netRouterMode").value = router.mode;
    }
    $("#networkPrerequisites").textContent = !state.encryptionReady ? L("adminNetNeedsKey") : L(state.enabled ? "adminNetLiveOn" : "adminNetLiveOff", { origins: state.allowedOrigins.join(", ") || L("adminNetNoOrigins") });
    $("#networkEnforcementStatus").textContent = L(state.runtimeRouterEnabled ? "adminNetEnforcementOn" : "adminNetEnforcementOff");
    $("#networkActivate").disabled = isPending($("#networkActivate")) || state.runtimeRouterEnabled || !state.enabled;
    $("#networkPairingStatus").textContent = L(state.assistedConnectionsEnabled ? "adminNetPairingOn" : state.deviceApprovalRequired ? "adminNetPairingPaused" : "adminNetPairingOff");
    $("#networkPairingEnable").disabled = state.assistedConnectionsEnabled || !state.runtimeRouterEnabled;
    $("#networkPairingDisable").disabled = !state.assistedConnectionsEnabled;
    // The latest unapplied preview stays in Review after a reload.
    const latest = state.jobs.find((j) => j.status === "preview" && Date.parse(j.expiresAt) > Date.now());
    if (latest && (!reviewed || reviewed.status !== "preview" || reviewed.id !== latest.id)) renderReview(latest);
    else if (reviewed) { const now = state.jobs.find((j) => j.id === reviewed.id); if (now) reviewed = now; }
    renderApplied();
    const current = state.jobs.find((j) => ACTIVE.has(j.status));
    $("#networkJobs").innerHTML = state.jobs.length ? state.jobs.map((j) => `<article class="network-job"><h4>${h(j.kind)} · ${h(j.mode)} · ${h(j.status.replaceAll("_", " "))}</h4><p>${h(j.step || L("adminNetPreviewReady"))}</p><small>${h(new Date(j.at).toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-GB"))} · ${h(j.id)}</small>
      ${["preview", "queued"].includes(j.status) && j !== current ? `<button type="button" class="secondary-action" data-job-action="cancel" data-id="${h(j.id)}">${h(L("adminNetCancelJob"))}</button>` : ""}
      ${j.backup ? `<button type="button" class="secondary-action" data-job-action="recovery" data-id="${h(j.id)}">${h(L("adminNetBackupDetails"))}</button>` : ""}</article>`).join("") : `<p>${h(L("adminNetNoJobs"))}</p>`;
    bindJobActions($("#networkJobs"));
    clearTimeout(timer);
    // Never replace the confirmation checkbox while the owner is testing.
    if (state.jobs.some((j) => ["queued", "running", "confirming", "rolling_back"].includes(j.status))) timer = setTimeout(() => refresh().catch((e) => message(e.message)), 2500);
  }

  async function preview(kind, config, next) {
    const result = await request("preview", { kind, config });
    root.querySelectorAll('input[type="password"][form="networkWifiConfig"]').forEach((v) => { v.value = ""; });
    renderReview(result.job);
    showSetupStep(root, next);
    message(L("adminNetPreviewed"));
  }
  const formData = (id) => Object.fromEntries(new FormData($(id)));

  // Discover: saves a new or changed connection first, then reads the equipment.
  root.querySelectorAll("[data-discover]").forEach((button) => { button.onclick = () => busy(button, async () => {
    const kind = button.dataset.discover, form = kind === "router" ? "#networkRouterConnection" : "#networkOmadaConnection", data = formData(form);
    const saved = (state?.connections || []).find((c) => c.kind === kind);
    const changed = !saved || (data.mode || "live") !== saved.mode || ((data.mode || "live") === "live" && data.url && data.url !== saved.url) || Object.entries(data).some(([k, v]) => !["url", "mode"].includes(k) && v);
    if (changed) {
      await request("connection", { ...data, kind });
      root.querySelectorAll(`input[type="password"][form="${form.slice(1)}"]`).forEach((v) => { v.value = ""; });
      await refresh();
    }
    const result = await request("discover", { kind }), d = result.discovery;
    if (kind === "router") {
      $("#networkInventory").textContent = L("adminNetInventory", { mode: result.mode, identity: d.identity, model: d.model, version: d.version });
      const options = d.interfaces.map((v) => `<option value="${h(v.name)}">${h(v.name)}${v.running ? h(L("adminNetConnected")) : ""}</option>`).join("");
      $("#netWan").innerHTML = options; $("#netApPort").innerHTML = options;
      if (d.interfaces.length > 1) $("#netApPort").selectedIndex = 1;
    } else {
      $("#networkWifiSupport").textContent = d.message;
      root.querySelector("[data-wifi-preview]").disabled = !d.capabilities.configureSsid;
      $("#netSsidId").innerHTML = `<option value="">${h(L("adminNetSsidNew"))}</option>` + d.ssids.map((s) => `<option value="${h(s.id)}">${h(s.name)}</option>`).join("");
      $("#networkApRows").innerHTML = d.accessPoints.map((ap) => `<div class="admin-setup__row"><span><strong>${h(ap.name || L("adminNetNewDevice"))}</strong> · ${h(ap.model || maskMac(ap.mac))}</span>${/adopted|connected/i.test(String(ap.status)) ? `<span class="admin-setup__ok">${h(L("adminNetAdopted"))}</span>` : `<button type="button" class="admin-setup__go2 admin-setup__adopt" data-adopt-mac="${h(ap.mac)}" ${d.capabilities.adopt ? "" : "disabled"}>${h(L("adminNetAdopt"))}</button>`}</div>`).join("");
      root.querySelectorAll("[data-adopt-mac]").forEach((adopt) => { adopt.onclick = () => busy(adopt, () => preview("omada", { action: "adopt", mac: adopt.dataset.adoptMac }, "review")); });
    }
    message(L("adminNetDiscovered"));
  }); });
  // "Next: access points" previews the router changes; the other Next buttons move on.
  root.querySelector('[data-setup-next="router"]').onclick = (event) => busy(event.currentTarget, () => preview("router", formData("#networkRouterConfig"), "aps"));
  root.querySelector('[data-setup-next="aps"]').onclick = () => showSetupStep(root, "wifi");
  root.querySelector('[data-setup-next="wifi"]').onclick = () => showSetupStep(root, "review");
  root.querySelector("[data-wifi-preview]").onclick = (event) => busy(event.currentTarget, () => preview("omada", { ...formData("#networkWifiConfig"), action: "ssid" }, "review"));
  const apply = (button) => busy(button, async () => {
    await request("apply", { jobId: reviewed.id, reviewed: true });
    message(L("adminNetQueued")); await refresh();
  });
  $("#networkApply").onclick = () => apply($("#networkApply"));
  $("#networkSimulate").onclick = () => apply($("#networkSimulate"));

  $("#networkActivate").onclick = () => busy($("#networkActivate"), async () => {
    await request("activate", { tested: $("#networkEnforcementTested").checked });
    message(L("adminNetActivated")); await refresh();
  });
  $("#networkRefresh").onclick = () => busy($("#networkRefresh"), refresh);
  $("#networkPairingEnable").onclick = () => busy($("#networkPairingEnable"), async () => {
    await request("assisted-connections", { enabled: true, tested: $("#networkPairingTested").checked });
    message(L("adminNetPairingEnabled")); await refresh();
  });
  $("#networkPairingDisable").onclick = () => busy($("#networkPairingDisable"), async () => {
    await request("assisted-connections", { enabled: false });
    message(L("adminNetPairingDisabled")); await refresh();
  });
  // Outage area names (#385): the outage form offers "All sites · <site>", then "<area> only".
  const areas = $("#networkAreas");
  call("/api/admin/outages").then((data) => {
    if (stopped || !data.areas) return;
    areas.elements.site.value = data.areas.site || "";
    areas.elements.areas.value = (data.areas.areas || []).join("\n");
  }).catch(() => {});
  areas.onsubmit = (event) => { event.preventDefault(); busy(areas.querySelector("button"), async () => {
    const result = await call("/api/admin/outages/areas", { method: "POST", body: JSON.stringify({ site: areas.elements.site.value, areas: areas.elements.areas.value.split("\n") }) });
    areas.elements.areas.value = result.areas.areas.join("\n");
    message(L("adminNetAreasSaved"));
  }); };
  // The hotspot's name on the Wi-Fi page (#404), read from the public status.
  const hotspot = $("#networkHotspotName");
  call("/api/status").then((status) => {
    if (stopped || !status?.hotspotName) return;
    hotspot.elements.en.value = status.hotspotName.en || "";
    hotspot.elements.fr.value = status.hotspotName.fr || "";
  }).catch(() => {});
  hotspot.onsubmit = (event) => { event.preventDefault(); busy(hotspot.querySelector("button"), async () => {
    await call("/api/admin/network/hotspot-name", { method: "POST", body: JSON.stringify({ name: { en: hotspot.elements.en.value, fr: hotspot.elements.fr.value } }) });
    message(L("adminNetHotspotSaved"));
  }); };
  $("#networkPurchaseCheck").onclick = () => busy($("#networkPurchaseCheck"), async () => {
    const target = $("#networkPurchaseReport");
    target.setAttribute("aria-busy", "true");
    target.textContent = L("adminNetReadingRouter");
    try {
      const { report } = await request("purchase-access");
      if (stopped) return;
      target.setAttribute("data-review-output", "");
      target.innerHTML = `<p>${h(L("adminNetPurchaseChecked", { at: new Date(report.checkedAt).toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-GB") }))}</p><ul>${report.findings.map((f) => `<li><strong>${h(L(f.status === "configured" ? "adminNetFound" : "adminNetReviewWord"))}: ${h(f.label)}</strong> — ${h(f.detail)}</li>`).join("")}</ul><p>${h(report.nextStep)}</p><button type="button" id="networkCopyPurchaseReport">${h(L("adminNetCopyReport"))}</button><button type="button" id="networkClosePurchaseReport" class="secondary-action">${h(L("adminNetCloseReport"))}</button><label>${h(L("adminNetReport"))}<textarea id="networkPurchaseReportText" readonly rows="8"></textarea></label>`;
      $("#networkPurchaseReportText").value = JSON.stringify(report, null, 2);
      $("#networkClosePurchaseReport").onclick = () => { target.replaceChildren(); target.removeAttribute("data-review-output"); };
      $("#networkCopyPurchaseReport").onclick = () => busy($("#networkCopyPurchaseReport"), async () => {
        const text = $("#networkPurchaseReportText");
        try { await navigator.clipboard.writeText(text.value); message(L("adminNetReportCopied")); }
        catch { text.focus(); text.select(); message(document.execCommand("copy") ? L("adminNetReportCopiedShort") : L("adminNetReportSelect")); }
      });
    } catch (error) { target.removeAttribute("data-review-output"); target.textContent = error.message || L("adminNetPurchaseUnavailable"); }
    finally { target.removeAttribute("aria-busy"); }
  });
  try { await refresh(); } catch (e) { message(e.message); }
}
