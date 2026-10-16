// Offers to install the portal as an app on a connected device. Browsers never
// install a site on their own: Chromium browsers show their install dialog
// after one tap, and iPhones add it from Safari's Share menu.
const storageKey = "ndahi-install", snoozeMs = 14 * 864e5;
let deferred = null, target = null;

if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferred = event;
  render();
});
window.addEventListener("appinstalled", () => {
  deferred = null;
  remember("installed");
  render();
});

const installed = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
const iPhone = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
// Android's Wi-Fi sign-in popup and in-app browsers are WebViews, which cannot install apps.
const webView = () => /; wv\)/.test(navigator.userAgent);
function remember(state) {
  try { localStorage.setItem(storageKey, JSON.stringify({ state, at: Date.now() })); } catch { /* Storage may be unavailable. */ }
}
function settled() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    return saved?.state === "installed" || (saved?.state === "dismissed" && Date.now() - saved.at < snoozeMs);
  } catch { return false; }
}

const copy = {
  prompt: "Open your bundle, data and devices straight from your home screen.",
  iphone: "Tap the Share button, then Add to Home Screen. On iPhone, usage alerts work once it's on your Home Screen.",
  webview: "Open portal.ndahiconnect.net in Chrome to install the app on this phone.",
};

function render() {
  if (!target?.isConnected) return;
  const mode = installed() || settled() ? null : deferred ? "prompt" : iPhone() ? "iphone" : webView() ? "webview" : null;
  target.hidden = !mode;
  if (!mode) return target.replaceChildren();
  target.innerHTML = `<div class="install-card"><img src="/assets/icons/icon-192.png" alt="" width="48" height="48"><div class="install-copy"><strong>Install NDAHI Connect</strong><p>${copy[mode]}</p></div><div class="install-actions">${mode === "prompt" ? '<button type="button" data-install-app>Install app</button>' : ""}<button type="button" class="secondary-action" data-install-dismiss>Not now</button></div></div>`;
  target.querySelector("[data-install-dismiss]").onclick = () => { remember("dismissed"); render(); };
  const install = target.querySelector("[data-install-app]");
  if (install) install.onclick = async () => {
    const prompt = deferred;
    deferred = null;
    await prompt.prompt();
    const { outcome } = await prompt.userChoice;
    remember(outcome === "accepted" ? "installed" : "dismissed");
    render();
  };
}

export function mountInstallCard(element) {
  target = element;
  render();
}
