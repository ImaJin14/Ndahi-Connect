import { routerLoginUrl } from "./wifi-completion.js";

// This public fallback is not an account session or evidence of a live connection.
// Do not auto-navigate back to /login: a saved tab must never become a loop.
const login = routerLoginUrl(window.NDAHI_CONFIG.hotspotLoginUrl);
if (login) {
  const link = document.getElementById("wifiSignIn");
  link.href = login.href; link.hidden = false;
}
