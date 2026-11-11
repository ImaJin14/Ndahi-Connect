// Redesigned Account tab (canvas: PhoneAccount, DesktopAccount): who you are,
// then grouped links to each part of your account. The detailed sections
// (profile, notification settings, PIN & passkeys, sessions) follow below and
// each link opens its section. Language switching is turned off product-wide,
// so the canvas's Language control is not shown.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const mask = (phone) => {
  const digits = String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
  return digits.length === 9 ? `+237 ${digits[0]}•• •• ${digits.slice(5, 7)} ${digits.slice(7)}` : phone || "";
};
const chevron = '<span class="portal-account__chevron" aria-hidden="true">›</span>';
const item = (href, label, value, extra = "") => `<a class="portal-account__item" href="${href}" ${extra}><span>${h(label)}</span>${value ? `<span class="portal-account__value">${value}</span>` : chevron}</a>`;

export function accountHub(customer, security) {
  const name = customer.name || L("portalYourAccount");
  const passkeys = (security.passkeys || []).length, sessions = (security.sessions || []).filter((s) => !s.revokedAt && s.status !== "revoked").length;
  return `<section class="portal-account full" data-portal-view="account" aria-labelledby="accountHubTitle">
  <div class="portal-account__head"><span class="nd-avatar nd-avatar--lg" aria-hidden="true">${h(name.trim().charAt(0).toUpperCase())}</span><span class="portal-account__who"><h2 class="portal-account__title" id="accountHubTitle">${h(name)}</h2><span class="nd-meta">${h(mask(customer.phoneE164 || customer.phone))}</span></span><a class="admin-link portal-account__edit" href="/dashboard#editProfile">${h(L("portalEdit"))}</a></div>
  <p class="portal-account__group">${h(L("portalSecurity"))}</p>
  <div class="portal-account__list">
    ${item("/dashboard#accountSecurity", L("portalChangePin"), "", 'data-account-open="accountSecurity"')}
    ${item("/dashboard#accountSecurity", L("portalPasskeySignIn"), `<span class="${passkeys ? "is-on" : ""}">${h(L(passkeys ? "portalOn" : "portalOff"))}</span>`, 'data-account-open="accountSecurity"')}
    ${item("/dashboard#sessions", L("portalSignedInDevices"), h(L("portalActiveCount", { count: sessions })))}
  </div>
  <p class="portal-account__group">${h(L("portalNotificationsGroup"))}</p>
  <div class="portal-account__list">${item("/dashboard#notificationSettings", L("portalNotificationSettings"), "", 'data-account-open="notificationSettings"')}</div>
  <div class="portal-account__list">
    ${item("/home-router.html", L("portalHomeRouterLink"), "")}
    ${item("/help.html", L("portalHelpSupport"), "")}
    <button type="button" class="portal-account__item portal-account__signout" data-account-signout>${h(L("portalSignOut"))}</button>
  </div>
</section>`;
}

// Links open their section (details open, scrolled into view); sign out uses
// the header's own sign-out so its clean-up runs.
export function mountAccountHub() {
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
