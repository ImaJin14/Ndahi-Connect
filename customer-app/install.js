// Offers to install the portal as an app on a connected device. Browsers never
// install a site on their own: Chromium browsers show their install dialog
// after one tap, and iPhones add it from Safari's Share menu.
const storageKey = "ndahi-install", snoozeMs = 14 * 864e5;
let deferred = null, target = null;

if (typeof window !== "undefined") {
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }).catch(() => {});
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
}

export const installed = () => typeof window !== "undefined" && ((typeof matchMedia !== "undefined" && matchMedia("(display-mode: standalone)").matches) || (typeof navigator !== "undefined" && navigator.standalone === true));
export const isIPhoneUserAgent = (ua, platform, maxTouchPoints) =>
  /iphone|ipad|ipod/i.test(ua || "") || (platform === "MacIntel" && (maxTouchPoints || 0) > 1);
export const iPhone = () => typeof navigator !== "undefined" && isIPhoneUserAgent(navigator.userAgent, navigator.platform, navigator.maxTouchPoints);
// Android's Wi-Fi sign-in popup and in-app browsers are WebViews, which cannot install apps.
export const webView = () => typeof navigator !== "undefined" && /; wv\)/.test(navigator.userAgent);
function remember(state) {
  try { localStorage.setItem(storageKey, JSON.stringify({ state, at: Date.now() })); } catch { /* Storage may be unavailable. */ }
}
export function settled() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || "null");
    return Boolean(saved && (["dismissed", "installed"].includes(saved.state) && Number.isFinite(saved.at) && Date.now() >= saved.at && Date.now() - saved.at < snoozeMs));
  } catch { return false; }
}

export const copy = {
  prompt: "Open your bundle, data and devices straight from your home screen.",
  iphone: "Tap the Share button in Safari, then Add to Home Screen. Installation is optional. You may need to sign in again; Wi-Fi access is checked separately.",
  webview: "Keep using Wi-Fi sign-in here, or open portal.ndahiconnect.net in your normal browser for optional installation. You may need to sign in again.",
  browser: "Keep using this website, or look for Install app / Add to Home Screen in your browser menu if supported. Installation is optional.",
};

export function getInstallMode(options) {
  const opts = options || {};
  if (opts.installed || opts.settled) return null;
  if (opts.webView) return "webview";
  if (opts.deferred) return "prompt";
  if (opts.iPhone) return "iphone";
  return "browser";
}

function render() {
  if (!target || !target.isConnected) return;
  const mode = getInstallMode({
    installed: installed(),
    settled: settled(),
    deferred: Boolean(deferred),
    iPhone: iPhone(),
    webView: webView(),
  });
  target.hidden = !mode;
  if (!mode) return target.replaceChildren();
  const stepHelp = mode === "iphone"
    ? `<div class="install-steps"><span class="step-badge">1</span> Tap <strong>Share</strong> <span class="step-badge">2</span> Tap <strong>Add to Home Screen</strong></div>`
    : "";
  target.innerHTML = `<div class="install-card"><img src="/assets/icons/icon-192.png" alt="" width="48" height="48"><div class="install-copy"><strong>Install NDAHI Connect</strong><p>${copy[mode]}</p>${stepHelp}</div><div class="install-actions">${mode === "prompt" ? '<button type="button" data-install-app>Install app</button>' : ""}<button type="button" class="secondary-action" data-install-dismiss>Not now</button></div></div>`;
  target.querySelector("[data-install-dismiss]").onclick = () => { remember("dismissed"); render(); };
  const install = target.querySelector("[data-install-app]");
  if (install) install.onclick = async () => {
    const prompt = deferred;
    deferred = null;
    install.disabled = true;
    try {
      await prompt.prompt();
      const { outcome } = await prompt.userChoice;
      remember(outcome === "accepted" ? "installed" : "dismissed");
      if (outcome === "accepted") { target.hidden = true; target.replaceChildren(); return; }
    } catch { remember("dismissed"); /* A rejected prompt never blocks web use. */ }
    render();
  };
}

export function mountInstallCard(element) {
  target = element;
  render();
}
