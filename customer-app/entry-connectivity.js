import { mountConnectivityBanner } from './connectivity.js';
// Optional presentation only: never redirects a checkout or blocks sign-in.
const mount = () => mountConnectivityBanner({ container: document.getElementById('entryConnectivity'), api: window.NDAHI_CONFIG.apiUrl });
let stop = mount();
window.addEventListener('pagehide', () => stop());
window.addEventListener('pageshow', event => { if (event.persisted) stop = mount(); });
