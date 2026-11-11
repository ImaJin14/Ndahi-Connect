// Redesigned admin navigation (admin-app-v2): the grouped side menu from the
// design kit (Network · Sales · People · System) and the page head (eyebrow and
// title from each canvas screen).
//
// Panels keep their v1 names (data-tab-panel). Each menu item shows the panels
// that hold its screen today, and v1 addresses still land: #more opens Profile
// (the install prompt moved there), #voucher-create opens Vouchers.
import { format, t } from "/shared/i18n.js";
import { clear, currentLanguage, localize } from "/shared/ui/dom.js";
import { ADMIN_MENU, renderAdminMenu } from "/shared/ui/navigation.js";

// view -> menu item, panels shown, optional section to scroll to, title, eyebrow group.
const VIEWS = {
  home: { menu: "home", panels: ["home"], title: "adminTitleHome" },
  devices: { menu: "devices", panels: ["devices"], title: "adminTitleDevices", group: "uiAdminGroupNetwork" },
  connections: { menu: "connections", panels: ["connections"], title: "adminTitleConnections", group: "uiAdminGroupNetwork" },
  "network-setup": { menu: "setup", panels: ["network-setup"], title: "adminTitleSetup", group: "uiAdminGroupNetwork", ownerOnly: true },
  bundles: { menu: "bundles", panels: ["bundles"], title: "adminTitleBundles", group: "uiAdminGroupSales", lede: "adminBundlesLede" },
  // #bundle/<id>; app.js names the bundle in the title.
  bundle: { menu: "bundles", panels: ["bundle-edit"], title: "adminTitleBundleEdit", back: { href: "/dashboard#bundles", label: "adminTitleBundlesShort" } },
  vouchers: { menu: "vouchers", panels: ["vouchers"], title: "adminTitleVouchers", group: "uiAdminGroupSales" },
  // A sub-screen: a back link instead of the eyebrow; app.js names the batch.
  "voucher-print": { menu: "vouchers", panels: ["voucher-print"], title: "adminTitleVoucherPrint", back: { href: "/dashboard#vouchers", label: "adminTitleVouchersShort" } },
  payments: { menu: "payments", panels: ["payments"], title: "adminTitlePayments", group: "uiAdminGroupSales" },
  store: { menu: "store", panels: ["store"], title: "adminTitleStore", group: "adminGroupStore" },
  products: { menu: "products", panels: ["store"], title: "adminTitleProducts", group: "adminGroupStore" },
  cash: { menu: "cash", panels: ["cash"], title: "adminTitleCash", group: "uiAdminGroupSales" },
  customers: { menu: "customers", panels: ["customers"], title: "adminTitleCustomers", group: "uiAdminGroupPeople" },
  // #customer/<id>; app.js puts the customer's name in the title.
  customer: { menu: "customers", panels: ["customer"], title: "adminTitleCustomer", back: { href: "/dashboard#customers", label: "adminTitleCustomersShort" } },
  resellers: { menu: "resellers", panels: ["resellers"], title: "adminTitleResellers", group: "uiAdminGroupPeople" },
  audit: { menu: "audit", panels: ["audit"], title: "adminTitleAudit", group: "uiAdminGroupSystem" },
  profile: { menu: "profile", panels: ["profile"], title: "adminTitleProfile", group: "uiAdminGroupSystem" },
};
const ALIASES = { more: "profile", "voucher-create": "vouchers", setup: "network-setup" };
const HREFS = {};
ADMIN_MENU.forEach((section) => section.items.forEach((id) => { HREFS[id] = "/dashboard#" + id; }));
HREFS.setup = "/dashboard#network-setup";
HREFS.homerouters = "/home-routers.html";
const ROLES = { owner: "adminRoleOwner", operator: "adminRoleOperator", auditor: "adminRoleAuditor", reseller: "adminRoleReseller" };
const STORE_ROLES = ["owner", "operator"];

let mounted = false, currentRole, changed, homeRouters = false, badges = {};

// Role rules (unchanged from v1): network setup for the owner, the store for
// owners and operators. Cash and resellers follow the sections the dashboard
// rendered for this role; Home routers follows NDAHI Home being in use.
function canAccess(menu, role) {
  const who = role === undefined ? currentRole : role;
  if (menu === "setup") return who === "owner";
  if (menu === "store" || menu === "products") return STORE_ROLES.indexOf(who) >= 0;
  if (menu === "cash") return Boolean(document.getElementById("cashCollectedReport"));
  if (menu === "resellers") return Boolean(document.getElementById("resellerLedger"));
  if (menu === "homerouters") return homeRouters;
  return true;
}

export function activeAdminView(role) {
  const name = location.hash.slice(1).split("/")[0], view = ALIASES[name] || name;
  return VIEWS[view] && canAccess(VIEWS[view].menu, role) ? view : "home";
}

function eyebrow(view, lang) {
  const config = VIEWS[view];
  if (config.back) return "";
  if (view === "home") {
    const date = new Date().toLocaleDateString(lang, { weekday: "long", day: "numeric", month: "long" });
    return ROLES[currentRole] ? t(ROLES[currentRole], lang) + " · " + date : date;
  }
  return t(config.group, lang) + (config.ownerOnly ? " · " + t("adminOwnerOnly", lang) : "");
}

function renderMenu(view) {
  const host = document.getElementById("adminSideMenu");
  if (!host) return;
  clear(host).appendChild(renderAdminMenu({
    current: VIEWS[view].menu,
    canAccess: (menu) => canAccess(menu),
    hrefs: HREFS,
    homeHref: "/dashboard#home",
    badges,
    signOut: false,
    linkId: (id) => "admin-nav-" + id,
    lang: currentLanguage(),
  }));
  // v1 links also carried data-tab with the view name; older pages and tests use it.
  host.querySelectorAll("[data-admin-nav]").forEach((link) => { link.dataset.tab = link.dataset.adminNav === "setup" ? "network-setup" : link.dataset.adminNav; });
}

function apply(focus) {
  const view = activeAdminView(), config = VIEWS[view], lang = currentLanguage();
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => { panel.hidden = config.panels.indexOf(panel.dataset.tabPanel) < 0; });
  document.querySelectorAll("[data-admin-nav]").forEach((link) => {
    if (link.dataset.adminNav === config.menu) {
      link.setAttribute("aria-current", "page");
      // On phones the menu is one scrolling row; keep the current item in view.
      const row = link.closest(".nd-sidemenu__nav");
      if (row && row.scrollWidth > row.clientWidth) row.scrollLeft = Math.max(0, link.offsetLeft - (row.clientWidth - link.offsetWidth) / 2);
    } else link.removeAttribute("aria-current");
  });
  // Each screen's own buttons beside the title (marked data-head-view in app.js).
  document.querySelectorAll("[data-head-view]").forEach((action) => { action.hidden = action.dataset.headView !== view; });
  const title = document.getElementById("adminTitle"), label = document.getElementById("adminEyebrow");
  if (label) { label.textContent = eyebrow(view, lang); label.hidden = !label.textContent; }
  if (title) title.textContent = t(config.title, lang);
  // Sub-screens (canvas: "← Vouchers" above the title) link back to their screen.
  const back = document.getElementById("adminBack");
  if (back) {
    back.hidden = !config.back;
    if (config.back) {
      const name = t(config.back.label, lang);
      back.href = config.back.href;
      back.setAttribute("aria-label", format("adminBackTo", { page: name }, lang));
      back.innerHTML = '<span aria-hidden="true">← </span>';
      back.appendChild(document.createTextNode(name));
    }
  }
  setAdminHead({ lede: config.lede ? t(config.lede, lang) : "" });
  const section = config.section && document.getElementById(config.section);
  if (focus && section) section.scrollIntoView({ block: "start" });
  else if (focus && title) { window.scrollTo(0, 0); title.focus({ preventScroll: true }); }
  if (changed) changed(view);
}

// The part of the address after the view: the customer in #customer/<id>.
export function adminViewParam() {
  const hash = location.hash.slice(1), at = hash.indexOf("/");
  if (at < 0) return "";
  try { return decodeURIComponent(hash.slice(at + 1)); } catch { return ""; }
}

// A screen's own title and the line under it, when they depend on its data
// (for example "Print 20 vouchers"). Cleared whenever the view changes.
export function setAdminHead({ title, lede, avatar }) {
  const heading = document.getElementById("adminTitle"), line = document.getElementById("adminLede"), badge = document.getElementById("adminAvatar");
  if (title && heading) heading.textContent = title;
  if (line) { line.textContent = lede || ""; line.hidden = !lede; }
  if (badge) { badge.textContent = avatar || ""; badge.hidden = !avatar; }
}

// Counts shown on menu items (for example { payments: 2, store: 3 }).
export function setAdminBadges(next) {
  badges = next || {};
  if (mounted) renderMenu(activeAdminView());
}

// Shows the Home routers item once NDAHI Home is known to be in use.
export function showHomeRouters() {
  homeRouters = true;
  if (mounted) renderMenu(activeAdminView());
}

export function mountAdminNavigation(role, onChanged) {
  currentRole = role;
  changed = onChanged;
  renderMenu(activeAdminView());
  if (!mounted) {
    mounted = true;
    const side = document.querySelector(".nd-admin-shell__side");
    if (side) localize(side, currentLanguage());
    window.addEventListener("hashchange", () => { renderMenu(activeAdminView()); apply(true); });
    if (window.visualViewport) {
      const keyboard = () => document.body.classList.toggle("keyboard-open", innerHeight - window.visualViewport.height > 150 && Boolean(document.activeElement && document.activeElement.matches("input, textarea, select")));
      window.visualViewport.addEventListener("resize", keyboard);
      document.addEventListener("focusout", () => setTimeout(keyboard, 0));
    }
  }
  apply(false);
}
