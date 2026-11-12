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
  internet: "bundles", activity: "payments", devices: "home", managePlan: "bundles", billing: "payments",
  accountSecurity: "account", notificationSettings: "account", sessionActivity: "account", sessions: "account",
};
const TITLES = { internet: "portalTitleInternet", shop: "portalTitleShop", activity: "portalTitleActivity", account: "portalTitleAccount" };
// Opening one of these routes scrolls to that part of its tab.
const SECTIONS = { vouchers: "voucherHistory", payments: "billing", billing: "billing" };
let mounted = false;

// The v1 view for the current address (home, bundles, vouchers, shop, payments
// or account). app.js still reasons in these names.
export function activePortalView() {
  const hash = location.hash.slice(1), view = aliases[hash] || hash;
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
  const title = document.getElementById("portalTitle");
  if (title) title.textContent = TITLES[tab] ? t(TITLES[tab], lang) : title.dataset.welcome || t("portalWelcome", lang);
  if (["sessions", "sessionActivity"].includes(hash) && openDetails("sessionActivity")) return;
  if (hash === "devices" && openDetails("manageDevices")) return;
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
    ["header", "#shopPanel"].forEach((selector) => { const root = document.querySelector(selector); if (root) localize(root, lang); });
    window.addEventListener("hashchange", () => applyView(true));
    if (window.visualViewport) {
      const keyboard = () => document.body.classList.toggle("nd-keyboard-open", window.innerHeight - window.visualViewport.height > 150 &&
        Boolean(document.activeElement && document.activeElement.matches("input, textarea, select")));
      window.visualViewport.addEventListener("resize", keyboard);
      document.addEventListener("focusout", () => setTimeout(keyboard, 0));
    }
  }
  applyView();
}
