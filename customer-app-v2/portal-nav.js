// Redesigned portal navigation (customer-app-v2): Home · Internet · Shop ·
// Activity · Account, from the design kit (shared-app/ui/navigation.js). One nav
// is the bottom tab bar on phones and the header links from 768px.
//
// Dashboard panels keep their v1 view names (data-portal-view) and are shown on
// the tab that now holds them, so v1 links such as /dashboard#vouchers or
// #payments still land on the right content.
import { format, t } from "/shared/i18n.js";
import { clear, currentLanguage, localize } from "/shared/ui/dom.js";
import { renderPortalTabs } from "/shared/ui/navigation.js";

const HREFS = { home: "/dashboard#home", internet: "/dashboard#internet", shop: "/dashboard#shop", activity: "/dashboard#activity", account: "/dashboard#account" };
const PANEL_TABS = { home: "home", bundles: "internet", vouchers: "internet", shop: "shop", payments: "activity", account: "account" };
const aliases = {
  internet: "bundles", activity: "payments", devices: "home", redeem: "vouchers", managePlan: "bundles", billing: "payments",
  accountSecurity: "account", notificationSettings: "account", editProfile: "account", sessionActivity: "account", pin: "account", passkeys: "account",
  product: "shop", checkout: "shop", order: "shop", sessionActivity: "account", sessions: "account",
};
// Pages within a tab (canvas: PhoneDevices, PhoneEditProfile): the address
// shows one section on its own with a back arrow to its tab. Each names the
// section, the disclosure it opens and where focus starts.
const SUBPAGES = {
  devices: { section: "manageDevices", open: "manageDevices", focus: "devicesTitle", back: "/dashboard#home" },
  editProfile: { section: "emailAccount", open: "editProfile", focus: "editProfileTitle", back: "/dashboard#account" },
  // These share one page head (back arrow and title), added by subHead() below.
  pin: { section: "accountSecurity", open: "securityManager", panel: "pin", title: "portalChangePin", back: "/dashboard#account" },
  passkeys: { section: "accountSecurity", open: "securityManager", panel: "passkeys", title: "portalPasskeySignIn", back: "/dashboard#account" },
  sessions: { section: "accountSessions", open: "sessionActivity", title: "portalSignedInDevices", back: "/dashboard#account" },
  sessionActivity: { section: "accountSessions", open: "sessionActivity", title: "portalSignedInDevices", back: "/dashboard#account" },
  // The whole security manager (PIN, passkeys and recovery) and notification settings.
  accountSecurity: { section: "accountSecurity", open: "securityManager", title: "portalPinPasskeys", back: "/dashboard#account" },
  notificationSettings: { section: "notificationSettings", title: "portalNotificationSettings", back: "/dashboard#account" },
  // Shop pages (canvas: PhoneProduct, PhoneCheckout, PhoneOrder) draw their own bar.
  product: { section: "shopPanel", focus: "shopTitle", back: "/dashboard#shop" },
  checkout: { section: "shopPanel", focus: "shopTitle", back: "/dashboard#shop" },
  order: { section: "shopPanel", focus: "shopTitle", back: "/dashboard#activity" },
  // Voucher code entry (canvas: PhoneVoucher), reached from Home and Internet.
  redeem: { section: "activateDevice", open: "differentCode", title: "portalVoucherTitle", back: "/dashboard#vouchers", backLabel: "portalBackInternet" },
};
const BACK = '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18 9 12l6-6"></path></svg>';

// The shared head for pages that name a title; hidden on every other view.
function subHead(sub, lang) {
  let head = document.getElementById("portalSubHead");
  if (!sub || !sub.title) { if (head) head.hidden = true; return null; }
  if (!head) {
    const before = document.getElementById("dashboardMessage");
    if (!before) return null;
    head = document.createElement("div");
    head.className = "portal-sub-head";
    head.id = "portalSubHead";
    head.innerHTML = `<a class="portal-sub__back" href="/dashboard#account">${BACK}</a><h2 class="portal-sub-head__title" id="portalSubTitle" tabindex="-1"></h2>`;
    before.parentNode.insertBefore(head, before);
  }
  const back = head.querySelector("a");
  back.href = sub.back;
  back.setAttribute("aria-label", t(sub.backLabel || (sub.back.endsWith("#home") ? "portalBackHome" : "portalBackAccount"), lang));
  head.querySelector("h2").textContent = t(sub.title, lang);
  head.hidden = false;
  return head.querySelector("h2");
}
// Tab heads (canvas): phones show the tab's name and a lede; from 768px an
// eyebrow and a headline. Account starts with the profile instead.
const TITLES = { internet: "portalTitleInternet", shop: "portalTitleShop", activity: "portalTitleActivity", account: "portalTitleAccount" };
const PHONE_TITLES = { internet: ["uiTabInternet", "portalLedeInternet"], shop: ["uiTabShop", "portalLedeShop"], activity: ["uiTabActivity", "portalLedeActivity"] };
const EYEBROWS = { internet: "uiTabInternet", shop: "portalEyebrowShop", activity: "uiTabActivity" };
// Opening one of these routes scrolls to that part of its tab.
const SECTIONS = { vouchers: "voucherHistory", payments: "billing", billing: "billing" };
let mounted = false;

// The v1 view for the current address (home, bundles, vouchers, shop, payments
// or account). app.js still reasons in these names.
export function activePortalView() {
  // Shop routes carry an id (#product/<id>, #checkout/<id>/<n>, #order/<id>).
  const hash = location.hash.slice(1).split("/")[0], view = aliases[hash] || hash;
  return PANEL_TABS[view] ? view : new URLSearchParams(location.search).get("setup") === "passkey" ? "account" : "home";
}

export function activePortalTab() {
  return PANEL_TABS[activePortalView()];
}

function openDetails(id) {
  const details = document.getElementById(id);
  if (!details) return false;
  details.open = true;
  const summary = details.querySelector("summary");
  if (summary) summary.focus();
  details.scrollIntoView({ block: "start" });
  return true;
}

function applyView(scroll = false) {
  const tab = activePortalTab(), lang = currentLanguage(), hash = location.hash.slice(1);
  document.querySelectorAll("[data-portal-view]").forEach((panel) => { panel.hidden = PANEL_TABS[panel.dataset.portalView] !== tab; });
  document.querySelectorAll("[data-portal-tab]").forEach((link) => {
    if (link.dataset.portalTab === tab) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  // Page styles key off the current tab (the Home hero on phones). Not
  // data-portal-tab: journeys select the tab links by that attribute.
  document.body.setAttribute("data-current-tab", tab);
  // A page within the tab, when this account has its section (no devices on a Home router).
  const page = hash.split("/")[0], sub = SUBPAGES[page] && document.getElementById(SUBPAGES[page].section) ? SUBPAGES[page] : null;
  if (sub) document.body.setAttribute("data-portal-sub", page); else document.body.removeAttribute("data-portal-sub");
  document.querySelectorAll("[data-sub-active]").forEach((node) => node.removeAttribute("data-sub-active"));
  if (sub) document.getElementById(sub.section)?.setAttribute("data-sub-active", "");
  const subTitle = subHead(sub, lang);
  // Internet on phones shows Bundles or Vouchers (canvas: PhoneInternet).
  const internetView = activePortalView() === "vouchers" ? "vouchers" : "bundles";
  document.body.setAttribute("data-internet-view", internetView);
  document.querySelectorAll("[data-internet-switch]").forEach((link) => {
    if (link.dataset.internetSwitch === internetView) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    // Switching within Internet replaces the address: Back leaves the tab, as for any tab.
    link.onclick = (event) => { event.preventDefault(); location.replace(link.href); };
  });
  const title = document.getElementById("portalTitle");
  if (title) {
    const wide = TITLES[tab] ? t(TITLES[tab], lang) : title.dataset.moment || title.dataset.welcome || t("portalWelcome", lang), phone = PHONE_TITLES[tab];
    clear(title);
    if (phone) {
      for (const [text, cls] of [[t(phone[0], lang), "nd-narrow-only"], [wide, "nd-wide-only"]]) {
        const span = document.createElement("span"); span.className = cls; span.textContent = text; title.appendChild(span);
      }
    } else title.textContent = wide;
    let lede = document.getElementById("portalLede");
    if (!lede) { lede = document.createElement("p"); lede.id = "portalLede"; lede.className = "portal-head__lede nd-narrow-only"; title.after(lede); }
    lede.textContent = phone ? t(phone[1], lang) : "";
    lede.hidden = !phone;
  }
  // Brand bar on phones: Home only (canvas: PhoneHome); other tabs start with their title.
  document.querySelector("header.nd-topnav")?.classList.toggle("nd-topnav--phone-bar", tab === "home" && !SUBPAGES[hash.split("/")[0]]);
  const eyebrow = document.getElementById("portalEyebrow");
  if (eyebrow) {
    eyebrow.textContent = tab === "home" ? new Date().toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long" }) : EYEBROWS[tab] ? t(EYEBROWS[tab], lang) : "";
    eyebrow.hidden = !eyebrow.textContent;
  }
  const headAction = document.getElementById("portalHeadAction");
  if (headAction) headAction.hidden = tab !== "home";
  if (sub) {
    const details = document.getElementById(sub.open);
    if (details) details.open = true;
    if (sub.panel) document.querySelector(`[data-security-panel="${sub.panel}"]`)?.click();
    window.scrollTo(0, 0);
    (subTitle || document.getElementById(sub.focus))?.focus({ preventScroll: true });
    return;
  }
  const section = SECTIONS[hash] && document.getElementById(SECTIONS[hash]);
  if (section && scroll) { section.scrollIntoView({ block: "start" }); return; }
  if (scroll) {
    window.scrollTo(0, 0);
    if (title) title.focus({ preventScroll: true });
  }
}

export function mountThemeToggle(button = document.getElementById("themeToggle")) {
  // Theme selection is temporarily disabled; retain its implementation below.
  document.documentElement.removeAttribute("data-theme");
  if (button) button.hidden = true;
  /*
  let stored = null;
  try { stored = localStorage.getItem("ndahi-theme"); } catch (_) {}
  const apply = (theme) => {
    if (theme) document.documentElement.setAttribute("data-theme", theme);
    else document.documentElement.removeAttribute("data-theme");
  };
  if (stored) apply(stored);
  if (!button) return;
  const updateLabel = () => {
    let isDark = false;
    try {
      isDark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (_) {}
    button.innerHTML = isDark ? '<span aria-hidden="true">☀️</span>' : '<span aria-hidden="true">🌙</span>';
    button.setAttribute("aria-label", isDark ? "Switch to light mode" : "Switch to dark mode");
    button.title = isDark ? "Switch to light mode" : "Switch to dark mode";
  };
  updateLabel();
  button.onclick = () => {
    let isDark = false;
    try {
      isDark = document.documentElement.getAttribute("data-theme") === "dark" ||
        (!document.documentElement.getAttribute("data-theme") && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    } catch (_) {}
    const next = isDark ? "light" : "dark";
    apply(next);
    try { localStorage.setItem("ndahi-theme", next); } catch (_) {}
    updateLabel();
  };
  */
}

// A renewal moment's hello ("Running low.", renewal.js) replaces the welcome on
// Home; an empty text brings the welcome back.
export function setHomeTitle(text) {
  const title = document.getElementById("portalTitle");
  if (!title) return;
  if (text) title.dataset.moment = text; else delete title.dataset.moment;
  if (activePortalTab() === "home" && !document.body.hasAttribute("data-portal-sub")) title.textContent = text || title.dataset.welcome || t("portalWelcome", currentLanguage());
}

export function mountPortalNavigation(pending = 0, name) {
  mountThemeToggle();
  const lang = currentLanguage();
  if (name !== undefined) {
    const clean = String(name || "").trim();
    const first = clean.split(/\s+/)[0];
    document.getElementById("portalTitle").dataset.welcome = clean && !/^(customer|new customer|user|test customer)$/i.test(clean)
      ? format("portalWelcomeName", { name: first }, lang) : t("portalWelcome", lang);
  }
  const nav = document.getElementById("portalNav");
  const badges = pending ? { activity: { count: pending, label: format(pending === 1 ? "portalPendingOne" : "portalPendingOther", { count: pending }, lang) } } : {};
  clear(nav);
  renderPortalTabs({ current: activePortalTab(), hrefs: HREFS, badges, lang }).forEach((link) => nav.appendChild(link));
  nav.hidden = false;
  if (!mounted) {
    mounted = true;
    // Once only: app.js changes the logout label while signing out.
    ["header", "#shopPanel", "#portalHead"].forEach((selector) => { const root = document.querySelector(selector); if (root) localize(root, lang); });
    window.addEventListener("hashchange", () => applyView(true));
    // Closing a page's section (Cancel, Escape, Close) returns to its tab.
    document.addEventListener("toggle", (event) => {
      const sub = SUBPAGES[document.body.getAttribute("data-portal-sub")];
      if (sub && event.target.id === sub.open && !event.target.open) location.replace(sub.back.slice(sub.back.indexOf("#"))); // hash only: keeps any query, no reload
    }, true);
    // On its own page a section stays open: its disclosure is the page, not a toggle.
    document.addEventListener("click", (event) => {
      const sub = SUBPAGES[document.body.getAttribute("data-portal-sub")], summary = event.target.closest && event.target.closest("summary");
      if (sub && summary && summary.parentElement && summary.parentElement.id === sub.open) event.preventDefault();
    });
    if (window.visualViewport) {
      const keyboard = () => document.body.classList.toggle("nd-keyboard-open", window.innerHeight - window.visualViewport.height > 150 &&
        Boolean(document.activeElement && document.activeElement.matches("input, textarea, select")));
      window.visualViewport.addEventListener("resize", keyboard);
      document.addEventListener("focusout", () => setTimeout(keyboard, 0));
    }
  }
  applyView();
}
