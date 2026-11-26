import { escapeHtml as h } from "/shared/safe-html.js";
import { loadPasskeys } from "./compat.js";
import { credentialRequest, mountVerifiedForm, passkeysAvailable, proofFields, proofButtons, securityError } from "./security-actions.js";
import { pinControls, recoveryControls, mountAccountRecovery } from "./account-recovery.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const KEY_ICON = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 7a4 4 0 1 1-3.9 5H8v3H5v-3H3V9h8.1A4 4 0 0 1 15 7Z"/></svg>';
// "Added 2 Nov · last used today" (canvas: PhonePasskey, #408).
const dayLabel = (iso) => new Date(iso).toLocaleDateString(currentLanguage() === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" });
function passkeyMeta(key) {
  const added = Number.isFinite(Date.parse(key.createdAt)) ? L("passkeyAdded", { date: dayLabel(key.createdAt) }) : "";
  const used = Date.parse(key.lastUsedAt);
  if (!Number.isFinite(used)) return added;
  const days = Math.floor((new Date().setHours(0, 0, 0, 0) - new Date(used).setHours(0, 0, 0, 0)) / 86400000);
  const when = days <= 0 ? L("passkeyToday") : days === 1 ? L("passkeyYesterday") : dayLabel(key.lastUsedAt);
  return [added, L("passkeyLastUsed", { when })].filter(Boolean).join(" · ");
}
// A new passkey is named after the device it was made on (owner, 26 Nov).
export function deviceLabel(agent = navigator.userAgent || "") {
  if (/iPhone/i.test(agent)) return "iPhone";
  if (/iPad/i.test(agent)) return "iPad";
  if (/Android/i.test(agent)) return /Mobile/i.test(agent) ? "Android phone" : "Android tablet";
  if (/CrOS/i.test(agent)) return "Chromebook";
  if (/Windows/i.test(agent)) return "Windows computer";
  if (/Macintosh|Mac OS X/i.test(agent)) return "Mac";
  if (/Linux/i.test(agent)) return "Linux computer";
  return "This device";
}

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
        <section id="security-passkeys" data-security-content="passkeys" aria-label="Manage passkeys" hidden><h3>Passkeys</h3><div class="account-passkey-intro"><strong>${h(L("passkeyHeroTitle"))}</strong><span>${h(L("passkeyHeroText"))}</span></div><button type="button" id="addCustomerPasskey">${h(L("passkeyAdd"))}</button>
          <p class="account-passkeys__label">${h(L("passkeyYours"))}</p><div class="account-passkeys">${passkeys.length ? passkeys.map(key => `<div class="device account-passkey"><span class="account-passkey__icon">${KEY_ICON}</span><span class="account-passkey__text"><b>${h(key.label)}</b><small>${h(passkeyMeta(key))}</small></span><button type="button" class="danger-action account-passkey__remove" data-remove-passkey="${h(key.id)}" aria-label="${h(L("passkeyRemoveNamed", { name: key.label }))}">${h(L("passkeyRemove"))}</button></div>`).join("") : `<p class="account-passkeys__none">${h(customer.pinConfigured !== false ? L("passkeyNone") : L("passkeyNoneNoPin"))}</p>`}</div>
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
  root.addEventListener("security-refresh", () => { void onChanged({ panel: securityViewState()?.panel || "pin", message: "Security refreshed. Review your current settings before trying again." }).catch(error => securityError(status, error)); });

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
        return credentialRequest(call, "/api/account/passkeys/verify", { challengeId: challenge.challengeId, response, label: deviceLabel() }, "passkey_add");
      },
      onSuccess: () => onChanged({ panel: "passkeys", message: purpose === "passkey_add" ? "Passkey added." : "Passkey removed." }),
    });
  }
  root.querySelector("#addCustomerPasskey").onclick = event => ownerProof("passkey_add", event.currentTarget);
  root.querySelectorAll("[data-remove-passkey]").forEach(button => { button.onclick = () => ownerProof("passkey_remove", button, button.dataset.removePasskey); });
  if (restore || setup) openSecurityManager(restore || { panel: "passkeys" });
}

// "Android phone · Chrome" from the browser's description (canvas: PhoneSessions).
function deviceName(agent = "") {
  const ua = String(agent || "");
  if (!ua) return "Unknown device";
  const device = /iPhone/.test(ua) ? "iPhone" : /iPad/.test(ua) ? "iPad" : /Android/.test(ua) ? (/Mobile/.test(ua) ? "Android phone" : "Android tablet") : /Windows/.test(ua) ? "Windows computer" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux computer" : "";
  const browser = /Edg\//.test(ua) ? "Edge" : /SamsungBrowser/.test(ua) ? "Samsung Internet" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  return [device, browser].filter(Boolean).join(" · ") || ua.slice(0, 40);
}
export function accountSessionsCard(security) {
  const sessions = security.sessions || [];
  return `<section class="surface account-sessions" id="accountSessions" aria-labelledby="accountSessionsTitle"><p class="eyebrow">Activity</p><h2 id="accountSessionsTitle">Sessions &amp; security notices</h2><p>Places where your NDAHI account is open. This isn't the same as devices using your bundle. Security notices and recent sign-ins are in Notifications.</p><button type="button" class="secondary-action" data-open-security-history>View security history</button><details id="sessionActivity"><summary>Active sessions <span class="account-count">${h(sessions.length)}</span></summary>${sessions.map(session => `<div class="device"${session.current ? " data-current" : ""}><div><b>${h(deviceName(session.userAgent))}</b><br><small>${session.current ? "This device · " : ""}${h(session.ip || "IP address unavailable")} · Last active ${h(new Date(session.lastSeenAt).toLocaleString())}</small></div>${session.current ? '<span class="nd-pill nd-pill--success account-you">You</span>' : ""}<button type="button" class="secondary-action" data-revoke-session="${h(session.id)}">Sign out</button></div>`).join("")}<button type="button" class="danger-action" id="logoutEverywhere">Sign out everywhere</button></details></section>`;
}
