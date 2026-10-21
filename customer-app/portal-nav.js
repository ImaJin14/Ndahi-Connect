const tabs = [
  ["home", "Home", "M3 10 12 3l9 7v11h-6v-7H9v7H3Z"],
  ["bundles", "Bundles", "m12 3 9 5-9 5-9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"],
  ["vouchers", "Vouchers", "M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4Zm12 0v14"],
  ["payments", "Payments", "M4 3h16v19l-4-2-4 2-4-2-4 2Zm4 5h8M8 12h8M8 16h5"],
  ["account", "Account", "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 6 0 0 1 16 0v2"],
];
const aliases = { managePlan: "bundles", billing: "payments", accountSecurity: "account", sessionActivity: "account", sessions: "account" };
let mounted = false;
export function activePortalView() {
  const hash = location.hash.slice(1), view = aliases[hash] || hash;
  return tabs.some(([id]) => id === view) ? view : new URLSearchParams(location.search).get("setup") === "passkey" ? "account" : "home";
}
function applyView(scroll = false) {
  const view = activePortalView();
  document.querySelectorAll("[data-portal-view]").forEach((panel) => { panel.hidden = panel.dataset.portalView !== view; });
  document.querySelectorAll("[data-portal-tab]").forEach((link) => {
    if (link.dataset.portalTab === view) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
  const title = document.getElementById("portalTitle");
  if (title) title.textContent = { home: title.dataset.welcome || "Welcome back", bundles: "Your bundles.", vouchers: "Your voucher codes.", payments: "Your payments.", account: "Your account." }[view];
  if (["sessions", "sessionActivity"].includes(location.hash.slice(1))) {
    const sessions = document.getElementById("sessionActivity");
    if (sessions) { sessions.open = true; sessions.querySelector("summary")?.focus(); sessions.scrollIntoView({ block: "start" }); }
    return;
  }
  if (scroll) {
    window.scrollTo(0, 0);
    if (title) title.focus({ preventScroll: true });
  }
}
export function mountPortalNavigation(pending = 0, name) {
  if (name !== undefined) {
    const clean = String(name || "").trim();
    const first = clean.split(/\s+/)[0];
    document.getElementById("portalTitle").dataset.welcome = clean && !/^(customer|new customer|user|test customer)$/i.test(clean) ? `Welcome back, ${first}` : "Welcome back";
  }
  const nav = document.getElementById("portalNav");
  nav.innerHTML = tabs.map(([id, label, path]) => `<a href="/dashboard#${id}" data-portal-tab="${id}"><span class="nav-icon"><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"><path d="${path}"/></svg>${id === "payments" && pending ? `<span class="nav-badge" aria-hidden="true">${pending}</span>` : ""}</span><span>${label}${id === "payments" && pending ? `<span class="visually-hidden">, ${pending} payment${pending === 1 ? "" : "s"} awaiting confirmation</span>` : ""}</span></a>`).join("");
  nav.hidden = false;
  if (!mounted) {
    mounted = true;
    window.addEventListener("hashchange", () => applyView(true));
    if (window.visualViewport) {
      const keyboard = () => document.body.classList.toggle("keyboard-open", window.innerHeight - window.visualViewport.height > 150 &&
        Boolean(document.activeElement && document.activeElement.matches("input, textarea, select")));
      window.visualViewport.addEventListener("resize", keyboard);
      document.addEventListener("focusout", () => setTimeout(keyboard, 0));
    }
  }
  applyView();
}
