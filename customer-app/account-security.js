import { escapeHtml as h } from "/shared/safe-html.js";

export function accountSecurityCard(customer, security, setup = false) {
  const passkeys = security.passkeys || [];
  return `<section class="surface account-security" id="accountSecurity" aria-labelledby="accountSecurityTitle">
    ${setup ? '<p class="success" role="status">Security setup complete.</p>' : ""}
    <p class="eyebrow">Sign-in and security</p><h2 id="accountSecurityTitle">PIN &amp; passkeys</h2>
    <p>Use your four-digit PIN or a passkey to sign in. Account changes require fresh verification.</p>
    <div class="account-setting"><div><h3>Account PIN</h3><p>${customer.pinConfigured !== false ? "Your PIN is set. Change it in PIN and recovery below." : "No PIN is set. Use your passkey or account recovery to set one."}</p></div><span class="account-badge">${customer.pinConfigured !== false ? "Set" : "Not set"}</span></div>
    <div class="account-setting"><div><h3>Passkeys</h3><p>Use your device lock, fingerprint or security key.</p></div><span class="account-badge">${h(passkeys.length)} saved</span></div>
    <button type="button" id="addCustomerPasskey">Add a passkey</button>
    <div class="account-passkeys">${passkeys.length ? passkeys.map(key => `<div class="device"><div><b>${h(key.label)}</b><br><small>Added ${h(new Date(key.createdAt).toLocaleDateString())}</small></div><div class="device-actions"><details class="rename-passkey"><summary>Rename</summary><form data-rename-passkey="${h(key.id)}"><label>New name<input name="label" value="${h(key.label)}" maxlength="60" required></label><button>Save name</button></form></details><button type="button" class="danger-action" data-remove-passkey="${h(key.id)}">Remove</button></div></div>`).join("") : `<p class="account-hint">${customer.pinConfigured !== false ? 'No passkeys saved yet. Your PIN remains available.' : 'Use account recovery to regain access and set a PIN.'}</p>`}</div>
  </section>`;
}

export function accountSessionsCard(security) {
  const sessions = security.sessions || [];
  return `<section class="surface account-sessions" aria-labelledby="accountSessionsTitle"><p class="eyebrow">Activity</p><h2 id="accountSessionsTitle">Sessions &amp; security notices</h2><p>Review where you are signed in. Security notices and recent sign-ins are in Notifications.</p><button type="button" class="secondary-action" data-open-security-history>View security history</button><details id="sessionActivity"><summary>Active sessions <span class="account-count">${h(sessions.length)}</span></summary>${sessions.map(session => `<div class="device"><div><b>${session.current ? "This device" : h(session.userAgent ? session.userAgent.slice(0, 40) : "Unknown device")}</b><br><small>${h(session.ip || "IP address unavailable")} · Last active ${h(new Date(session.lastSeenAt).toLocaleString())}</small></div><button type="button" class="secondary-action" data-revoke-session="${h(session.id)}">Sign out</button></div>`).join("")}<button type="button" class="danger-action" id="logoutEverywhere">Log out everywhere</button></details></section>`;
}
