const primary = [
  ["home", "Home", "M3 10 12 3l9 7v11h-6v-7H9v7H3Z"],
  ["devices", "Devices", "M3 4h18v12H3Zm5 16h8M12 16v4"],
  ["vouchers", "Vouchers", "M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4Zm12 0v14"],
  ["payments", "Payments", "M4 3h16v19l-4-2-4 2-4-2-4 2Zm4 5h8M8 12h8M8 16h5"],
  ["more", "More", "M4 5h16M4 12h16M4 19h16"],
];
const secondary = ["connections", "network-setup", "bundles", "voucher-create", "customers", "audit"];
let mounted = false, currentRole, changed;
export function activeAdminView(role = currentRole) {
  const view = location.hash.slice(1);
  const allowed = [...primary.map(([id]) => id), ...secondary.filter((id) => id !== "network-setup" || role === "owner")];
  return allowed.includes(view) ? view : "home";
}
function apply(focus = false) {
  const view = activeAdminView(), group = secondary.includes(view) ? "more" : view;
  document.querySelectorAll("[data-tab-panel]").forEach((panel) => { panel.hidden = panel.dataset.tabPanel !== view; });
  document.querySelectorAll("[data-admin-more]").forEach((menu) => { menu.hidden = group !== "more"; });
  document.querySelectorAll("[data-admin-nav]").forEach((link) => {
    if (link.dataset.adminNav === group) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  document.querySelectorAll('[role="tab"][data-tab]').forEach((tab) => {
    tab.setAttribute("aria-selected", String(tab.dataset.tab === view));
    tab.tabIndex = tab.dataset.tab === view || view === "more" ? 0 : -1;
  });
  const title = document.getElementById("adminTitle");
  if (title) {
    title.textContent = { home: "Your operations.", devices: "Live Wi-Fi devices.", vouchers: "Your vouchers.", payments: "Payments and revenue." }[view] || "Administration.";
    if (focus) { window.scrollTo(0, 0); title.focus({ preventScroll: true }); }
  }
  changed?.(view);
}
export function mountAdminNavigation(role, onChanged) {
  currentRole = role;
  changed = onChanged;
  const nav = document.getElementById("adminNav");
  nav.innerHTML = primary.map(([id, label, path]) => `<a id="admin-nav-${id}" href="/dashboard#${id}" data-admin-nav="${id}" data-tab="${id}"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="${path}"/></svg><span>${label}</span></a>`).join("");
  nav.hidden = false;
  const tabs = [...document.querySelectorAll('[role="tab"][data-tab]')];
  tabs.forEach((tab, index) => {
    tab.onclick = () => { location.hash = tab.dataset.tab; };
    tab.onkeydown = (event) => {
      if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
      location.hash = tabs[next].dataset.tab;
      tabs[next].focus();
    };
  });
  if (!mounted) {
    mounted = true;
    window.addEventListener("hashchange", () => apply(true));
    if (window.visualViewport) {
      const keyboard = () => document.body.classList.toggle("keyboard-open", innerHeight - window.visualViewport.height > 150 && Boolean(document.activeElement?.matches("input, textarea, select")));
      window.visualViewport.addEventListener("resize", keyboard);
      document.addEventListener("focusout", () => setTimeout(keyboard, 0));
    }
  }
  apply();
}
