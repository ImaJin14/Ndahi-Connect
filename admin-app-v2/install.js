let promptEvent, target, appInstalled = false;
const installed = () => appInstalled || matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const apple = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
window.addEventListener("beforeinstallprompt", (event) => { event.preventDefault(); promptEvent = event; render(); });
window.addEventListener("appinstalled", () => { promptEvent = null; appInstalled = true; render(); });
function render() {
  if (!target?.isConnected) return;
  target.hidden = installed();
  if (target.hidden) return;
  const instructions = promptEvent ? "Open devices, vouchers and payments from your home screen."
    : apple() ? "Open this site in Safari, tap Share, then Add to Home Screen."
    : "Use your browser menu and choose Install app or Add to Home screen. If this is a Wi-Fi sign-in popup, open the admin site in your full browser first.";
  target.innerHTML = `<div class="admin-install"><img src="/assets/icons/icon-192.png" width="48" height="48" alt=""><div><h3>Install NDAHI Admin</h3><p>${instructions}</p></div>${promptEvent ? '<button type="button" data-install-admin>Install app</button>' : ""}</div>`;
  const button = target.querySelector("[data-install-admin]");
  if (button) button.onclick = async () => {
    const event = promptEvent;
    promptEvent = null;
    button.disabled = true;
    try { await event.prompt(); await event.userChoice; }
    finally { render(); }
  };
}
export function mountAdminInstall(element) { target = element; render(); }
