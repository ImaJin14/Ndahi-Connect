// Redesigned Profile & security (canvas: AdminProfile): who you are signed in
// as and a password change, your passkeys, and (owners) the staff accounts.
// Every change asks for fresh verification through the existing admin proof
// dialog; the API endpoints are v1's. Sign-in itself is unchanged until Phase 6.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { requestAdminActionProof } from "/action-proof.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const day = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString(currentLanguage() === "fr" ? "fr" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Africa/Douala" }) : "";
};
const ROLE = { owner: "adminRoleOwner", operator: "adminRoleOperator", auditor: "adminRoleAuditor", reseller: "adminRoleReseller" };

export function profileMarkup(x) {
  const profile = x.profile || {}, keys = profile.passkeyList || [], owner = profile.role === "owner";
  const you = `<section class="nd-panel admin-profile__card" aria-labelledby="profileYouTitle"><h2 class="nd-h2" id="profileYouTitle">${h(L("adminProfileYou"))}</h2>
  <div class="admin-row"><span class="admin-row__label">${h(L("adminProfileUsername"))}</span><strong>${h(profile.username || "—")}</strong></div>
  <div class="admin-row"><span class="admin-row__label">${h(L("adminProfileRole"))}</span><strong>${h(L(ROLE[profile.role] || "adminProfileRole"))}</strong></div>
  <form id="adminPassword" class="admin-form"><label class="nd-field"><span class="nd-label">${h(L("adminNewPassword"))}</span><input class="nd-input" name="newPassword" type="password" autocomplete="new-password" minlength="8" required></label>
  <label class="nd-field"><span class="nd-label">${h(L("adminConfirmPassword"))}</span><input class="nd-input" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required></label>
  <div class="admin-form__actions"><button type="submit" class="nd-btn nd-btn--secondary">${h(L("adminChangePassword"))}</button><span class="admin-saved" role="status" aria-live="polite" data-password-message></span></div></form></section>`;
  const passkeys = `<section class="nd-panel admin-profile__card admin-passkeys" aria-labelledby="adminPasskeysTitle"><h2 class="nd-h2" id="adminPasskeysTitle">${h(L("adminPasskeysTitle"))}</h2><p class="nd-meta">${h(L("adminPasskeysLede"))}</p>
  <ul class="admin-passkeys__list">${keys.map((key, index) => `<li><span><strong>${h(key.label || L("adminPasskeyN", { n: index + 1 }))}</strong>${key.createdAt ? ` · ${h(L("adminAddedOn", { date: day(key.createdAt) }))}` : ""}</span><button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-remove-admin-passkey="${h(key.id)}" aria-label="${h(L("adminRemovePasskeyNamed", { name: key.label || L("adminPasskeyN", { n: index + 1 }) }))}">${h(L("adminRemove"))}</button></li>`).join("")}</ul>
  ${keys.length === 1 ? `<p class="nd-callout nd-callout--warning admin-callout" role="status">${h(L("adminOnePasskeyLeft"))}</p>` : ""}
  <form id="adminPasskeys"><button type="button" class="nd-btn" id="enrollPasskey">${h(L("adminAddPasskeyHere"))}</button></form></section>`;
  const staff = owner ? `<section class="nd-panel admin-profile__card" aria-labelledby="profileStaffTitle"><h2 class="nd-h2" id="profileStaffTitle">${h(L("adminStaffTitle"))}</h2>
  ${(x.administrators || []).map((a) => `<div class="admin-row"><span><strong>${h(a.displayName || a.username)}</strong> · ${h(L("adminRoleWord_" + a.role))}</span>${a.username === profile.username ? `<span class="admin-row__label">${h(L("adminYou"))}</span>` : a.active === false ? `<span class="admin-row__label">${h(L("adminDeactivated"))}</span>` : `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-deactivate-staff="${h(a.id)}" data-staff-name="${h(a.displayName || a.username)}">${h(L("adminDeactivate"))}</button>`}</div>`).join("")}
  <details class="admin-options" id="staffAdd"><summary>${h(L("adminAddStaff"))}</summary><form id="staffCreate" class="admin-form admin-options__body">
    <label class="nd-field"><span class="nd-label">${h(L("adminProfileUsername"))}</span><input class="nd-input" name="username" pattern="[a-z0-9._\\-]{3,40}" maxlength="40" autocomplete="off" required></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldName"))}</span><input class="nd-input" name="displayName" maxlength="80"></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminProfileRole"))}</span><select class="nd-input" name="role">${["operator", "auditor", "reseller", "owner"].map((role) => `<option value="${role}">${h(L(ROLE[role]))}</option>`).join("")}</select></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminTemporaryPassword"))}</span><input class="nd-input" name="password" type="password" autocomplete="new-password" minlength="8" required></label>
    <p class="nd-hint">${h(L("adminAddStaffHint"))}</p>
    <div class="admin-form__actions"><button type="submit" class="nd-btn">${h(L("adminAddStaffButton"))}</button><span class="admin-saved" role="status" aria-live="polite" data-staff-message></span></div>
  </form></details></section>` : "";
  return you + passkeys + staff;
}

// Wires the password and staff forms; passkeys keep v1's handlers in app.js.
export function mountProfile({ call, runAction, reload }) {
  const password = document.getElementById("adminPassword");
  if (password) password.onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(password)), message = password.querySelector("[data-password-message]");
    if (fields.newPassword !== fields.confirmPassword) { message.textContent = L("adminPasswordsDiffer"); return; }
    await runAction(password.querySelector('[type="submit"]'), L("adminSaving"), async () => {
      const proof = await requestAdminActionProof({ call, purpose: "pin_change", input: {} });
      await call("/api/admin/profile/password", { method: "POST", body: JSON.stringify({ newPassword: fields.newPassword, ...proof }) });
      password.reset();
      message.textContent = L("adminPasswordChanged");
    }, "[data-password-message]");
  };
  const create = document.getElementById("staffCreate");
  if (create) create.onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(create));
    await runAction(create.querySelector('[type="submit"]'), L("adminSaving"), async () => {
      const input = { username: fields.username.trim().toLowerCase(), displayName: fields.displayName.trim() || fields.username.trim().toLowerCase(), role: fields.role };
      const proof = await requestAdminActionProof({ call, purpose: "staff_create", input });
      await call("/api/admin/users", { method: "POST", body: JSON.stringify({ ...input, password: fields.password, ...proof }) });
      await reload();
    }, "[data-staff-message]");
  };
  document.querySelectorAll("[data-deactivate-staff]").forEach((button) => {
    button.onclick = async () => {
      if (!confirm(L("adminDeactivateConfirm", { name: button.dataset.staffName }))) return;
      await runAction(button, L("adminWorking"), async () => {
        const input = { userId: button.dataset.deactivateStaff };
        const proof = await requestAdminActionProof({ call, purpose: "staff_deactivate", input });
        await call("/api/admin/users/deactivate", { method: "POST", body: JSON.stringify({ ...input, ...proof }) });
        await reload();
      });
    };
  });
}
