// Admin navigation for browser journeys that run on both UI versions.
//   v1: a tab strip (Home · Store · Devices · Vouchers · Payments · Customers ·
//       Bundles · Connections · More) with Network setup, Generate voucher and
//       Audit as tabs under More.
//   v2 (redesign): the grouped side menu. Those three are menu items there
//       (generating vouchers is part of Vouchers), and some links are renamed.
// scripts/ui-v2-journeys.mjs sets NDAHI_UI_VARIANT=v2 for `npm run test:browser:v2`.
export const uiV2 = process.env.NDAHI_UI_VARIANT === "v2";

const V2_NAMES = { Devices: "Live devices", Store: "Store orders", Audit: "Audit log" };
const V2_MORE = { "Network setup": "Network setup", "Generate voucher": "Vouchers", Audit: "Audit log" };

// The v2 name of a v1 admin link, for example adminLinkName("Devices").
export function adminLinkName(name) {
  return uiV2 ? V2_NAMES[name] || name : name;
}

// The sign-out button: "Logout" in v1's header, "Sign out" in the v2 side menu.
export const adminSignOutName = uiV2 ? "Sign out" : "Logout";

// Opens a view that v1 keeps under More.
export async function openAdminMore(page, tab) {
  if (uiV2) return page.getByRole("link", { name: V2_MORE[tab], exact: true }).click();
  await page.getByRole("link", { name: "More", exact: true }).click();
  await page.getByRole("tab", { name: tab, exact: true }).click();
}

// How many of the More views this role can open (v1: tabs under More; v2: menu links).
export async function adminMoreCount(page, tab) {
  if (uiV2) return page.getByRole("link", { name: V2_MORE[tab], exact: true }).count();
  await page.getByRole("link", { name: "More", exact: true }).click();
  // Hidden tabs have no role, so wait until the More section is showing.
  await page.locator("[data-admin-more]").waitFor();
  return page.getByRole("tab", { name: tab, exact: true }).count();
}
