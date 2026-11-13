// Portal and admin navigation built from the kit. Routing stays with the
// page: pass `hrefs` to point tabs at real routes (defaults are hash routes).
import { format, t } from "../i18n.js";
import { currentLanguage, h } from "./dom.js";
import { icon } from "./icons.js";

// The wordmark is the logo, so it is not translated.
const BRAND_NAME = "NDAHI";

export function renderBrand(options) {
  const settings = options || {};
  return h(settings.href ? "a" : "span", {
    class: "nd-brand" + (settings.large ? " nd-brand--lg" : ""),
    href: settings.href,
  },
  h("span", { class: "nd-brand__mark", "aria-hidden": "true", text: "NC" }),
  h("span", { class: "nd-brand__words" },
    h("strong", { class: "nd-brand__name", text: BRAND_NAME }),
    settings.tag ? h("small", { class: "nd-brand__tag", text: settings.tag }) : null));
}

// ---------- Customer portal ----------
export const PORTAL_TABS = ["home", "internet", "shop", "activity", "account"];
const TAB_LABELS = { home: "uiTabHome", internet: "uiTabInternet", shop: "uiTabShop", activity: "uiTabActivity", account: "uiTabAccount" };
const TAB_ICONS = { home: "home", internet: "internet", shop: "shop", activity: "activity", account: "account" };

function tabHref(hrefs, id) {
  return (hrefs && hrefs[id]) || "#" + id;
}

const NETWORK_LABELS = { online: "networkOnline", degraded: "networkDegraded", offline: "networkOffline", maintenance: "maintenance", unknown: "unavailable" };

// Dot + label, for example "Network online". `status` is one of online,
// degraded, offline, maintenance or unknown.
export function renderNetworkStatus(status, lang) {
  const state = NETWORK_LABELS[status] ? status : "unknown";
  return h("span", { class: "nd-status", "data-network-status": state },
    h("span", { class: "nd-dot" + (state === "online" ? "" : " nd-dot--" + state), "aria-hidden": "true" }),
    h("span", { text: t(NETWORK_LABELS[state], lang || currentLanguage()) }));
}

export function notificationsLabel(count, lang) {
  return count > 0 ? format("uiNotificationsNew", { count }, lang) : t("uiNotifications", lang);
}

// The five portal links, for a <nav class="nd-topnav__links">. The same links
// are the bottom tab bar on phones and the header links from 768px.
//   renderPortalTabs({ current: "home", hrefs: { home: "/dashboard#home" },
//                      badges: { activity: { count: 1, label: "1 payment awaiting confirmation" } } })
// A badge shows its count on the icon; its label is added to the link's name.
export function renderPortalTabs(options) {
  const settings = options || {};
  const lang = settings.lang || currentLanguage();
  const badges = settings.badges || {};
  return PORTAL_TABS.map((id) => {
    const label = t(TAB_LABELS[id], lang), badge = badges[id];
    const count = badge ? Number(badge.count) || 0 : 0;
    return h("a", {
      class: "nd-topnav__link",
      href: tabHref(settings.hrefs, id),
      "aria-current": id === settings.current ? "page" : null,
      "aria-label": count > 0 && badge.label ? label + ", " + badge.label : null,
      "data-portal-tab": id,
    },
    h("span", { class: "nd-topnav__icon" }, icon(TAB_ICONS[id]),
      count > 0 ? h("span", { class: "nd-topnav__badge", "aria-hidden": "true", text: count > 99 ? "99+" : String(count) }) : null),
    h("span", { class: "nd-topnav__label", text: label }));
  });
}

// The whole header for pages built in JavaScript. Pages written in HTML can
// keep the header in markup and fill its nav with renderPortalTabs().
//   renderPortalHeader({ current: "home", homeHref: "/dashboard", network: "online",
//                        notifications: { count: 2, href: "/notifications" }, actions: [button] })
// phoneBar: true keeps a slim forest bar (brand and actions) above the content
// on phones; without it, phones show only the tab bar.
export function renderPortalHeader(options) {
  const settings = options || {};
  const lang = settings.lang || currentLanguage();
  const notifications = settings.notifications || null;
  return h("header", { class: "nd-topnav" + (settings.phoneBar ? " nd-topnav--phone-bar" : "") },
    h("div", { class: "nd-topnav__inner" },
      renderBrand({ href: settings.homeHref || tabHref(settings.hrefs, "home"), tag: "CONNECT" }),
      h("nav", { class: "nd-topnav__links", id: settings.navId, "aria-label": t("uiNavMain", lang) },
        renderPortalTabs({ current: settings.current, hrefs: settings.hrefs, badges: settings.badges, lang })),
      h("div", { class: "nd-topnav__aside" },
        settings.network ? renderNetworkStatus(settings.network, lang) : null,
        notifications ? h("a", {
          class: "nd-icon-btn nd-icon-btn--on-forest nd-icon-btn--outlined",
          href: notifications.href,
          "aria-label": notificationsLabel(notifications.count || 0, lang),
        }, icon("bell", { size: 18 }), notifications.count > 0 ? h("span", { class: "nd-icon-btn__dot", "aria-hidden": "true" }) : null) : null,
        settings.actions || null)));
}

// ---------- Admin ----------
// Item ids follow the admin canvas (AdminSide.dc.html).
export const ADMIN_MENU = [
  { group: null, items: ["home"] },
  { group: "uiAdminGroupNetwork", items: ["devices", "connections", "homerouters", "setup"] },
  { group: "uiAdminGroupSales", items: ["bundles", "vouchers", "payments", "store", "products", "cash"] },
  { group: "uiAdminGroupPeople", items: ["customers", "resellers"] },
  { group: "uiAdminGroupSystem", items: ["audit", "profile"] },
];
const ADMIN_LABELS = {
  home: "uiAdminHome", devices: "uiAdminDevices", connections: "uiAdminConnections", homerouters: "uiAdminHomeRouters",
  setup: "uiAdminNetworkSetup", bundles: "uiAdminBundles", vouchers: "uiAdminVouchers", payments: "uiAdminPayments",
  store: "uiAdminStore", products: "uiAdminProducts", cash: "uiAdminCash", customers: "uiAdminCustomers",
  resellers: "uiAdminResellers", audit: "uiAdminAudit", profile: "uiAdminProfile",
};

// renderAdminMenu({ current: "payments", canAccess: (id) => …, badges: { payments: 2 },
//                   hrefs: { payments: "/dashboard#payments" }, onSignOut })
// canAccess carries the role rules (they stay in admin-app navigation.js).
// Without onSignOut, sign-out is a link to signOutHref; signOut: false leaves
// it out for pages that keep their own sign-out control. linkId(id) sets each
// link's id (for example "admin-nav-" + id, which older pages and tests use).
export function renderAdminMenu(options) {
  const settings = options || {};
  const lang = settings.lang || currentLanguage();
  const allowed = settings.canAccess || (() => true);
  const badges = settings.badges || {};
  const groups = ADMIN_MENU.map((section, index) => {
    const items = section.items.filter((id) => allowed(id));
    if (!items.length) return null;
    const headingId = section.group ? "nd-admin-group-" + index : null;
    return [
      section.group ? h("p", { class: "nd-sidemenu__group", id: headingId, text: t(section.group, lang) }) : null,
      h("ul", { class: "nd-sidemenu__list", "aria-labelledby": headingId },
        items.map((id) => {
          const count = Number(badges[id]) || 0, label = t(ADMIN_LABELS[id], lang);
          return h("li", null, h("a", {
            class: "nd-sidemenu__item",
            href: (settings.hrefs && settings.hrefs[id]) || "#" + id,
            "aria-current": id === settings.current ? "page" : null,
            // "Payments, 2 need attention": keeps the visible label first.
            "aria-label": count > 0 ? label + ", " + format("uiAttention", { count }, lang) : null,
            id: settings.linkId ? settings.linkId(id) : null,
            "data-admin-nav": id,
          }, label, count > 0 ? h("span", { class: "nd-badge", "aria-hidden": "true", text: String(count) }) : null));
        })),
    ];
  });
  const signOut = settings.signOut === false ? null : settings.onSignOut
    ? h("button", { type: "button", class: "nd-sidemenu__signout", onClick: settings.onSignOut, text: t("uiSignOut", lang) })
    : h("a", { class: "nd-sidemenu__signout", href: settings.signOutHref || "/login", text: t("uiSignOut", lang) });
  return h("div", { class: "nd-sidemenu" },
    h("div", { class: "nd-sidemenu__brand" }, renderBrand({ href: settings.homeHref || (settings.hrefs && settings.hrefs.home) || "#home", tag: "ADMIN" })),
    h("nav", { class: "nd-sidemenu__nav", "aria-label": t("uiAdminNav", lang) }, groups),
    signOut);
}

// Back button for .nd-topbar. Pass href for a link, or onClick for a button.
export function renderBackButton(options) {
  const settings = options || {};
  const lang = settings.lang || currentLanguage();
  return h(settings.href ? "a" : "button", {
    class: "nd-icon-btn",
    href: settings.href,
    type: settings.href ? null : "button",
    "aria-label": settings.label || t("uiBack", lang),
    onClick: settings.onClick,
  }, icon("back", { strokeWidth: 2 }));
}
