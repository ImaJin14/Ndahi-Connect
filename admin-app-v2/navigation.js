// Redesigned admin navigation (admin-app-v2): the grouped side menu from the
// design kit (Network · Sales · People · System) and the page head (eyebrow and
// title from each canvas screen).
//
// Panels keep their v1 names (data-tab-panel). Each menu item shows the panels
// that hold its screen today, and v1 addresses still land: #more opens Profile
// (the install prompt moved there), #voucher-create opens Vouchers.
import { t } from "/shared/i18n.js";
import { clear, currentLanguage, localize } from "/shared/ui/dom.js";
import { ADMIN_MENU, renderAdminMenu } from "/shared/ui/navigation.js";

// view -> menu item, panels shown, optional section to scroll to, title, eyebrow group.
const VIEWS = {
  home: { menu: "home", panels: ["home"], title: "adminTitleHome" },
  devices: { menu: "devices", panels: ["devices"], title: "adminTitleDevices", group: "uiAdminGroupNetwork" },
  connections: { menu: "connections", panels: ["connections"], title: "adminTitleConnections", group: "uiAdminGroupNetwork" },
  "network-setup": { menu: "setup", panels: ["network-setup"], title: "adminTitleSetup", group: "uiAdminGroupNetwork", ownerOnly: true },
  bundles: { menu: "bundles", panels: ["bundles"], title: "adminTitleBundles", group: "uiAdminGroupSales" },
  vouchers: { menu: "vouchers", panels: ["vouchers", "voucher-create"], title: "adminTitleVouchers", group: "uiAdminGroupSales" },
  payments: { menu: "payments", panels: ["payments"], title: "adminTitlePayments", group: "uiAdminGroupSales" },
  store: { menu: "store", panels: ["store"], title: "adminTitleStore", group: "adminGroupStore" },
  products: { menu: "products", panels: ["store"], title: "adminTitleProducts", group: "adminGroupStore" },
  cash: { menu: "cash", panels: ["payments"], section: "cashCollectedReport", title: "adminTitleCash", group: "uiAdminGroupSales" },
  customers: { menu: "customers", panels: ["customers"], title: "adminTitleCustomers", group: "uiAdminGroupPeople" },
  resellers: { menu: "resellers", panels: ["vouchers"], section: "resellerLedger", title: "adminTitleResellers", group: "uiAdminGroupPeople" },
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

let mounted = false, currentRole, changed, homeRouters = false;

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
  const hash = location.hash.slice(1), view = ALIASES[hash] || hash;
  return VIEWS[view] && canAccess(VIEWS[view].menu, role) ? view : "home";
}

function eyebrow(view, lang) {
  const config = VIEWS[view];
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
    signOut: false,
    linkId: (id) => "admin-nav-" + id,
    lang: currentLanguage(),
  }));
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
  const title = document.getElementById("adminTitle"), label = document.getElementById("adminEyebrow");
  if (label) label.textContent = eyebrow(view, lang);
  if (title) title.textContent = t(config.title, lang);
  const section = config.section && document.getElementById(config.section);
  if (focus && section) section.scrollIntoView({ block: "start" });
  else if (focus && title) { window.scrollTo(0, 0); title.focus({ preventScroll: true }); }
  if (changed) changed(view);
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
