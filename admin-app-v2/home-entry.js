// Discover Home only after the dashboard identifies an authorized role.
import { showHomeRouters } from "./navigation.js";
export async function updateHomeRouterMenu(role, call) {
  if (role !== "owner" && role !== "operator") return;
  try {
    const info = await call("/api/admin/home");
    if (info.enabled || info.households?.length) showHomeRouters();
  } catch { /* Optional discovery does not block the dashboard. */ }
}
