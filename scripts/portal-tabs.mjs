// Portal navigation selectors for browser journeys that run on both UI versions.
//   v1: Home · Bundles · Vouchers · Payments · Account, a side rail from 1000px.
//   v2 (redesign): Home · Internet · Shop · Activity · Account, in the header from
//   768px. Bundles and Vouchers live under Internet, Payments under Activity.
// scripts/ui-v2-journeys.mjs sets NDAHI_UI_VARIANT=v2 for `npm run test:browser:v2`.
export const uiV2 = process.env.NDAHI_UI_VARIANT === "v2";
// Use a bundle from another phone (#407): v2 types the owner's pairing code,
// fetched here from the owner's signed-in page; v1 keeps the number and voucher.
export async function pairingCodeFrom(owner) {
  const api = await owner.evaluate(() => window.NDAHI_CONFIG.apiUrl);
  return owner.evaluate(async (base) => {
    const { csrfToken } = await (await fetch(base + "/api/account/dashboard", { credentials: "include" })).json();
    const reply = await fetch(base + "/api/account/device-management/pairing/code", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrfToken }, body: "{}" });
    const body = await reply.json(); if (!reply.ok) throw Error(body.error || "No pairing code");
    return body.code;
  }, api);
}
export async function fillPairingRequest(page, { owner, phone, code }) {
  if (uiV2) await page.getByLabel("Pairing code", { exact: true }).fill(await pairingCodeFrom(owner));
  else { await page.getByLabel("Account phone number", { exact: true }).fill(phone); await page.getByLabel("Active voucher code", { exact: true }).fill(code); }
}
export const pairingSubmitName = uiV2 ? "Send request" : "Request access";
// v2's waiting screen is ready once its reference shows (a throttled read shows the title first).
export const waitForOwnerApproval = (page) => uiV2 ? page.getByLabel("Matching request code", { exact: true }).filter({ hasText: /^PR-/ }).waitFor()
  : page.locator("#pairingStatus").filter({ hasText: /waiting for your main device/i }).waitFor();
// Your saved voucher (#367, owner: exactly as drawn): v2 shows Print slip and
// "Use it on this device now"; v1 keeps Download Voucher and "Continue to Dashboard / Wi-Fi".
export const savedVoucherReady = (page) => (uiV2 ? page.getByRole("link", { name: "Print slip", exact: true })
  : page.getByRole("button", { name: "Download Voucher", exact: true })).waitFor();
export const continueFromSavedVoucher = (page) => (uiV2 ? page.getByRole("link", { name: "Use it on this device now", exact: true })
  : page.getByRole("link", { name: "Continue to Dashboard / Wi-Fi", exact: true })).click();

const V2_TABS = { bundles: "internet", vouchers: "internet", payments: "activity" };

// The tab that shows a v1 view, for example portalTab("payments").
export function portalTab(view) {
  return `[data-portal-tab="${uiV2 ? V2_TABS[view] || view : view}"]`;
}

// The count badge on that tab.
export function portalTabBadge(view) {
  return `${portalTab(view)} ${uiV2 ? ".nd-topnav__badge" : ".nav-badge"}`;
}

// Viewport width from which the nav is no longer the bottom bar.
export const portalNavDesktopWidth = uiV2 ? 768 : 1000;

// Opens a v1 view by its tab. v2 phones show Internet's Bundles or Vouchers one
// at a time (canvas: PhoneInternet), so Vouchers also needs its switch.
// v2 pages within a tab hide the tab bar on phones (canvas), so leave the page
// by its back arrow first, as a person would.
export async function openPortalView(page, view) {
  const tab = page.locator(portalTab(view));
  if (uiV2 && !(await tab.isVisible()) && await page.locator("body[data-portal-sub]").count()) {
    await page.locator(".portal-sub__back:visible").first().click();
    await page.locator("body:not([data-portal-sub])").waitFor({ state: "attached" });
  }
  await tab.click();
  if (!uiV2 || view !== "vouchers") return;
  await page.locator(`${portalTab(view)}[aria-current="page"]`).waitFor();
  const toggle = page.locator('[data-internet-switch="vouchers"]');
  if (await toggle.isVisible()) {
    await toggle.click();
    await page.locator('[data-internet-switch="vouchers"][aria-current="page"]').waitFor();
  }
}

// v2 Account is a hub; each section opens as its own page (canvas). These open
// a section the way each version shows it, so one journey runs on both.
// Closing a page's section sends it back to its tab on the close event, which can
// land after a journey's next navigation; a person is never that fast, so retry.
async function openPage(page, hash, details) {
  for (let attempt = 1; ; attempt++) {
    await page.evaluate((target) => {
      if (location.hash === `#${target}`) window.dispatchEvent(new HashChangeEvent("hashchange"));
      else location.hash = target;
    }, hash);
    if (!details) return;
    try { return await page.locator(`#${details}[open]`).waitFor({ timeout: attempt < 3 ? 3000 : undefined }); }
    catch (error) { if (attempt >= 3) throw error; }
  }
}

// The PIN / passkeys / recovery manager (v1: the "Manage PIN / Passkey" summary).
export async function openSecurityManager(page) {
  if (uiV2) return openPage(page, "accountSecurity", "securityManager");
  await page.locator("#securityManager>summary").click();
}

// The profile form (v1: the "Edit profile" summary).
export async function openEditProfile(page) {
  if (uiV2) return openPage(page, "editProfile", "editProfile");
  await page.getByText("Edit profile", { exact: true }).click();
}

// Manage devices (v1: the Home disclosure; v2: its own page).
export async function openManageDevices(page) {
  if (uiV2) return openPage(page, "devices", "manageDevices");
  const details = page.locator("#manageDevices");
  if (!(await details.evaluate((node) => node.open))) await page.locator("#manageDevices > summary").click();
}

// Signed-in devices (v1: the "Active sessions" summary under Account).
export async function openSessions(page) {
  if (uiV2) return openPage(page, "sessions", "sessionActivity");
  await page.locator("#sessionActivity summary").click();
}

// Account settings have opened: v2's hub, or v1's PIN & passkeys section.
export async function waitForAccount(page) {
  if (uiV2) await page.locator("#accountHubTitle").waitFor();
  else await page.getByRole("heading", { name: "PIN & passkeys", exact: true }).waitFor();
}

// Notification settings (v1: a button in Account; v2: the Notifications page).
export async function manageNotificationSettings(page) {
  if (uiV2) await openPage(page, "notificationSettings");
  await page.getByRole("button", { name: "Manage notification settings", exact: true }).click();
}

// The notification bell. v2 phones show it in Home's brand bar only (canvas:
// PhoneHome); other phone pages have a title bar, so open it from Home.
export async function openNotifications(page) {
  const bell = page.getByRole("button", { name: /^Notifications/ });
  if (uiV2 && !(await bell.isVisible())) await openPage(page, "home");
  await bell.click();
}

// Security history: v1's "View security history" on Signed-in devices; v2 has
// no such button (canvas: PhoneSessions, #413), so it opens Notifications on
// Security, All.
export async function openSecurityHistory(page) {
  if (!uiV2) { await openSessions(page); return page.getByRole("button", { name: "View security history", exact: true }).click(); }
  await openNotifications(page);
  const panel = page.getByRole("dialog", { name: "Notifications", exact: true });
  await panel.locator("[data-notification-view]").selectOption("all");
  await panel.locator("[data-notification-category]").selectOption("security");
}

// v2 sign-in leads with phone + PIN (Phase 6, canvas: PhoneLogin); journeys
// that sign in with a voucher code switch to that path first.
export async function useVoucherSignIn(page) {
  if (!uiV2) return;
  // The mode attribute is set after login.js binds the mode buttons. A link
  // navigation can expose the HTML before then; an initially hidden toggle
  // does not mean the voucher path is already selected.
  const body = page.locator("body[data-login-mode]");
  await body.waitFor({ state: "attached" });
  const toggle = page.locator("#useVoucherCode");
  if (await body.getAttribute("data-login-mode") !== "voucher") await toggle.click();
  await page.locator('#login [name="code"]').waitFor({ state: "visible" });
}
