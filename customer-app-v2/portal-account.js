// Redesigned Account tab (canvas: PhoneAccount, DesktopAccount): who you are,
// then grouped links to each part of your account. The detailed sections
// (profile, notification settings, PIN & passkeys, sessions) follow below and
// each link opens its section. Language is an explicit Account preference.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format, setPreferredLanguage } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const mask = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
  return digits.length === 9 ? `+237 ${digits[0]}•• •• ${digits.slice(5, 7)} ${digits.slice(7)}` : phone || "";
};
const chevron = '<span class="portal-account__chevron" aria-hidden="true">›</span>';
const item = (href, label, value, extra = "") => `<a class="portal-account__item" href="${href}" ${extra}><span>${h(label)}</span>${value ? `<span class="portal-account__value">${value}</span>` : chevron}</a>`;

// Phones (PhoneAccount): avatar, "Your account" and the number, then labelled
// groups and Sign out in the last one. From 768px (DesktopAccount): the name
// with number and email, three panels side by side and a Sign out button.
// Notification switches change the account's real preferences: low data
// alerts are the Data / bundles category, bundle ending soon the expiry
// warnings, shop order updates the Shop orders category (#357, off until
// switched on). English remains the default; French is an explicit preference:
// phones pick it on the drawn English | Français control (#357).
const toggle = (key, label) => `<label class="portal-account__item portal-account__toggle"><span>${h(label)}</span><span class="nd-switch"><input type="checkbox" role="switch" class="nd-switch__input" data-account-pref="${key}" disabled><span class="nd-switch__track" aria-hidden="true"></span></span></label>`;
export function accountHub(customer, security, { homeRegistered = false } = {}) {
  const name = customer.name || L("portalYourAccount");
  const passkeys = (security.passkeys || []).length, sessions = (security.sessions || []).filter((s) => !s.revokedAt && s.status !== "revoked").length;
  const phone = mask(customer.phoneE164 || customer.phone), email = customer.email || "";
  const signOut = (cls) => `<button type="button" class="portal-account__item portal-account__signout ${cls}" data-account-signout>${h(L("portalSignOut"))}</button>`;
  return `<section class="portal-account full" data-portal-view="account" aria-labelledby="accountHubTitle">
  <div class="portal-account__head"><span class="nd-avatar nd-avatar--lg" aria-hidden="true">${h(name.trim().charAt(0).toUpperCase())}</span><span class="portal-account__who"><h2 class="portal-account__title" id="accountHubTitle"><span class="nd-narrow-only">${h(L("portalYourAccount"))}</span><span class="nd-wide-only">${h(name)}</span></h2><span class="portal-account__contact"><span class="nd-narrow-only">${h(phone)}</span><span class="nd-wide-only">${h([phone, email].filter(Boolean).join(" · "))}</span></span></span><a class="portal-account__edit" href="/dashboard#editProfile"><span class="nd-narrow-only">${h(L("portalEdit"))}</span><span class="nd-wide-only">${h(L("portalEditProfile"))}</span></a></div>
  <div class="portal-account__panels">
    <section class="portal-account__panel" aria-labelledby="accountSecurityGroup"><h3 class="portal-account__group" id="accountSecurityGroup">${h(L("portalSecurity"))}</h3>
      <div class="portal-account__list">
        ${item("/dashboard#pin", L("portalChangePin"), "")}
        ${item("/dashboard#passkeys", L("portalPasskeySignIn"), `<span class="${passkeys ? "is-on" : ""}">${h(L(passkeys ? "portalOn" : "portalOff"))}</span>`)}
        ${item("/dashboard#sessions", L("portalSignedInDevices"), h(L("portalActiveCount", { count: sessions })))}
      </div>
    </section>
    <section class="portal-account__panel" aria-labelledby="accountNotificationsGroup"><h3 class="portal-account__group" id="accountNotificationsGroup">${h(L("portalNotificationsGroup"))}</h3>
      <div class="portal-account__list">${toggle("usage", L("portalPrefLowData"))}${toggle("expiry", L("portalPrefEnding"))}${toggle("orders", L("portalPrefOrders"))}</div>
    </section>
    <section class="portal-account__panel nd-narrow-only" aria-labelledby="accountLanguageGroup"><h3 class="portal-account__group" id="accountLanguageGroup">${h(L("uiLanguage"))}</h3>
      <div class="portal-account__languages" role="group" aria-labelledby="accountLanguageGroup">${[["en", L("uiLanguageEnglish")], ["fr", L("uiLanguageFrench")]].map(([code, label]) => `<button type="button" lang="${code}" aria-pressed="${currentLanguage() === code}" data-account-lang="${code}">${h(label)}</button>`).join("")}</div>
    </section>
    <section class="portal-account__panel portal-account__panel--home" aria-labelledby="accountHomeGroup"><h3 class="portal-account__group nd-wide-only" id="accountHomeGroup">${h(L("portalHomeAndHelp"))}</h3>
      <div class="portal-account__list">
        <label class="portal-account__item portal-account__language nd-wide-only"><span>${h(L("uiLanguage"))}</span><select class="nd-input" data-account-language><option value="en" ${currentLanguage() === "en" ? "selected" : ""}>${h(L("uiLanguageEnglish"))}</option><option value="fr" ${currentLanguage() === "fr" ? "selected" : ""}>${h(L("uiLanguageFrench"))}</option></select></label>
        ${item("/home-router.html", L("portalHomeWispRouter"), h(L(homeRegistered ? "portalRouterRegistered" : "portalRouterNotRegistered")))}
        <span class="nd-wide-only">${item("/billing-terms.html", L("portalPackageRulesLink"), "")}</span>
        ${item("/help.html", L("portalHelpSupport"), "")}
        ${signOut("nd-narrow-only")}
      </div>
    </section>
  </div>
  ${signOut("portal-account__signout--button nd-wide-only")}
</section>`;
}

// Links open their section (details open, scrolled into view); sign out uses
// the header's own sign-out so its clean-up runs.
// Notification switches: read the preferences once, then save each change.
async function mountPreferences(call) {
  const switches = [...document.querySelectorAll("[data-account-pref]")];
  if (!switches.length || !call) return;
  const field = { usage: (p) => p.categories?.usage !== false, expiry: (p) => p.expiryWarnings === true, orders: (p) => p.categories?.orders === true };
  const body = { usage: (on) => ({ categories: { usage: on } }), expiry: (on) => ({ expiryWarnings: on }), orders: (on) => ({ categories: { orders: on } }) };
  try {
    const { preferences } = await call("/api/account/notifications?view=all&limit=1");
    for (const input of switches) {
      input.checked = field[input.dataset.accountPref](preferences || {});
      input.disabled = false;
      input.onchange = async () => {
        const on = input.checked;
        input.disabled = true;
        try { await call("/api/account/notifications", { method: "POST", body: JSON.stringify({ action: "preferences", ...body[input.dataset.accountPref](on) }) }); }
        catch (_) { input.checked = !on; } // the switch returns to its last saved position
        input.disabled = false;
      };
    }
  } catch (_) { /* Without preferences the switches stay disabled. */ }
}

export function mountAccountHub(call) {
  void mountPreferences(call);
  const choose = (value) => {
    const selected = setPreferredLanguage(value);
    for (const button of document.querySelectorAll("[data-account-lang]")) button.setAttribute("aria-pressed", String(button.dataset.accountLang === selected));
    window.dispatchEvent(new CustomEvent("ndahi:language", { detail: selected }));
  };
  const language = document.querySelector("[data-account-language]");
  if (language) language.onchange = () => choose(language.value);
  for (const button of document.querySelectorAll("[data-account-lang]")) button.onclick = () => choose(button.dataset.accountLang);
  document.querySelectorAll("[data-account-open]").forEach((link) => {
    link.onclick = (event) => {
      const target = document.getElementById(link.dataset.accountOpen);
      if (!target) return;
      event.preventDefault();
      if (target.tagName === "DETAILS") target.open = true;
      target.scrollIntoView({ block: "start" });
      const focusable = target.querySelector("summary, h2, button");
      if (focusable) focusable.focus({ preventScroll: true });
    };
  });
  const signOut = document.querySelector("[data-account-signout]"), logout = document.getElementById("logout");
  if (signOut && logout) signOut.onclick = () => logout.click();
}
