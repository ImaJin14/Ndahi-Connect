// Redesigned Profile & security (canvas: AdminProfile): who you are signed in
// as, your sign-in email and PIN, your passkeys, and (owners) the staff
// accounts. Every change asks for fresh verification through the admin proof
// dialog. Phase 6: staff sign in with email + PIN, then a passkey; an owner
// removes a staff member's lost passkeys and they add a new one at sign-in.
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

// A new passkey is named after the device it was made on (as #408 does for customers).
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
// "added 19 Aug · used today" (canvas: AdminProfile, #389).
const shortDay = (value) => new Date(value).toLocaleDateString(currentLanguage() === "fr" ? "fr" : "en-GB", { day: "numeric", month: "short", timeZone: "Africa/Douala" });
function keyMeta(key) {
  const added = Number.isFinite(Date.parse(key.createdAt)) ? L("adminAddedOn", { date: shortDay(key.createdAt) }) : "", used = Date.parse(key.lastUsedAt);
  if (!Number.isFinite(used)) return added;
  const local = (at) => new Date(new Date(at).toLocaleString("en-US", { timeZone: "Africa/Douala" })).setHours(0, 0, 0, 0);
  const days = Math.round((local(Date.now()) - local(used)) / 86400000);
  return [added, L("adminPasskeyUsed", { when: days <= 0 ? L("adminUsedToday") : days === 1 ? L("adminUsedYesterday") : shortDay(key.lastUsedAt) })].filter(Boolean).join(" · ");
}

// Profile and security (canvas: AdminProfile, #389; owner 26 Nov): You (name,
// email, Save and Change PIN), Passkeys, and for owners Staff with Remove and
// Invite an operator. Change PIN, Remove and Invite open small dialogs.
export function profileMarkup(x) {
  const profile = x.profile || {}, keys = profile.passkeyList || [], owner = profile.role === "owner";
  const you = `<section class="nd-panel admin-profile__card" aria-labelledby="profileYouTitle"><h2 class="nd-h2" id="profileYouTitle">${h(L("adminProfileYou"))}</h2>
  <form id="adminEmailForm" class="admin-form"><label class="nd-field"><span class="nd-label">${h(L("adminFieldName"))}</span><input class="nd-input" name="displayName" maxlength="80" autocomplete="name" value="${h(profile.displayName || "")}" required></label>
  <label class="nd-field"><span class="nd-label">${h(L("adminProfileEmail"))}</span><input class="nd-input" name="email" type="email" autocomplete="email" value="${h(profile.email || "")}" required></label>
  <div class="admin-form__actions"><button type="submit" class="nd-btn">${h(L("adminEmailSave"))}</button><button type="button" class="nd-btn nd-btn--secondary" id="openAdminPin">${h(L("adminChangePassword"))}</button><span class="admin-saved" role="status" aria-live="polite" data-email-message></span></div></form>
  <dialog class="admin-dialog" id="adminPinDialog" aria-labelledby="adminPinDialogTitle"><form id="adminPassword" class="admin-form"><h3 class="nd-h3" id="adminPinDialogTitle">${h(L("adminChangePassword"))}</h3><label class="nd-field"><span class="nd-label">${h(L("adminNewPassword"))}</span><input class="nd-input" name="newPassword" type="password" inputmode="numeric" pattern="[0-9]{6,8}" autocomplete="new-password" required aria-describedby="adminPinHint"></label>
  <label class="nd-field"><span class="nd-label">${h(L("adminConfirmPassword"))}</span><input class="nd-input" name="confirmPassword" type="password" inputmode="numeric" pattern="[0-9]{6,8}" autocomplete="new-password" required></label><p class="nd-hint" id="adminPinHint">${h(L("adminPinHint"))}</p>
  <div class="admin-form__actions"><button type="submit" class="nd-btn">${h(L("adminChangePassword"))}</button><button type="button" class="nd-btn nd-btn--secondary" data-close-dialog>${h(L("adminCancel"))}</button></div><p class="admin-saved" role="status" aria-live="polite" data-password-message></p></form></dialog>
  <p class="admin-saved" role="status" aria-live="polite" data-pin-changed></p></section>`;
  const passkeys = `<section class="nd-panel admin-profile__card admin-passkeys" aria-labelledby="adminPasskeysTitle"><h2 class="nd-h2" id="adminPasskeysTitle">${h(L("adminPasskeysHeading"))}</h2><p class="nd-meta">${h(L("adminPasskeysLede"))}</p>
  ${keys.length ? `<ul class="admin-passkeys__list">${keys.map((key, index) => { const name = key.label || L("adminPasskeyN", { n: index + 1 }), meta = keyMeta(key); return `<li><span><strong>${h(name)}</strong>${meta ? ` · ${h(meta)}` : ""}</span><button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-remove-admin-passkey="${h(key.id)}" aria-label="${h(L("adminRemovePasskeyNamed", { name }))}">${h(L("adminRemove"))}</button></li>`; }).join("")}</ul>` : ""}
  ${keys.length === 1 ? `<p class="nd-callout nd-callout--warning admin-callout" role="status">${h(L("adminOnePasskeyLeft"))}</p>` : ""}
  <form id="adminPasskeys"><button type="button" class="nd-btn" id="enrollPasskey">${h(L("adminAddPasskeyHere"))}</button></form></section>`;
  const active = (x.administrators || []).filter((a) => a.active !== false);
  const staff = owner ? `<section class="nd-panel admin-profile__card admin-staff" aria-labelledby="profileStaffTitle"><h2 class="nd-h2" id="profileStaffTitle">${h(L("adminStaffTitle"))}</h2>
  ${active.map((a) => { const name = a.displayName || a.username; return `<div class="admin-row"><span><strong>${h(name)}</strong> · ${h(L("adminRoleWord_" + a.role))}</span>${a.username === profile.username ? `<span class="admin-row__label">${h(L("adminYou"))}</span>` : `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-remove-staff="${h(a.id)}" data-staff-name="${h(name)}" data-staff-passkeys="${h(a.passkeys || 0)}" aria-label="${h(L("adminRemoveStaffNamed", { name }))}">${h(L("adminRemove"))}</button>`}</div>`; }).join("")}
  <button type="button" class="nd-btn admin-staff__invite" id="inviteOperator">${h(L("adminInviteOperator"))}</button>
  <dialog class="admin-dialog" id="staffRemoveDialog" aria-labelledby="staffRemoveTitle"><div class="admin-form"><h3 class="nd-h3" id="staffRemoveTitle"></h3>
    <button type="button" class="nd-btn nd-btn--secondary admin-choice" data-staff-choice="passkeys"><strong>${h(L("adminRemoveStaffPasskeys"))}</strong><span>${h(L("adminRemoveStaffPasskeysHint"))}</span></button>
    <button type="button" class="nd-btn nd-btn--secondary admin-choice admin-btn--danger" data-staff-choice="staff"><strong>${h(L("adminRemoveFromStaff"))}</strong><span>${h(L("adminRemoveFromStaffHint"))}</span></button>
    <div class="admin-form__actions"><button type="button" class="nd-btn nd-btn--secondary" data-close-dialog>${h(L("adminCancel"))}</button></div><p class="admin-saved" role="status" aria-live="polite" data-staff-remove-message></p></div></dialog>
  <dialog class="admin-dialog" id="staffAdd" aria-labelledby="staffAddTitle"><form id="staffCreate" class="admin-form"><h3 class="nd-h3" id="staffAddTitle">${h(L("adminInviteOperator"))}</h3>
    <label class="nd-field"><span class="nd-label">${h(L("adminProfileUsername"))}</span><input class="nd-input" name="username" pattern="[a-z0-9._\\-]{3,40}" maxlength="40" autocomplete="off" required></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminFieldName"))}</span><input class="nd-input" name="displayName" maxlength="80"></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminProfileEmail"))}</span><input class="nd-input" name="email" type="email" autocomplete="off"></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminProfileRole"))}</span><select class="nd-input" name="role">${["operator", "auditor", "reseller", "owner"].map((role) => `<option value="${role}">${h(L(ROLE[role]))}</option>`).join("")}</select></label>
    <label class="nd-field"><span class="nd-label">${h(L("adminTemporaryPassword"))}</span><input class="nd-input" name="password" type="password" inputmode="numeric" pattern="[0-9]{6,8}" autocomplete="new-password" required></label>
    <p class="nd-hint">${h(L("adminAddStaffHint"))}</p>
    <div class="admin-form__actions"><button type="submit" class="nd-btn">${h(L("adminAddStaffButton"))}</button><button type="button" class="nd-btn nd-btn--secondary" data-close-dialog>${h(L("adminCancel"))}</button></div><p class="admin-saved" role="status" aria-live="polite" data-staff-message></p>
  </form></dialog></section>` : "";
  return you + passkeys + staff;
}

// Wires Save, Change PIN, staff Remove and Invite; passkeys keep their handlers in app.js.
export function mountProfile({ call, runAction, reload }) {
  const closeOn = (dialog) => dialog?.querySelectorAll("[data-close-dialog]").forEach((button) => { button.onclick = () => dialog.close(); });
  const emailForm = document.getElementById("adminEmailForm");
  if (emailForm) emailForm.onsubmit = async (event) => {
    event.preventDefault();
    const fields = new FormData(emailForm), email = fields.get("email").trim().toLowerCase(), displayName = fields.get("displayName").trim(),
      message = emailForm.querySelector("[data-email-message]"), before = emailForm.dataset;
    await runAction(emailForm.querySelector('[type="submit"]'), L("adminSaving"), async () => {
      // The name needs no verification; the sign-in email does.
      if (displayName !== (before.savedName ?? emailForm.displayName.defaultValue)) {
        await call("/api/admin/profile/name", { method: "POST", body: JSON.stringify({ displayName }) });
        before.savedName = displayName;
      }
      if (email !== (before.savedEmail ?? emailForm.email.defaultValue.trim().toLowerCase())) {
        const proof = await requestAdminActionProof({ call, purpose: "email_change", input: { email } });
        await call("/api/admin/profile/email", { method: "POST", body: JSON.stringify({ email, ...proof }) });
        before.savedEmail = email;
        message.textContent = L("adminEmailSaved");
      } else message.textContent = L("adminProfileSaved");
    }, "[data-email-message]");
  };
  // Change PIN opens its dialog: new PIN twice, then fresh verification.
  const pinDialog = document.getElementById("adminPinDialog"), password = document.getElementById("adminPassword");
  closeOn(pinDialog);
  const openPin = document.getElementById("openAdminPin");
  if (openPin && pinDialog) openPin.onclick = () => { password.reset(); password.querySelector("[data-password-message]").textContent = ""; pinDialog.showModal(); };
  if (password) password.onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(password)), message = password.querySelector("[data-password-message]");
    if (fields.newPassword !== fields.confirmPassword) { message.textContent = L("adminPasswordsDiffer"); return; }
    await runAction(password.querySelector('[type="submit"]'), L("adminSaving"), async () => {
      const proof = await requestAdminActionProof({ call, purpose: "pin_change", input: {} });
      await call("/api/admin/profile/password", { method: "POST", body: JSON.stringify({ newPassword: fields.newPassword, ...proof }) });
      password.reset();
      pinDialog.close();
      const done = document.querySelector("[data-pin-changed]");
      done.textContent = L("adminPasswordChanged");
      openPin.focus();
    }, "[data-password-message]");
  };
  // Staff Remove (owner, 26 Nov): their passkeys (a lost device) or the account.
  const removeDialog = document.getElementById("staffRemoveDialog");
  closeOn(removeDialog);
  let removing = null;
  document.querySelectorAll("[data-remove-staff]").forEach((button) => {
    button.onclick = () => {
      removing = button;
      removeDialog.querySelector("#staffRemoveTitle").textContent = L("adminRemoveStaffNamed", { name: button.dataset.staffName });
      removeDialog.querySelector('[data-staff-choice="passkeys"]').hidden = button.dataset.staffPasskeys === "0";
      removeDialog.querySelector("[data-staff-remove-message]").textContent = "";
      removeDialog.showModal();
    };
  });
  removeDialog?.querySelectorAll("[data-staff-choice]").forEach((choice) => {
    choice.onclick = async () => {
      const passkeysOnly = choice.dataset.staffChoice === "passkeys", input = { userId: removing.dataset.removeStaff };
      await runAction(choice, L("adminWorking"), async () => {
        const proof = await requestAdminActionProof({ call, purpose: passkeysOnly ? "staff_passkeys_remove" : "staff_deactivate", input });
        await call(passkeysOnly ? "/api/admin/users/passkeys/remove" : "/api/admin/users/deactivate", { method: "POST", body: JSON.stringify({ ...input, ...proof }) });
        removeDialog.close();
        await reload();
      }, "[data-staff-remove-message]");
    };
  });
  // Invite an operator opens today's add form (owner, 26 Nov).
  const addDialog = document.getElementById("staffAdd"), create = document.getElementById("staffCreate");
  closeOn(addDialog);
  const invite = document.getElementById("inviteOperator");
  if (invite && addDialog) invite.onclick = () => { create.reset(); create.role.value = "operator"; addDialog.showModal(); create.username.focus(); };
  if (create) create.onsubmit = async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(create));
    await runAction(create.querySelector('[type="submit"]'), L("adminSaving"), async () => {
      const input = { username: fields.username.trim().toLowerCase(), displayName: fields.displayName.trim() || fields.username.trim().toLowerCase(), role: fields.role,
        ...(fields.email.trim() ? { email: fields.email.trim().toLowerCase() } : {}) };
      const proof = await requestAdminActionProof({ call, purpose: "staff_create", input });
      await call("/api/admin/users", { method: "POST", body: JSON.stringify({ ...input, password: fields.password, ...proof }) });
      addDialog.close();
      await reload();
    }, "[data-staff-message]");
  };
}
