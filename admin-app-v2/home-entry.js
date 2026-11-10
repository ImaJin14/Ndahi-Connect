// Shows "Home routers" in the side menu when NDAHI Home is in use.
import { showHomeRouters } from "./navigation.js";
const api = window.NDAHI_CONFIG && window.NDAHI_CONFIG.apiUrl;
if (api) fetch(api + "/api/admin/home", { credentials: "include" }).then(async (response) => {
  if (!response.ok) return;
  const info = await response.json();
  if (info.enabled || info.households.length) showHomeRouters();
}).catch(() => {});
