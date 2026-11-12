// Discover Home only after the dashboard identifies an authorized role.
import { showHomeRouters } from "./navigation.js";
export async function updateHomeRouterMenu(role, api) {
  if (role !== "owner" && role !== "operator") return;
  try {
    // This optional probe must not invoke the dashboard's setup/login redirect
    // when Home is temporarily unavailable.
    const response = await fetch(api + "/api/admin/home", { credentials: "include" });
    if (!response.ok) return;
    const info = await response.json();
    if (info.enabled || info.households?.length) showHomeRouters();
  } catch { /* Optional discovery does not block the dashboard. */ }
}
