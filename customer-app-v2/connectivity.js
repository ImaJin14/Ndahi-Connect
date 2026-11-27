import { requestJson } from './compat.js';
import { escapeHtml as h } from '/shared/safe-html.js';
import { networkBannerState, probeBrowserInternet } from './network-status.js';
import { setDeviceConnected } from './active-bundle.js';
import { t } from '/shared/i18n.js';
import { currentLanguage } from '/shared/ui/dom.js';

export async function fetchConnectivity(api, { signal } = {}) {
  const { response, body } = await requestJson(api + '/api/account/connectivity', { credentials: 'include', cache: 'no-store', signal }, 6000);
  if (!response.ok || body.version !== 1) throw Error('Network verification is unavailable.');
  return body;
}
export function mountConnectivityBanner({ container, api }) {
  if (!container) return () => {};
  let stopped = false, timer, inFlight = false, controller, generation = 0;
  const render = value => {
    if (stopped || !container.isConnected) return;
    const view = networkBannerState({ connectivity: value });
    // Home's Unlimited card says "Connected" only while the network confirms this device (#352).
    const connected = Boolean(value && value.network && value.network.state === 'confirmed' && value.hotspot && value.hotspot.state === 'authenticated');
    setDeviceConnected(connected); window.dispatchEvent(new CustomEvent('ndahi:device-connected', { detail: connected }));
    container.className = 'network-state-banner network-state-banner-' + view.status;
    // Fully online (#352, canvas PhoneHome): just "Network online", as drawn; desktop
    // already shows it in the top bar, so the banner hides there (CSS). Every other
    // state keeps its explanation and next step.
    if (view.status === 'active') container.innerHTML = `<div class="network-banner-indicator" aria-hidden="true"></div><div class="network-banner-text"><span class="network-banner-badge">${h(t('homeNetworkOnline', currentLanguage()))}</span></div>`;
    else container.innerHTML = `<div class="network-banner-indicator" aria-hidden="true"></div><div class="network-banner-text"><span class="network-banner-badge">${h(view.badge)}</span><span class="network-banner-message">${h(view.message)}</span></div>${view.actionHref ? `<a class="network-banner-action" href="${h(view.actionHref)}">${h(view.actionText)}</a>` : ''}`;
  };
  const refresh = async () => {
    clearTimeout(timer);
    if (stopped || inFlight || document.hidden || navigator.onLine === false || !container.isConnected) return;
    const expected = generation;
    inFlight = true; controller = typeof AbortController === 'function' ? new AbortController() : null;
    try {
      const value = await fetchConnectivity(api, { signal: controller ? controller.signal : undefined });
      // An independent public read checks only the browser's internet path.
      // It never establishes Wi-Fi association, paid access or purchase eligibility.
      if (value.hotspot.state === 'authenticated') value.internet = await probeBrowserInternet({ signal: controller ? controller.signal : undefined });
      if (expected === generation) render(value);
    } catch (_) { if (expected === generation) render(null); }
    finally { inFlight = false; if (!stopped && !document.hidden) timer = setTimeout(refresh, expected === generation ? 30000 : 0); }
  };
  const resume = () => { generation++; controller && controller.abort(); render(null); if (document.hidden || navigator.onLine === false) { clearTimeout(timer); controller && controller.abort(); render(null); } else void refresh(); };
  document.addEventListener('visibilitychange', resume); window.addEventListener('online', resume); window.addEventListener('offline', resume); window.addEventListener('pageshow', resume);
  void refresh();
  return () => { stopped = true; clearTimeout(timer); controller && controller.abort(); document.removeEventListener('visibilitychange', resume); for (const event of ['online','offline','pageshow']) window.removeEventListener(event, resume); };
}
