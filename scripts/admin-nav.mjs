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

// The name of a v1 admin link on the version under test, for example
// adminLinkName("Devices"). On v2 a menu item with a count is named
// "Store orders, 3 need attention", so v2 gets a pattern that allows it.
export function adminLinkName(name) {
  if (!uiV2) return name;
  const label = (V2_NAMES[name] || name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${label}(, \\d+ need attention)?$`);
}

// The sign-out button: "Logout" in v1's header, "Sign out" in the v2 side menu.
export const adminSignOutName = uiV2 ? "Sign out" : "Logout";

// Opens a view that v1 keeps under More.
export async function openAdminMore(page, tab) {
  if (uiV2) {
    await page.getByRole("link", { name: V2_MORE[tab], exact: true }).click();
    if (tab === "Generate voucher") {
      await page.locator("#panel-vouchers").waitFor({ state: "visible" });
      await page.locator("#generate").waitFor({ state: "attached" });
      if (await page.getByRole("tab", { name: "Batch to print or sell", exact: true }).count()) await page.getByRole("tab", { name: "Batch to print or sell", exact: true }).click();
    }
    return;
  }
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

// Vouchers (v2 canvas: AdminVouchers, AdminVoucherPrint). The create button
// counts its vouchers ("Create 20 vouchers"); purpose, sale type and custom
// bundles sit under More options; a batch prints on its own screen, reached
// with Print slips and left with the "← Vouchers" link.
export function adminGenerateName(kind = "resale") {
  if (!uiV2) return kind === "resale" ? "Generate resale vouchers" : "Generate assigned voucher";
  return kind === "resale" ? /^Create \d+ vouchers?$/ : "Create and assign voucher";
}
export async function openVoucherOptions(page) {
  if (uiV2 && !(await page.locator("#voucherOptions").evaluate((details) => details.open))) await page.locator("#voucherOptions > summary").click();
}
export async function openGeneratedPrint(page) {
  if (uiV2) await page.getByRole("link", { name: /^Print slips?$/, exact: true }).click();
}
export const printVouchersName = (count) => (!uiV2 ? "Print vouchers" : count === 1 ? "Print 1 slip" : `Print ${count} slips`);
export async function closeGeneratedCodes(page) {
  if (uiV2 && (await page.locator("#adminBack:not([hidden])").count())) await page.getByRole("link", { name: "Back to Vouchers", exact: true }).click();
  await page.getByRole("button", { name: "Close codes", exact: true }).click();
}
// Customers (v2 canvas: AdminCustomers, AdminCustomerDetail): printing a
// customer's voucher and PIN recovery are support actions on their detail page.
export async function openAdminCustomer(page, id) {
  if (uiV2) await page.locator(`a.admin-name[href$="#customer/${encodeURIComponent(id)}"]`).click();
}
export const adminCustomerPath = (id) => (uiV2 ? `customer/${encodeURIComponent(id)}` : "customers");

// v2 moves the reseller ledger from Vouchers to its own Resellers screen.
export const resellerLedgerView = uiV2 ? "resellers" : "vouchers";

// Phase 6 (canvas: AdminLogin): v2 staff sign in with email + PIN (the username
// still works in the email field), then a passkey; v1 keeps its labels.
export const adminIdentifierLabel = uiV2 ? "Email" : "Username";
