import { escapeHtml as h } from "/shared/safe-html.js";
import { loadPasskeys } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { credentialRequest, mountVerifiedForm, passkeysAvailable, proofFields, proofButtons, securityError } from "./security-actions.js";
import { pinControls, recoveryControls, mountAccountRecovery } from "./account-recovery.js";

export function accountSecurityCard(customer, security, setup = false) {
  const passkeys = security.passkeys || [];
  return `<section class="surface account-security" id="accountSecurity" aria-labelledby="accountSecurityTitle">
    ${setup ? '<p class="success" role="status">Security setup complete.</p>' : ""}
    <p class="eyebrow">Security</p><h2 id="accountSecurityTitle">PIN &amp; passkeys</h2>
    <p>One place to manage sign-in and recover account access.</p>
    <p class="security-summary">PIN: ${customer.pinConfigured !== false ? "set" : "not set"} · ${h(passkeys.length)} passkey${passkeys.length === 1 ? "" : "s"} saved</p>
    <details id="securityManager"><summary>Manage PIN / Passkey</summary>
      <div class="security-manager-body">
        <div class="security-nav" role="group" aria-label="Security settings">
          <button type="button" class="secondary-action" data-security-panel="pin" aria-controls="security-pin" aria-pressed="true">PIN</button>
          <button type="button" class="secondary-action" data-security-panel="passkeys" aria-controls="security-passkeys" aria-pressed="false">Passkeys</button>
          <button type="button" class="secondary-action" data-security-panel="recovery" aria-controls="security-recovery" aria-pressed="false">Recovery</button>
        </div>
        <p id="securityMessage" role="status" aria-live="polite" tabindex="-1"></p>
        <p class="account-hint" data-passkey-unavailable hidden>Passkeys are unavailable in this browser. Use your PIN, open the secure portal in your browser, or use Recovery.</p>
        <section id="security-pin" data-security-content="pin" aria-label="Manage PIN">${pinControls(customer)}</section>
        <section id="security-passkeys" data-security-content="passkeys" aria-label="Manage passkeys" hidden><h3>Passkeys</h3><p>Use your device lock, fingerprint or security key. Adding or removing a passkey requires your current PIN or a fresh passkey check.</p><button type="button" id="addCustomerPasskey">Add a passkey</button>
          <div class="account-passkeys">${passkeys.length ? passkeys.map(key => `<div class="device"><div><b>${h(key.label)}</b><br><small>Added ${h(new Date(key.createdAt).toLocaleDateString())}</small></div><div class="device-actions"><details class="rename-passkey"><summary>Rename</summary><form data-rename-passkey="${h(key.id)}"><label>New name<input name="label" value="${h(key.label)}" maxlength="60" required></label><button>Save name</button></form></details><button type="button" class="danger-action" data-remove-passkey="${h(key.id)}">Remove</button></div></div>`).join("") : `<p class="account-hint">${customer.pinConfigured !== false ? "No passkeys saved yet. Your PIN remains available." : "Use Recovery if you have no working sign-in method."}</p>`}</div>
          <div id="securityOwnerProof"></div>
        </section>
        <section id="security-recovery" data-security-content="recovery" aria-label="Account recovery" hidden>${recoveryControls(customer)}</section>
        <button type="button" class="secondary-action" data-close-security>Close security</button>
      </div>
    </details>
  </section>`;
}

export function securityViewState() {
  const manager = document.getElementById("securityManager");
  return manager?.open ? { panel: document.querySelector('[data-security-panel][aria-pressed="true"]')?.dataset.securityPanel || "pin" } : null;
}
export function openSecurityManager({ panel = "pin", message = "", focus = true } = {}) {
  const root = document.getElementById("accountSecurity"), manager = root?.querySelector("#securityManager");
  if (!manager) return;
  manager.open = true;
  root.querySelector(`[data-security-panel="${panel}"]`)?.click();
  const status = root.querySelector("#securityMessage"); status.textContent = message;
  if (focus) (message ? status : root.querySelector(`[data-security-panel="${panel}"]`)).focus();
}

export function mountAccountSecurity({ call, customer, onChanged, restore, setup = false }) {
  const root = document.getElementById("accountSecurity"), manager = root.querySelector("#securityManager"),
    proofHost = root.querySelector("#securityOwnerProof"), status = root.querySelector("#securityMessage");
  function clearSecrets() {
    root.dispatchEvent(new Event("security-clear"));
    root.querySelectorAll("form").forEach(form => { form.reset(); form.removeAttribute("data-sensitive-output"); });
    root.querySelectorAll("[data-proof-message]").forEach(node => { node.textContent = ""; });
    proofHost.textContent = "";
  }
  const close = () => { if (root.hasAttribute("aria-busy")) return; clearSecrets(); status.textContent = ""; manager.open = false; manager.querySelector("summary").focus(); };
  manager.querySelector("summary").onclick = event => { if (root.hasAttribute("aria-busy")) event.preventDefault(); };
  manager.ontoggle = () => { if (!manager.open) clearSecrets(); };
  root.onkeydown = event => { if (event.key === "Escape" && manager.open && !root.hasAttribute("aria-busy")) { event.preventDefault(); event.stopPropagation(); close(); } };
  for (const button of root.querySelectorAll("[data-security-panel]")) button.onclick = () => {
    if (root.hasAttribute("aria-busy")) return;
    clearSecrets(); status.textContent = "";
    root.querySelectorAll("[data-security-panel]").forEach(node => node.setAttribute("aria-pressed", String(node === button)));
    root.querySelectorAll("[data-security-content]").forEach(node => { node.hidden = node.dataset.securityContent !== button.dataset.securityPanel; });
  };
  root.querySelector("[data-close-security]").onclick = close;
  root.querySelectorAll("[data-cancel-security]").forEach(button => { button.onclick = close; });
  if (!passkeysAvailable()) { root.querySelector("[data-passkey-unavailable]").hidden = false; root.querySelector("#addCustomerPasskey").hidden = true; }
  mountAccountRecovery({ root, call, customer, onChanged });

  function ownerProof(purpose, opener, passkeyId) {
    if (root.hasAttribute("aria-busy")) return;
    proofHost.innerHTML = `<section class="security-verification" data-passkey-owner-proof data-sensitive-output><h4 tabindex="-1">${purpose === "passkey_add" ? "Verify before adding a passkey" : "Verify before removing this passkey"}</h4><p>${purpose === "passkey_add" ? "Confirm account ownership with your current PIN or a passkey." : "This passkey will no longer sign in. Keep a verified PIN or another working passkey."}</p><form method="post">${proofFields(customer, "pin")}<div class="security-actions">${proofButtons(customer, "Confirm")}<button type="button" class="secondary-action" data-cancel-proof>Cancel</button></div><div data-proof-message role="status" aria-live="polite"></div></form><p><a href="/forgot-pin">No working credential? Recover account access</a></p></section>`;
    const host = proofHost.firstElementChild;
    host.querySelector("h4").focus(); host.scrollIntoView({ block: "nearest" });
    host.querySelector("[data-cancel-proof]").onclick = () => { if (!root.hasAttribute("aria-busy")) { proofHost.textContent = ""; opener.focus(); } };
    mountVerifiedForm({ root, form: host.querySelector("form"), customer, call,
      options: () => call("/api/account/passkeys/proof/options", { method: "POST", body: JSON.stringify({ purpose, ...(passkeyId ? { passkeyId } : {}) }) }),
      perform: async proof => {
        if (purpose === "passkey_remove") return credentialRequest(call, "/api/account/passkeys/remove", { passkeyId, ...proof }, "passkey_remove");
        const browser = await loadPasskeys(), challenge = await call("/api/account/passkeys/options", { method: "POST", body: JSON.stringify(proof) });
        const response = await browser.startRegistration({ optionsJSON: challenge.options });
        return credentialRequest(call, "/api/account/passkeys/verify", { challengeId: challenge.challengeId, response }, "passkey_add");
      },
      onSuccess: () => onChanged({ panel: "passkeys", message: purpose === "passkey_add" ? "Passkey added." : "Passkey removed." }),
    });
  }
  root.querySelector("#addCustomerPasskey").onclick = event => ownerProof("passkey_add", event.currentTarget);
  root.querySelectorAll("[data-remove-passkey]").forEach(button => { button.onclick = () => ownerProof("passkey_remove", button, button.dataset.removePasskey); });
  root.querySelectorAll("[data-rename-passkey]").forEach(form => { form.onsubmit = async event => {
    event.preventDefault(); event.stopPropagation();
    if (root.hasAttribute("aria-busy")) return;
    const label = form.elements.label.value;
    try {
      await runButton(form.querySelector("button"), "Saving…", async () => {
        root.setAttribute("aria-busy", "true");
        await call("/api/account/passkeys/rename", { method: "POST", body: JSON.stringify({ passkeyId: form.dataset.renamePasskey, label }) });
        await onChanged({ panel: "passkeys", message: "Passkey renamed." });
      }, { controls: Array.from(root.querySelectorAll("button, input")) });
    } catch (error) { securityError(status, error); }
    finally { root.removeAttribute("aria-busy"); }
  }; });
  if (restore || setup) openSecurityManager(restore || { panel: "passkeys" });
}

export function accountSessionsCard(security) {
  const sessions = security.sessions || [];
  return `<section class="surface account-sessions" aria-labelledby="accountSessionsTitle"><p class="eyebrow">Activity</p><h2 id="accountSessionsTitle">Sessions &amp; security notices</h2><p>Review where you are signed in. Security notices and recent sign-ins are in Notifications.</p><button type="button" class="secondary-action" data-open-security-history>View security history</button><details id="sessionActivity"><summary>Active sessions <span class="account-count">${h(sessions.length)}</span></summary>${sessions.map(session => `<div class="device"><div><b>${session.current ? "This device" : h(session.userAgent ? session.userAgent.slice(0, 40) : "Unknown device")}</b><br><small>${h(session.ip || "IP address unavailable")} · Last active ${h(new Date(session.lastSeenAt).toLocaleString())}</small></div><button type="button" class="secondary-action" data-revoke-session="${h(session.id)}">Sign out</button></div>`).join("")}<button type="button" class="danger-action" id="logoutEverywhere">Log out everywhere</button></details></section>`;
}
