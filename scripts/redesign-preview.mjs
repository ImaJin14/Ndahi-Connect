// Local preview of the redesign, for watching screens change and checking
// them against the design canvas. In-memory data and mock providers only:
// no database, no Mobile Money, no router, no email is ever contacted.
//
//   node scripts/redesign-preview.mjs             servers only
//   node scripts/redesign-preview.mjs --capture   servers, then one capture run
//
//   Portal (v2 by default)  http://localhost:8080   sign-in details are printed at start
//   Admin (v2)              http://localhost:8081   one-click sign-in from :8090
//   API                     http://localhost:8082
//   Store (guests)          http://localhost:8083
//   Design + comparisons    http://localhost:8090
//
// Both apps reload their files when customer-app-v2/, admin-app-v2/ or
// shared-app/ change; open tabs then offer "Refresh app". Ports can be moved
// with PREVIEW_PORTAL_PORT, PREVIEW_ADMIN_PORT, PREVIEW_API_PORT,
// PREVIEW_STORE_PORT and PREVIEW_DESIGN_PORT. Cookies ignore ports, so :8090
// can sign a browser in to the local apps.
//
// Captures: every design artboard and built screen is opened in Chromium. A
// capture only counts when the page landed on the expected address, the
// screen's expected UI is visible, no known error or loading UI is showing,
// and all of that still holds once the page has stopped changing (for design
// artboards: the canvas runtime reported ready rather than "error" and
// rendered something). A failed capture leaves no gallery PNG. Each run writes
// manifest.json beside the PNGs with the source commit, viewport, session,
// outcome and error of every capture; /compare shows the same.
import http from "node:http";
import { readFile, writeFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { setDefaultResultOrder } from "node:dns";
import { createServer, createStore } from "../server.mjs";
import { createStaticServer } from "../static-server.mjs";
import { MockEmailAdapter } from "../lib/email.mjs";
import { publishInitialStoreCatalogue } from "../lib/initial-store-catalogue.mjs";
import { hashSecret } from "../lib/security.mjs";
import { voucherQrUrl } from "../lib/voucher-qr.mjs";
import { plans as PLANS } from "../lib/api/state.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const screensDir = join(root, "docs/redesign/screens");
const portalPort = Number(process.env.PREVIEW_PORTAL_PORT || 8080);
const adminPort = Number(process.env.PREVIEW_ADMIN_PORT || 8081);
const apiPort = Number(process.env.PREVIEW_API_PORT || 8082);
const designPort = Number(process.env.PREVIEW_DESIGN_PORT || 8090);
// The public store on the API's default store origin (lib/api/middleware.mjs).
const storePort = Number(process.env.PREVIEW_STORE_PORT || 8083);
const portal = `http://localhost:${portalPort}`, admin = `http://localhost:${adminPort}`, api = `http://localhost:${apiPort}`, design = `http://localhost:${designPort}`;
const storeSite = `http://localhost:${storePort}`;
// Where captures and manifest.json go. PREVIEW_CAPTURE_DIR picks a local
// folder (created if missing). Otherwise each preview process gets its own
// new folder from mkdtemp: a unique name, created atomically and readable
// only by this user, so no other local user can pre-create or link it.
let captureDirPromise = null;
export function captureDir() {
  if (!captureDirPromise) {
    const chosen = process.env.PREVIEW_CAPTURE_DIR;
    captureDirPromise = (chosen
      ? mkdir(resolve(chosen), { recursive: true, mode: 0o700 }).then(() => resolve(chosen))
      : mkdtemp(join(tmpdir(), "ndahi-redesign-preview-"))
    ).catch((error) => { captureDirPromise = null; throw error; });
  }
  return captureDirPromise;
}
export const DEMO = { phone: "670000001", pin: "2468", name: "Amina Nfor", email: "amina@example.test" };
// Values made while seeding the demo data that screen paths can name as {key}.
export const FIXTURES = ["qrToken", "voucherIds", "voucherId", "paymentId", "guestOrderId", "guestOrderToken",
  "checkoutDeclined", "checkoutLowBalance", "checkoutTimeout", "checkoutWrongNetwork"];
// Demo accounts for Home's renewal moments (#252, canvas: PhoneRenew), each
// with its own session: [moment, phone, plan]. The phones mask as 6•• •• 12 45.
export const MOMENT_ACCOUNTS = [["lowData", "670031245", "weekly"], ["endsSoon", "670041245", "weekly"], ["ended", "670051245", "family"]];

// Built screens and the canvas artboards they follow. Status says how far each has come.
//
// Options:
//   tab        portal tab that must be current
//   panel/menu admin panel that must be shown / side menu item that must be current
//   open       steps run in turn: a selector to click, or { fill, value }
//   expect     selectors that must be visible before the capture counts
//   reject     selectors of error/loading UI that must not be visible (added to the app's own, see REJECT)
//   hash       pattern the final address hash must match (shop and admin sub-screens)
//   signedOut  no session cookie; hotspot adds a Wi-Fi sign-in URL to the config
//   blocked    the preview can't put the build in the artboard's state; the text
//              says what is shown instead, and expect checks that it is
//   state      what the build capture shows, for the manifest
//   design     canvas props for the design capture, as a query ("moment=ended")
//   account    a MOMENT_ACCOUNTS demo account to sign in as instead of the demo customer
const SHELL = "Admin shell — screen not rebuilt yet";
// Artboards added on 13 Nov 2026 (docs/redesign/designs-2026-11-13.md) that are
// not built yet. The build capture shows today's nearest page; each issue
// replaces its entry when the screen is built.
const NOT_BUILT = (issue) => `Not built yet (#${issue})`;
const NO_PAIRING = "Device approvals need live router coverage and the network queue, which the preview keeps off";
// The portal shop's failure view (customer-app-v2/portal-shop.js render()).
const SHOP_ERROR = ".error[role=\"alert\"]:not(:empty)";
export const SCREENS = [
  ...[
    ["home", "Home", "PhoneHome", "Main", "/dashboard#home", "Redesigned", { tab: "home", expect: ["#portalTitle"] }],
    ["internet", "Internet", "PhoneInternet", "DesktopInternet", "/dashboard#internet", "Redesigned", { tab: "internet" }],
    ["activity", "Activity", "PhoneActivity", "DesktopActivity", "/dashboard#activity", "Redesigned", { tab: "activity" }],
    ["receipt", "Receipt", "PhoneReceipt", null, "/dashboard#activity", "Redesigned", { tab: "activity", open: ["details[data-payment-row] > summary", "[data-view-receipt]"], expect: ["#receiptDialog[open]", "#receiptDownload"] }],
    ["account", "Account", "PhoneAccount", "DesktopAccount", "/dashboard#account", "Redesigned", { tab: "account" }],
    ["devices", "Devices", "PhoneDevices", null, "/dashboard#devices", "Redesigned", { expect: ["#manageDevices[data-sub-active]"] }],
    ["edit-profile", "Edit profile", "PhoneEditProfile", null, "/dashboard#editProfile", "Redesigned", { expect: ["#emailAccount[data-sub-active]"] }],
    ["change-pin", "Change PIN", "PhoneChangePin", null, "/dashboard#pin", "Redesigned look; four-digit PIN until Phase 6", { expect: ["#accountSecurity[data-sub-active]"] }],
    ["notifications", "Notifications", "PhoneNotifications", null, "/dashboard#home", "Redesigned", { open: [".notification-bell"], expect: [".notification-panel"] }],
    ["sessions", "Signed-in devices", "PhoneSessions", null, "/dashboard#sessions", "Redesigned", { expect: ["#accountSessions[data-sub-active]"] }],
    ["passkeys", "Passkey sign-in", "PhonePasskey", null, "/dashboard#passkeys", "Redesigned", { expect: ["#accountSecurity[data-sub-active]"] }],
    ["billing-terms", "Package rules", "PhoneBillingTerms", null, "/billing-terms.html", "Redesigned", { expect: ["h1"] }],
    ["help", "Help", "PhoneHelp", null, "/help.html", "Redesigned", { expect: ["h1"] }],
    ["home-router", "Home router", "PhoneHomeRouter", null, "/home-router.html", "Redesigned",
      { blocked: "NDAHI Home is off in the preview, so the page shows its \"not enabled\" notice instead of the canvas enrolment", expect: ["text=Home router enrollment is not enabled yet"] }],
    ["login", "Sign in", "PhoneLogin", null, "/login", "Redesigned look; phone + voucher code + PIN until Phase 6", { signedOut: true, expect: ["#login"] }],
    ["forgot-pin", "Forgot PIN", "PhoneForgotPin", null, "/forgot-pin", "Redesigned", { signedOut: true, expect: ["#resetRequest"] }],
    ["hotspot", "Hotspot", "PhoneHotspot", null, "/hotspot?mac=AA%3ABB%3ACC%3ADD%3AEE%3A03&address=10.20.0.30", "Redesigned", { signedOut: true, hotspot: true, expect: ["#hotspotLandingTitle"] }],
    ["buy-bundle", "Buy bundle", "PhoneBuyBundle", null, "/onboarding.html", "Redesigned", { signedOut: true, expect: ["#packagesTitle"] }],
    // A returning guest whose saved checkout did not go through, one per reason
    // (the canvas's `reason` prop). The cookie is the one the page saves.
    ...[["declined", "declined", "checkoutDeclined", "declined by the provider"], ["low-balance", "lowBalance", "checkoutLowBalance", "provider reported a low balance"],
      ["timeout", "timeout", "checkoutTimeout", "closed before the provider answered"], ["wrong-network", "wrongNetwork", "checkoutWrongNetwork", "an Orange-block number paid as MTN"]]
      .map(([id, reason, checkout, state]) => [`payment-failed-${id}`, `Payment failed: ${id.replace("-", " ")}`, "PhonePaymentFailed", null, "/onboarding.html", "Redesigned",
        { signedOut: true, design: `reason=${reason}`, checkout, state: `a guest's saved checkout, ${state}`, expect: ["#paymentFailed:not([hidden])", "#paymentFailedTitle:not(:empty)"] }]),
    ["buy-for-other", "Buy for someone else", "PhoneBuyForOther", null, "/onboarding.html", NOT_BUILT(255), { signedOut: true, expect: ["#packagesTitle"] }],
    ["claim-gift", "Claim a gift", "PhoneClaimGift", null, "/login", NOT_BUILT(254), { signedOut: true, expect: ["#login"] }],
    // Home's renewal moments, one demo account each (the canvas's `moment` prop).
    ...[["low-data", "lowData", "Running low", "a Weekly bundle with four fifths of its 5 GB used"], ["ends-soon", "endsSoon", "Ends soon", "a Weekly bundle ending in 20 hours"],
      ["ended", "ended", "Ended", "a Connect Family bundle that ended an hour ago"]]
      .map(([id, moment, title, state]) => [`renew-${id}`, `Renewal: ${title.toLowerCase()}`, "PhoneRenew", null, "/dashboard#home", "Redesigned",
        { tab: "home", design: `moment=${moment}`, account: moment, state, expect: ["#renewActions > *"] }]),
    ["outage", "Outage notice", "PhoneOutage", null, "/dashboard#home", NOT_BUILT(259), { tab: "home" }],
    ["home-fr", "Home in French", "PhoneHomeFR", null, "/dashboard#home", NOT_BUILT(260), { tab: "home" }],
    ["reseller-home", "Reseller home", "ResellerHome", null, "/login", `${NOT_BUILT(261)}; it will live in the admin app`, { signedOut: true, expect: ["#login"] }],
    ["connect-flow", "Get-connected flow board", null, "ConnectFlow", "/hotspot?mac=AA%3ABB%3ACC%3ADD%3AEE%3A03&address=10.20.0.30", "A board of every path, each built on its own screen (walked in #250); this capture is the Wi-Fi landing it starts from",
      { signedOut: true, hotspot: true, expect: ["#hotspotLandingTitle"] }],
    ["voucher", "Voucher", "PhoneVoucher", null, "/dashboard#redeem", "Redesigned", { expect: ["#activateDevice[data-sub-active]"] }],
    ["voucher-ready", "Voucher ready", "PhoneVoucherReady", null, "/voucher-ready.html?payment={paymentId}", "Redesigned", { expect: ["#voucherDetails"] }],
    ["voucher-slip", "Voucher slip", "VoucherSlip", null, "/voucher-print.html#ids={voucherIds}&width=58", "Redesigned page; the slip stays the thermal POS format shared with admin printing",
      { expect: ["#printSurface > *", "#printNow:not([disabled])"], state: "the demo customer's active voucher, 58 mm" }],
    // The demo customer's current QR (the same one the account shows), on NDAHI Wi-Fi (mock device address).
    ["scan-connect", "Scan to connect", "PhoneScanConnect", null, "/voucher-connect.html?mac=AA%3ABB%3ACC%3ADD%3AEE%3A05&address=10.20.0.32#qr={qrToken}", "Redesigned",
      { signedOut: true, expect: ["#qrConnectForm", "#connectWithPin:not([disabled])"], state: "signed out, current QR, mock Wi-Fi device" }],
    // The account's expired bundle, by its printed code.
    ["scan-no-bundle", "Scan, no bundle", "PhoneScanNoBundle", null, "/voucher-connect.html#legacy=NC-HIST-0001", "Redesigned", { expect: ["#qrNoBundle"], state: "the demo customer's expired voucher" }],
    ["pair-request", "Pair request", "PhonePairRequest", null, "/pair?mac=AA%3ABB%3ACC%3ADD%3AEE%3A04&address=10.20.0.31", "Redesigned",
      { signedOut: true, blocked: `${NO_PAIRING}; the page shows "Assisted connection is currently unavailable"`, expect: ["text=Assisted connection is currently unavailable"] }],
    ["pair-review", "Pair review", "PhonePairReview", null, "/pair-review.html", "Redesigned",
      { blocked: `${NO_PAIRING}, so there is no request to review; the page shows its invalid-link message`, expect: ["text=This device request link is invalid"] }],
    ["wifi-connected", "Wi-Fi connected", "PhoneWifiConnected", null, "/wifi-connected.html", "Redesigned", { expect: ["h1"] }],
    ["shop", "Shop", "PhoneShop", "Shop", "/dashboard#shop", "Redesigned", { tab: "shop", hash: "^#shop$", expect: [".portal-shop__item"], reject: [SHOP_ERROR] }],
    ["product", "Product", "PhoneProduct", null, "/dashboard#shop", "Redesigned", { open: [".portal-shop__item"], hash: "^#product/[^/]+$", expect: [".portal-shop__name", "#shopBuy"], reject: [SHOP_ERROR] }],
    ["checkout", "Checkout", "PhoneCheckout", null, "/dashboard#shop", "Redesigned", { open: [".portal-shop__item", "#shopBuy"], hash: "^#checkout/[^/]+/\\d+$", expect: ["#shopCheckout"], reject: [SHOP_ERROR] }],
    // The demo customer's own paid order, ready to collect.
    ["order", "Order", "PhoneOrder", null, "/dashboard#activity", "Redesigned", { open: ["a.portal-activity__order"], hash: "^#order/[^/]+$", expect: [".portal-shop__steps", ".portal-shop__code"], reject: [SHOP_ERROR] }],
  ].map(([id, title, phone, desktop, path, status, options]) => ({ id, app: "portal", title, status, phone, ...(desktop ? { desktop } : {}), path, ...(options || {}) })),
  // The store (store-app/app.js) routes by hash and marks the view on <body
  // data-view>: the product is its own page at #product/<id> (no dialog since
  // bb1f908), checkout is the one remaining dialog, and a guest's order is a
  // page with the collection code card and the private link.
  ...[
    ["guest-shop", "Guest shop", "PhoneGuestShop", "StoreGuest", "/", "Redesigned", { hash: "^(#shop)?$", expect: ["body[data-view=\"shop\"] .products [data-product]"] }],
    ["guest-product", "Guest product", "PhoneGuestProduct", "ProductDesktop", "/", "Redesigned",
      { open: ["[data-product]"], hash: "^#product/[^/]+$", expect: ["body[data-view=\"product\"] .detail-info #productTitle", "#buy:not([disabled])"] }],
    ["guest-checkout", "Guest checkout", "PhoneGuestCheckout", null, "/", "Redesigned",
      { open: ["[data-product]", "#buy"], hash: "^#product/[^/]+$", expect: ["body[data-view=\"product\"] #productTitle", "#checkoutDialog[open] #checkoutForm"] }],
    // A guest's paid order, opened from its private tracking link.
    ["guest-order", "Guest order", "PhoneGuestOrder", null, "/#order/{guestOrderId}/{guestOrderToken}", "Redesigned",
      { hash: "^#order/[^/]+/[^/]+$", expect: ["body[data-view=\"order\"] .order-page", ".code-card__code", "#privateLink"] }],
  ].map(([id, title, phone, desktop, path, status, options]) => ({ id, app: "store", title, status, phone, ...(desktop ? { desktop } : {}), path, signedOut: true, ...(options || {}) })),
  // Admin artboards are desktop (1280px) only.
  ...[
    ["admin-login", "Sign in", "AdminLogin", "/login", "Redesigned look; today's username + password or passkey stays until Phase 6 (no email + PIN two-step yet)", { signedOut: true, expect: ["#login"] }],
    ["admin-home", "Home", "Admin", "/dashboard#home", "Redesigned", { panel: "home" }],
    ["admin-devices", "Live devices", "AdminDevices", "/dashboard#devices", "Redesigned (no access point, signal or today's usage: the router doesn't report them)", { panel: "devices", menu: "devices" }],
    ["admin-connections", "Connections", "AdminConnections", "/dashboard#connections", "Redesigned (no uplink speed, per-network payment health or check times: none are recorded)", { panel: "connections", menu: "connections" }],
    ["admin-homerouters", "Home routers", "AdminHomeRouters", "/home-routers.html", "Redesigned (pilot evidence is a JSON report with an audit reason, not free notes)",
      { menu: "homerouters", open: ["#checkHomeReadiness"], expect: ["#homeReadiness > h2", "#homeAdminList"], blocked: "NDAHI Home is off in the preview, so no household connections are listed; the page and readiness checks are real" }],
    ["admin-setup", "Network setup", "AdminNetworkSetup", "/dashboard#network-setup", "Redesigned (four steps over the existing forms; status, enforcement and history stay below)", { panel: "network-setup", menu: "setup" }],
    ["admin-bundles", "Bundles", "AdminBundles", "/dashboard#bundles", "Redesigned (no Pause / Put on sale or drafts: the API has neither; sold this week shown as vouchers issued)", { panel: "bundles", menu: "bundles" }],
    ["admin-bundle-edit", "Edit bundle", "AdminBundleEdit", "/dashboard#bundles", "Redesigned", { open: ["a[href*=\"#bundle/\"]"], panel: "bundle-edit", menu: "bundles", hash: "^#bundle/" }],
    ["admin-vouchers", "Vouchers", "AdminVouchers", "/dashboard#vouchers", "Redesigned (no Batch column: vouchers carry no batch number)", { panel: "vouchers", menu: "vouchers" }],
    // Creates a batch of three in-memory vouchers, then opens its print screen.
    ["admin-voucher-print", "Print a voucher batch", "AdminVoucherPrint", "/dashboard#vouchers", "Redesigned — create a batch, then Print slips (58/80 mm thermal slips, not A6 sheets)",
      { open: [{ fill: "#generate [name=\"quantity\"]", value: "3" }, "#generate button[type=\"submit\"]", "#generated a[href=\"/dashboard#voucher-print\"]"],
        panel: "voucher-print", menu: "vouchers", hash: "^#voucher-print$", expect: ["#voucherPrintSurface"], state: "a new batch of 3 demo vouchers, 58 mm" }],
    ["admin-payments", "Payments", "AdminPayments", "/dashboard#payments", "Redesigned", { panel: "payments", menu: "payments" }],
    ["admin-store", "Store orders", "AdminStore", "/dashboard#store", "Redesigned", { panel: "store", menu: "store", expect: ["#storeOrdersTitle"] }],
    ["admin-products", "Products", "AdminProducts", "/dashboard#products", "Redesigned (categories, stock ledger and store settings under the catalogue)", { panel: "store", menu: "products", expect: ["#storeCatalogueTitle"] }],
    ["admin-product-edit", "Edit product", "AdminProductEdit", "/dashboard#products", "Redesigned", { open: ["a[href*=\"#product/\"]:not([href$=\"/new\"])"], panel: "store", menu: "products", hash: "^#product/", expect: ["#storeProductForm"] }],
    ["admin-cash", "Cash & settlements", "AdminCash", "/dashboard#cash", "Redesigned (no provider settlements or period switch until the API records them)", { panel: "cash", menu: "cash" }],
    ["admin-customers", "Customers", "AdminCustomers", "/dashboard#customers", "Redesigned (row selection and bulk gift or message arrive with #257)", { panel: "customers", menu: "customers" }],
    ["admin-customer-detail", "Customer detail", "AdminCustomerDetail", "/dashboard#customers", "Redesigned (no Remove lost passkeys: that arrives with Phase 6 sign-in)", { open: ["a.admin-name"], panel: "customer", menu: "customers", hash: "^#customer/", expect: ["#customerDetail > *"] }],
    ["admin-resellers", "Resellers", "AdminResellers", "/dashboard#resellers", "Redesigned (commission is set per reseller, so there is no single split in the head)", { panel: "resellers", menu: "resellers" }],
    ["admin-audit", "Audit log", "AdminAudit", "/dashboard#audit", "Redesigned", { panel: "audit", menu: "audit" }],
    ["admin-voucher-detail", "Voucher detail", "AdminVoucherDetail", "/dashboard#voucher/{voucherId}", "Redesigned (the demo customer's active voucher)", { panel: "voucher", menu: "vouchers", expect: [".admin-voucher__ticket", ".admin-voucher__timeline li"] }],
    ["admin-outage", "Outages", "AdminOutage", "/dashboard#home", NOT_BUILT(259), { panel: "home" }],
    ["admin-insights", "Insights", "AdminInsights", "/dashboard#home", NOT_BUILT(262), { panel: "home" }],
    ["admin-profile", "Profile & security", "AdminProfile", "/dashboard#profile", "Redesigned (password, not PIN, until Phase 6; no name or email editing: the API has none; add staff instead of invitations)", { panel: "profile", menu: "profile" }],
  ].map(([id, title, desktop, path, status, options]) => ({ id, app: "admin", title, status: status || SHELL, desktop, path, ...(options || {}) })),
];

// Local demo prices for the initial catalogue (the owner's launch prices).
const DEMO_PRICES = { "ND-TPLINK-AX1500": 100000, "ND-TPLINK-CPE210": 80000, "ND-WAVLINK-AC1200": 70000, "ND-WAVLINK-MINI": 60000 };

const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const listen = (server, port) => new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
// One line of an error, never its stack.
const firstLine = (error) => String((error && error.message) || error).split("\n")[0].slice(0, 400);

export class CaptureError extends Error {
  constructor(message) { super(message); this.name = "CaptureError"; }
}

async function startApi() {
  setDefaultResultOrder("ipv4first");
  const store = createStore({ persistent: false }), adminSecret = randomUUID();
  const staff = { owner: randomUUID(), operator: randomUUID(), reseller: randomUUID() };
  const fixtures = {}, warnings = [];
  const server = createServer({ store, email: new MockEmailAdapter(), env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "mock",
    CUSTOMER_APP_URL: portal, STORE_APP_URL: storeSite, SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false",
    NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    ADMIN_SESSION_SECRET: adminSecret, ADMIN_APP_URL: admin, ALLOWED_ADMIN_ORIGINS: admin,
  } });
  await listen(server, apiPort);
  const call = async (path, input, headers = {}) => {
    const response = await fetch(api + path, input === undefined ? { headers } : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
    const body = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${body && body.error ? body.error : ""}`.trim());
    return { response, body };
  };
  // Demo customer: a paid Weekly bundle with some data used, a verified email,
  // an older expired bundle, and a PIN for signing in.
  const purchase = await call("/api/purchase", { phone: DEMO.phone, name: DEMO.name, email: DEMO.email, planId: "weekly" });
  const paid = await call(`/api/payments/${purchase.body.payment.id}/confirm`, {});
  const setup = await call("/api/account/setup/pin", { phone: DEMO.phone, code: paid.body.access.code, pin: DEMO.pin, confirmPin: DEMO.pin });
  const cookie = setup.response.headers.get("set-cookie").split(";")[0];
  fixtures.paymentId = purchase.body.payment.id;
  const accounts = {};
  for (const [moment, phone, planId] of MOMENT_ACCOUNTS) {
    const bought = await call("/api/purchase", { phone, name: DEMO.name, planId });
    const confirmed = await call(`/api/payments/${bought.body.payment.id}/confirm`, {});
    const made = await call("/api/account/setup/pin", { phone, code: confirmed.body.access.code, pin: DEMO.pin, confirmPin: DEMO.pin });
    accounts[moment] = made.response.headers.get("set-cookie").split(";")[0];
  }
  await publishInitialStoreCatalogue({ store });
  await store.transaction((s) => {
    const now = Date.now(), customer = s.customers.find((c) => c.phone.endsWith(DEMO.phone));
    customer.emailVerifiedAt = new Date(now).toISOString();
    const active = s.vouchers.find((v) => v.status === "active" && v.customerId === customer.id);
    if (active) {
      if (Number.isFinite(active.quotaBytes)) active.usedBytes = Math.round(active.quotaBytes * 0.36);
      // An older, expired bundle on the same account (Scan, no bundle reads it by its code).
      const history = { ...structuredClone(active), id: "preview-history", code: "NC-HIST-0001", status: "expired", paymentId: undefined,
        activatedAt: new Date(now - 12 * 864e5).toISOString(), expiresAt: new Date(now - 5 * 864e5).toISOString() };
      delete history.qrConnectToken; delete history.qrConnectVersion;
      s.vouchers.push(history);
      // The mock router took the bundle; with the network queue off nothing
      // would record that, and a real paid bundle is in this state.
      active.routerSyncStatus = "synchronized";
      // One signed-in device for the Devices screen (the bundle allows one).
      s.sessions.push({ id: "preview-session", voucherId: active.id, customerId: customer.id, deviceId: "preview-laptop-7f3a9c21b8e4", label: "HP laptop",
        status: "online", connectedAt: new Date(now - 2 * 36e5).toISOString() });
      // The bundle's current QR, the same one its account pages show.
      fixtures.qrToken = new URLSearchParams(new URL(voucherQrUrl(active, customer, portal)).hash.slice(1)).get("qr") || "";
      fixtures.voucherIds = JSON.stringify([active.id]);
      fixtures.voucherId = active.id;
    } else warnings.push("The demo customer has no active bundle; voucher and scan captures will fail.");
    // Renewal moments: four fifths used; ending in 20 hours with 2.4 GB left;
    // ended an hour ago. Each was paid by MTN MoMo, which Buy again offers again.
    for (const [moment, phone] of MOMENT_ACCOUNTS) {
      const owner = s.customers.find((c) => c.phone.endsWith(phone)), v = owner && s.vouchers.find((x) => x.customerId === owner.id);
      if (!v) { warnings.push(`The ${moment} demo account has no bundle; its renewal capture will fail.`); continue; }
      const payment = s.payments.find((p) => p.id === v.paymentId);
      if (payment) payment.network = "mtn";
      // Set up as the demo customer is: a confirmed email and a bundle the router took.
      Object.assign(owner, { email: `${moment.toLowerCase()}@example.test`, emailVerifiedAt: new Date(now).toISOString() });
      v.routerSyncStatus = "synchronized";
      if (moment === "lowData") v.usedBytes = Math.round(v.quotaBytes * 0.8);
      if (moment === "endsSoon") Object.assign(v, { usedBytes: v.quotaBytes - 2.4e9, activatedAt: new Date(now - 148 * 36e5).toISOString(), expiresAt: new Date(now + 20 * 36e5).toISOString() });
      if (moment === "ended") Object.assign(v, { status: "expired", usedBytes: Math.round(v.quotaBytes * 0.7), activatedAt: new Date(now - 721 * 36e5).toISOString(), expiresAt: new Date(now - 36e5).toISOString() });
    }
    // Demo payments for the admin Payments and Cash screens: two waiting (one
    // over 10 minutes), gateway-confirmed sales this month, one failed today
    // and one expired yesterday. Gateway references are made up; no provider is called.
    const base = s.payments[0], plans = [...PLANS, ...s.bundles].filter((plan) => plan.price > 0);
    const demoPayment = (id, minutes, planIndex, phone, network, extra) => {
      const plan = plans[planIndex % (plans.length || 1)];
      const snapshot = plan ? { ...base.planSnapshot, id: plan.id, name: plan.name, price: plan.price } : base.planSnapshot;
      return { ...structuredClone(base), id, customerId: undefined, planId: snapshot.id, planSnapshot: snapshot, amount: snapshot.price, payerPhone: phone, network, provider: "mesomb",
        providerReference: `PREVIEW-${id.toUpperCase()}`, createdAt: new Date(now - minutes * 60000).toISOString(), confirmedAt: null, receipt: undefined, refund: undefined, ...extra };
    };
    const confirmed = (minutes) => ({ status: "paid", confirmedAt: new Date(now - (minutes - 1) * 60000).toISOString() });
    s.payments.push(
      demoPayment("wait-1", 4, 1, "237670121245", "mtn", { status: "pending" }),
      demoPayment("wait-2", 17, 0, "237690337731", "orange", { status: "pending" }),
      demoPayment("paid-1", 46, 2, "237670884019", "mtn", confirmed(46)),
      demoPayment("paid-2", 130, 1, "237650220366", "orange", confirmed(130)),
      demoPayment("failed-1", 190, 1, "237690550366", "orange", { status: "failed" }),
      demoPayment("expired-1", 26 * 60, 0, "237670772210", "mtn", { status: "expired" }),
      demoPayment("paid-3", 4 * 24 * 60, 2, "237670118802", "mtn", confirmed(4 * 24 * 60)),
    );
    // Four guest checkouts that did not go through (Payment failed screens), with
    // no customer record so the admin lists are unchanged. Each fixture is the
    // saved-checkout cookie the page writes; its key reads only the outcome.
    const failedAt = new Date(now - 2 * 60000).toISOString(), lateCheckUntil = new Date(now + 864e5).toISOString();
    for (const [fixture, reason, phone] of [["checkoutDeclined", "declined", "670001245"], ["checkoutLowBalance", "low_balance", "670011245"],
      ["checkoutTimeout", "timeout", "670021245"], ["checkoutWrongNetwork", "wrong_network", "699001245"]]) {
      const requestKey = randomUUID() + randomUUID();
      const payment = demoPayment(randomUUID(), 3, 1, `237${phone}`, "mtn", { customerId: `preview-guest-${reason}`, provider: "mock", requestKey, checkoutAudience: "guest",
        guestCheckoutDetails: { name: "Demo buyer", phone, network: "mtn" }, creationState: "accepted", checkoutClosedAt: failedAt, lateCheckUntil,
        ...(reason === "timeout" ? { status: "expired" } : { status: "failed", providerFailedAt: failedAt, failureCode: reason }) });
      s.payments.push(payment);
      fixtures[fixture] = JSON.stringify({ value: JSON.stringify({ requestKey, planId: payment.planId, paymentId: payment.id }), expiresAt: now + 864e5 });
    }
    for (const product of s.storeProducts) if (DEMO_PRICES[product.sku]) { product.price = DEMO_PRICES[product.sku]; product.stock = 6; }
    s.storeSettings.open = true;
    // Demo store settings so checkout accepts the demo orders below.
    Object.assign(s.storeSettings, { pickup: "NDAHI office, Molyko (demo)", hours: "Mon–Sat 9:00–18:00", contact: "+237 670 000 000 (demo)",
      warranty: { en: "Demo warranty text.", fr: "Texte de garantie (démo)." }, returns: { en: "Demo returns text.", fr: "Texte de retours (démo)." } });
    // Demo staff with ready sessions (as the admin journeys do); the preview's
    // sign-in links hand these to the browser.
    const expiresAt = new Date(now + 30 * 864e5).toISOString();
    for (const [role, token] of Object.entries(staff)) {
      s.adminUsers.push({ id: `preview-${role}`, username: `demo-${role}`, name: `Demo ${role}`, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `preview-${role}`, tokenHash: hashSecret(token, adminSecret), role, csrfToken: randomUUID(), expiresAt });
    }
  });
  // Demo store orders (mock payments), three paid: the demo customer's own,
  // placed from the account and ready to collect (portal Order screen), and
  // two guests' with private tracking links (store Guest order screen).
  try {
    const products = (await store.snapshot()).storeProducts.filter((p) => p.status === "published" && p.price).slice(0, 3);
    if (!products.length) throw new Error("no published product has a price");
    const account = { cookie, "x-csrf-token": (await call("/api/account/dashboard", undefined, { cookie })).body.csrfToken };
    const own = await call("/api/account/store/checkout", { productId: products[0].id, quantity: 1, expectedPrice: products[0].price,
      name: DEMO.name, phone: DEMO.phone, email: DEMO.email, payerPhone: DEMO.phone, network: "mtn", checkoutKey: randomUUID() }, account);
    await call("/api/account/store/verify", { orderId: own.body.order.id }, account);
    await store.transaction((s) => { const order = s.storeOrders.find((o) => o.id === own.body.order.id); if (order && order.status === "preparing") order.status = "ready"; });
    for (const [index, guest] of [["Jean Fon", "670000103", "orange"], ["Grace Tabi", "670000104", "mtn"]].entries()) {
      const product = products[(index + 1) % products.length];
      const order = await call("/api/store/checkout", { productId: product.id, quantity: 1, expectedPrice: product.price,
        name: guest[0], phone: guest[1], payerPhone: guest[1], network: guest[2], checkoutKey: randomUUID() });
      await call("/api/store/verify", { orderId: order.body.order.id, token: order.body.token });
      if (!fixtures.guestOrderId) { fixtures.guestOrderId = order.body.order.id; fixtures.guestOrderToken = order.body.token; }
    }
  } catch (error) {
    warnings.push(`Demo store orders incomplete (${firstLine(error)}); Order and Guest order captures will fail.`);
  }
  for (const warning of warnings) console.warn("[preview]", warning);
  return { server, cookie, accounts, code: paid.body.access.code, staff, fixtures, warnings };
}

// The static servers cache their files, so a change swaps in fresh ones.
function startApps() {
  const makers = {
    portal: () => createStaticServer("customer", { apiUrl: api, portalUrl: portal, supportEmail: "support@example.test", supportPhone: "+237 670 000 000", env: { UI_V2_PERCENT: "100" } }),
    admin: () => createStaticServer("admin", { apiUrl: api, portalUrl: portal }),
    store: () => createStaticServer("store", { apiUrl: api, portalUrl: portal }),
  };
  const current = { portal: makers.portal(), admin: makers.admin(), store: makers.store() };
  let timer;
  for (const folder of ["customer-app-v2", "admin-app-v2", "shared-app", "store-app"]) {
    watch(join(root, folder), { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(() => { current.portal = makers.portal(); current.admin = makers.admin(); current.store = makers.store(); console.log(`[preview] ${new Date().toLocaleTimeString()} files changed; open tabs will offer Refresh app`); }, 300);
    });
  }
  return Promise.all([
    listen(http.createServer((req, res) => current.portal.emit("request", req, res)), portalPort),
    listen(http.createServer((req, res) => current.admin.emit("request", req, res)), adminPort),
    listen(http.createServer((req, res) => current.store.emit("request", req, res)), storePort),
  ]);
}

// The commit the captures were taken from, and whether tracked files differ from it.
export function sourceInfo() {
  if (process.env.PREVIEW_SOURCE_SHA) return { sha: process.env.PREVIEW_SOURCE_SHA, dirty: null };
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim();
  try {
    const sha = git("rev-parse", "HEAD");
    let dirty = null;
    try { dirty = git("status", "--porcelain", "--untracked-files=no") !== ""; } catch { /* Unknown; recorded as null. */ }
    return { sha, dirty };
  } catch { return { sha: "unknown", dirty: null }; }
}

// A screen's path with its {fixture} names filled in.
export function resolvePath(path, fixtures = {}) {
  return path.replace(/\{(\w+)\}/g, (all, name) => {
    const value = Object.prototype.hasOwnProperty.call(fixtures, name) ? fixtures[name] : undefined;
    if (value == null || value === "") throw new CaptureError(`demo fixture "${name}" is unavailable`);
    return encodeURIComponent(value);
  });
}

// Apps serve /login and /login.html alike; "/" and "/index.html" too.
const bare = (pathname) => pathname.replace(/\.html$/, "").replace(/\/index$/, "/") || "/";
// Why the page at href is not the screen's page, or null when it is.
export function routeProblem(screen, href) {
  const url = new URL(href), wanted = new URL(screen.path.replace(/\{\w+\}/g, "x"), url.origin);
  if (bare(url.pathname) !== bare(wanted.pathname)) return `expected ${wanted.pathname} but landed on ${url.pathname}${url.hash}`;
  if (screen.hash && !new RegExp(screen.hash).test(url.hash)) return `expected an address matching ${screen.hash} but landed on ${url.pathname}${url.hash}`;
  return null;
}

// Selectors that must all be visible before a build capture counts.
export function expectations(screen) {
  return [
    ...(screen.tab ? [`[data-portal-tab="${screen.tab}"][aria-current="page"]`] : []),
    ...(screen.panel ? [`[data-tab-panel="${screen.panel}"]:not([hidden])`] : []),
    ...(screen.menu ? [`[data-admin-nav="${screen.menu}"][aria-current="page"]`] : []),
    ...[].concat(screen.expect || []),
  ];
}

// Error and loading UI each app shows in place of a screen. The store keeps
// "Loading store…" as the only child of #view until its catalogue loads, puts
// route failures in #message and checkout failures in #checkoutError.
export const REJECT = {
  portal: ['.error-card[role="alert"]'],
  store: ["#view > p:only-child", "#message:not(:empty)", "#checkoutError:not(:empty)"],
};
// Selectors that must not be visible when a build capture is taken.
export function rejections(screen) {
  return [...(REJECT[screen.app] || []), ...[].concat(screen.reject || [])];
}

const visible = (page, selector) => page.locator(selector).first().isVisible().catch(() => false);
// Throws unless the page is still the screen's page, shows none of its error or
// loading UI, and shows all of its expected UI. Checked again after settling,
// so a late error, redirect or re-render is never captured.
export async function confirmShown(page, screen, when = "") {
  const route = routeProblem(screen, page.url());
  if (route) throw new CaptureError(`${route}${when}`);
  for (const selector of rejections(screen)) {
    if (await visible(page, selector)) {
      const text = await page.locator(selector).first().innerText().catch(() => "");
      throw new CaptureError(`error or loading UI shown: ${selector}${text.trim() ? ` ("${text.trim().slice(0, 160)}")` : ""} (at ${page.url()})${when}`);
    }
  }
  for (const selector of expectations(screen)) {
    if (!(await visible(page, selector))) throw new CaptureError(`expected UI not visible: ${selector} (at ${page.url()})${when}`);
  }
}

const stepOf = (step) => (typeof step === "string" ? { click: step } : step);
const describeStep = (step) => (step.fill ? `fill ${step.fill} with "${step.value}"` : `click ${step.click}`);

// Waits until the page stops changing (no DOM mutation for `quiet` ms), up to `limit`.
export function settle(page, { quiet = 500, limit = 5000 } = {}) {
  return page.evaluate(({ quiet, limit }) => new Promise((resolve) => {
    const start = performance.now();
    let last = start;
    const observer = new MutationObserver(() => { last = performance.now(); });
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const check = () => {
      const now = performance.now();
      if (now - last >= quiet || now - start >= limit) { observer.disconnect(); resolve(now - last >= quiet); } else setTimeout(check, 50);
    };
    setTimeout(check, 50);
  }), { quiet, limit });
}

async function shoot(page, files, phone) {
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: files.file, fullPage: !phone });
  // Phones: also the whole scrolling page, when there is more than one screen of it.
  if (phone && await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 1)) {
    await page.screenshot({ path: files.fullFile, fullPage: true });
    return true;
  }
  return false;
}

async function opened(page, url, timeout) {
  const response = await page.goto(url, { timeout });
  if (response && !response.ok()) throw new CaptureError(`${url} answered ${response.status()}`);
}

// One design artboard. Fails unless the canvas runtime reports ready (not "error").
export async function captureDesign(page, { url, files, phone, timeout = 15000 }) {
  await opened(page, url, timeout);
  try { await page.waitForSelector("html[data-dc-ready]", { state: "attached", timeout }); }
  catch { throw new CaptureError(`the canvas runtime did not finish within ${timeout} ms`); }
  const ready = await page.getAttribute("html", "data-dc-ready");
  if (ready !== "") throw new CaptureError(`the artboard did not render: ${(await page.getAttribute("html", "data-dc-error")) || ready}`);
  const landed = new URL(page.url()), wanted = new URL(url);
  if (landed.origin !== wanted.origin || landed.pathname !== wanted.pathname) throw new CaptureError(`expected ${wanted.pathname} but landed on ${landed.pathname}`);
  // Ready with nothing drawn (an empty template or a wiped root) is not the artboard.
  const drawn = await page.evaluate(() => { const host = document.getElementById("dc-root"); return Boolean(host && host.childElementCount && !/^Canvas render failed/.test(host.textContent || "")); });
  if (!drawn) throw new CaptureError("the canvas runtime reported ready but drew nothing");
  const settled = (await page.getAttribute("html", "data-dc-settled")) !== "timeout";
  const full = await shoot(page, files, phone);
  return { url, settled, full };
}

// One built screen: open it, run its steps, and check it is the expected page
// showing the expected UI before taking the picture. Any failure throws.
export async function captureBuild(page, screen, { origin, fixtures, files, phone, timeout = 15000 }) {
  const url = origin + resolvePath(screen.path, fixtures);
  await opened(page, url, timeout);
  const steps = [];
  for (const step of [].concat(screen.open || []).map(stepOf)) {
    try {
      const target = page.locator(step.fill || step.click).first();
      if (step.fill) await target.fill(String(step.value), { timeout });
      else await target.click({ timeout });
    } catch (error) {
      throw new CaptureError(`could not ${describeStep(step)} (at ${page.url()}): ${firstLine(error)}`);
    }
    steps.push(describeStep(step));
  }
  for (const selector of expectations(screen)) {
    try { await page.locator(selector).first().waitFor({ state: "visible", timeout }); }
    catch {
      const route = routeProblem(screen, page.url());
      throw new CaptureError(`expected UI not visible: ${selector}${route ? `; ${route}` : ` (at ${page.url()})`}`);
    }
  }
  await confirmShown(page, screen);
  const settled = await settle(page);
  await confirmShown(page, screen, " once the page settled");
  const full = await shoot(page, files, phone);
  return { url: page.url(), settled, full, steps };
}

const sessionOf = (screen) => (screen.signedOut ? "signed out" : screen.app === "admin" ? "demo owner" : screen.account ? `demo customer (${screen.account})` : "demo customer");
// Phone artboards are captured at 390px and desktop ones at 1280px.
export const widths = (s) => [s.phone && 390, s.desktop && 1280].filter(Boolean);

// One capture, recorded whatever happens. Old PNGs of it are removed first so
// /compare never shows a picture from an earlier run.
async function record(dir, base, entry, work) {
  const names = { file: `${base}.png`, fullFile: `${base}-full.png`, failedFile: `${base}-failed.png` };
  await Promise.all(Object.values(names).map((name) => rm(join(dir, name), { force: true })));
  const files = Object.fromEntries(Object.entries(names).map(([key, name]) => [key, join(dir, name)]));
  try {
    const outcome = await work(files);
    return { ...entry, status: entry.blocked ? "blocked" : "captured", success: !entry.blocked, file: names.file, ...(outcome.full ? { fullFile: names.fullFile } : {}),
      url: outcome.url, settled: outcome.settled, ...(outcome.steps && outcome.steps.length ? { steps: outcome.steps } : {}), at: new Date().toISOString() };
  } catch (error) {
    // A half-finished capture (say the whole-page shot failed) leaves nothing to compare.
    await Promise.all([files.file, files.fullFile].map((file) => rm(file, { force: true })));
    return { ...entry, status: "failed", success: false, error: firstLine(error), ...(error.failedShot ? { failedFile: names.failedFile } : {}), at: new Date().toISOString() };
  }
}

// A picture of what was on screen when a capture failed, for diagnosis only.
async function withFailureShot(page, files, work) {
  try { return await work(); }
  catch (error) {
    error.failedShot = await page.screenshot({ path: files.failedFile }).then(() => true, () => false);
    throw error;
  }
}

// Captures every screen (or the ids in `only`) and writes manifest.json.
// `launch` returns a Playwright-like browser (tests pass a fake).
// `dir` defaults to captureDir(); an explicit folder is created if missing.
export async function capture(state, { only, dir, launch, source = sourceInfo(), timeout = 15000 } = {}) {
  if (dir) await mkdir(dir, { recursive: true, mode: 0o700 });
  else dir = await captureDir();
  const manifest = { source, startedAt: new Date().toISOString(), finishedAt: null, warnings: state.warnings || [], results: [] };
  const browser = await (launch ? launch() : import(process.env.PLAYWRIGHT_MODULE || "playwright").then(({ chromium }) => chromium.launch()));
  try {
    for (const screen of SCREENS.filter((s) => !only || only.includes(s.id))) {
      for (const width of widths(screen)) {
        const phone = width < 768, viewport = { width, height: phone ? 844 : 900 }, board = phone ? screen.phone : screen.desktop;
        const common = { id: screen.id, title: screen.title, app: screen.app, width, viewport };
        manifest.results.push(await record(dir, `${screen.id}-design-${width}`, { ...common, kind: "design", board, state: screen.design || "default props" }, async (files) => {
          const page = await browser.newPage({ viewport });
          try { return await withFailureShot(page, files, () => captureDesign(page, { url: `${design}/design/${board}.dc.html${screen.design ? `?${screen.design}` : ""}`, files, phone, timeout })); }
          finally { await page.close(); }
        }));
        const entry = { ...common, kind: "build", session: sessionOf(screen), state: screen.state || sessionOf(screen), ...(screen.blocked ? { blocked: screen.blocked } : {}) };
        manifest.results.push(await record(dir, `${screen.id}-build-${width}`, entry, async (files) => {
          const context = await browser.newContext({ viewport });
          try {
            await context.addCookies([
              { name: "ndahi_ui", value: "v2", domain: "localhost", path: "/" },
              ...(screen.checkout && state.fixtures?.[screen.checkout] ? [{ name: "ndahi-checkout", value: encodeURIComponent(state.fixtures[screen.checkout]), domain: "localhost", path: "/", sameSite: "Strict" }] : []),
              ...(screen.signedOut ? [] : [screen.app === "admin"
                ? { name: "admin_session", value: state.staff.owner, domain: "localhost", path: "/", httpOnly: true, sameSite: "Lax" }
                : { name: "customer_session", value: (screen.account ? state.accounts?.[screen.account] || "" : state.cookie).split("=")[1] || "", domain: "localhost", path: "/api/account", httpOnly: true, sameSite: "Lax" }]),
            ]);
            // The hotspot landing needs a Wi-Fi sign-in URL, which the preview portal has none of.
            if (screen.hotspot) await context.route("**/config.js", async (route) => { const r = await route.fetch(); await route.fulfill({ response: r, body: `${await r.text()}\nwindow.NDAHI_CONFIG.hotspotLoginUrl="https://hotspot.ndahi.test/login";` }); });
            const page = await context.newPage();
            const origin = screen.app === "admin" ? admin : screen.app === "store" ? storeSite : portal;
            return await withFailureShot(page, files, () => captureBuild(page, screen, { origin, fixtures: state.fixtures || {}, files, phone, timeout }));
          } finally { await context.close(); }
        }));
      }
    }
  } finally {
    await browser.close();
    manifest.finishedAt = new Date().toISOString();
    await writeManifest(dir, manifest);
  }
  return manifest;
}

// Writes manifest.json through a new, uniquely named file ("wx": fails rather
// than follow or reuse anything already there, mode 0600) and renames it into
// place, so a link planted at manifest.json is replaced, never written through.
export async function writeManifest(dir, manifest) {
  const target = join(dir, "manifest.json"), staging = join(dir, `.manifest-${randomUUID()}.json`);
  try {
    await writeFile(staging, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { force: true });
    throw error;
  }
}

export function summarize(manifest) {
  const count = (status) => manifest.results.filter((r) => r.status === status).length;
  return { captured: count("captured"), blocked: count("blocked"), failed: count("failed") };
}

async function boards() {
  const canvas = JSON.parse(await readFile(join(screensDir, "canvas.json"), "utf8"));
  const rows = Object.values(canvas.notes || {}).filter((note) => note.kind === "title1").sort((a, b) => a.y - b.y);
  const groups = rows.map((row) => ({ title: row.text, items: [] }));
  for (const name of canvas.order) {
    const board = canvas.boards[name];
    let index = 0;
    rows.forEach((row, i) => { if (row.y <= board.y) index = i; });
    groups[index].items.push({ file: name, title: board.title || name, width: board.w, height: board.h, x: board.x });
  }
  groups.forEach((group) => group.items.sort((a, b) => a.x - b.x));
  return groups;
}

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(title)} — NDAHI redesign preview</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;600;700&family=Playfair+Display:wght@600&display=swap">
<style>body{margin:0;background:#fbfaf5;color:#10241c;font:15px/1.5 'DM Sans',system-ui,sans-serif}a{color:#003b2b}header{background:#003b2b;color:#fff;padding:18px 24px}header a{color:#b9ee2e}h1,h2{font-family:'Playfair Display',serif;font-weight:600;margin:0}main{max-width:1280px;margin:0 auto;padding:24px}section{margin:0 0 32px}.cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;margin-top:12px}.card{background:#fffef9;border:1px solid #dfe5dc;border-radius:12px;padding:14px}.meta{color:#5c6963;font-size:13px}.pill{display:inline-block;padding:2px 9px;border-radius:999px;background:#eef0ee;color:#3d4a44;font-size:12px;font-weight:700}.pill.done{background:#eaf6d5;color:#345000}.pill.blocked{background:#fff1d6;color:#6b4a00}.pill.failed{background:#fde2df;color:#8a1c12}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;align-items:start;margin-top:12px}.pair img{display:block;max-width:100%;border:1px solid #dfe5dc;border-radius:8px;background:#fff}.pair figure{margin:0}.pair figcaption{font-weight:700;margin-bottom:6px}.problem{background:#fde2df;color:#8a1c12;border-radius:8px;padding:10px 12px}.note{background:#fff1d6;color:#6b4a00;border-radius:8px;padding:10px 12px}button{min-height:44px;padding:0 16px;border:0;border-radius:10px;background:#b9ee2e;color:#15210c;font:700 15px 'DM Sans',sans-serif;cursor:pointer}code{background:#eef3e9;padding:1px 5px;border-radius:5px}</style>
</head><body><header><strong>NDAHI redesign preview</strong> · <a href="/">Screens</a> · <a href="/compare">Design vs build</a> · <a href="${portal}/dashboard">Open the portal</a></header><main>${body}</main></body></html>`;
}

const statusPill = (s) => `<span class="pill${s.status.startsWith("Redesigned") ? " done" : ""}">${escape(s.status)}</span>${s.blocked ? ` <span class="pill blocked">Blocked fixture</span>` : ""}`;
function buildHref(s, state) {
  // A screen that needs a saved checkout opens through this server, which sets it.
  if (s.checkout) return state.fixtures?.[s.checkout] ? `/open/${encodeURIComponent(s.id)}` : null;
  // A demo account's screen opens through this server, which signs it in.
  if (s.account) return state.accounts?.[s.account] ? `/sign-in/portal/${encodeURIComponent(s.account)}` : null;
  const base = s.app === "store" ? storeSite : s.app === "admin" ? admin : portal;
  try { return base + resolvePath(s.path, state.fixtures || {}); } catch { return null; }
}

async function indexPage(state) {
  const groups = await boards();
  const card = (s) => {
    const href = buildHref(s, state);
    const props = s.design ? `?${s.design}` : "";
    const boardsOf = [s.phone && `<a href="/design/${s.phone}.dc.html${escape(props)}">phone</a>`, s.desktop && `<a href="/design/${s.desktop}.dc.html${escape(props)}">desktop</a>`].filter(Boolean).join(" · ");
    return `<div class="card"><strong>${escape(s.title)}</strong> ${statusPill(s)}
    <p class="meta">Design: ${boardsOf}<br>Build: ${href ? `<a href="${escape(href)}">${escape(s.path.replace(/\{\w+\}/g, "…"))}</a>` : "demo fixture unavailable"}${s.signedOut ? " (signed out)" : ""}</p>${s.blocked ? `<p class="meta">${escape(s.blocked)}.</p>` : ""}</div>`;
  };
  const design = groups.map((g) => `<section><h2>${escape(g.title)}</h2><div class="cards">${g.items.map((i) => `<div class="card"><a href="/design/${escape(i.file)}"><strong>${escape(i.title)}</strong></a><p class="meta">${escape(i.file)} · ${i.width} × ${i.height}</p></div>`).join("")}</div></section>`).join("");
  const warnings = (state.warnings || []).map((w) => `<p class="note">${escape(w)}</p>`).join("");
  return page("Screens", `${warnings}<section><h1>Customer portal and public store</h1>
    <p>Sign in at <a href="${portal}/login">${portal}/login</a>: phone <code>${DEMO.phone}</code>, voucher code <code>${escape(state.code)}</code>, then PIN <code>${DEMO.pin}</code> (today's sign-in still asks for the code; the PIN-only sign-in is a later phase). In-memory demo data; payments use the mock provider (look for <em>Simulate payment approval</em>). Add <code>?ui=old</code> to any portal address to see v1, <code>?ui=new</code> to come back.</p>
    <p><a href="/sign-in/portal"><strong>Open the portal signed in as ${escape(DEMO.name)}</strong></a> (skips the sign-in form).</p>
    <div class="cards">${SCREENS.filter((s) => s.app !== "admin").map(card).join("")}</div><p class="meta">Design kit reference: <a href="${portal}/ui-kit.html">${portal}/ui-kit.html</a></p></section>
    <section><h1>Admin — built so far</h1><p>Open the admin signed in as <a href="/sign-in/admin/owner"><strong>owner</strong></a>, <a href="/sign-in/admin/operator">operator</a> or <a href="/sign-in/admin/reseller">reseller</a> (demo staff; today's admin sign-in method stays until Phase 6).</p>
    <div class="cards">${SCREENS.filter((s) => s.app === "admin").map(card).join("")}</div></section>
    <section><h1>The design canvas</h1><p class="meta">Rendered locally from <code>docs/redesign/screens/</code>. Links between screens work as on the canvas; props go in the address, for example <a href="/design/PhoneOrder.dc.html?guest=true">PhoneOrder.dc.html?guest=true</a>.</p></section>${design}`);
}

export async function readManifest(dir) {
  try { return JSON.parse(await readFile(join(dir || await captureDir(), "manifest.json"), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

function figure(entry, label, stamp) {
  if (!entry) return `<figure><figcaption>${escape(label)}</figcaption><p class="meta">Not captured in the last run.</p></figure>`;
  const meta = `<p class="meta">${entry.viewport.width} × ${entry.viewport.height} · ${escape(entry.state || "")}${entry.settled === false ? " · still changing when taken" : ""}${entry.url ? ` · <code>${escape(entry.url.replace(/#.*$/, "#…"))}</code>` : ""}</p>`;
  if (entry.status === "failed") {
    return `<figure><figcaption>${escape(label)} <span class="pill failed">Failed</span></figcaption><p class="problem">${escape(entry.error)}</p>${entry.failedFile ? `<p class="meta"><a href="/captures/${escape(entry.failedFile)}?${stamp}">What was on screen</a> (not a comparison).</p>` : ""}${meta}</figure>`;
  }
  const pill = entry.status === "blocked" ? ` <span class="pill blocked">Blocked</span>` : ` <span class="pill done">Captured</span>`;
  return `<figure><figcaption>${escape(label)}${pill}</figcaption>${entry.blocked ? `<p class="note">Not the artboard's state: ${escape(entry.blocked)}.</p>` : ""}<img loading="lazy" src="/captures/${escape(entry.file)}?${stamp}" alt="${escape(label)}">${entry.fullFile ? `<p class="meta"><a href="/captures/${escape(entry.fullFile)}?${stamp}">Whole page</a></p>` : ""}${meta}</figure>`;
}

async function comparePage(state) {
  const dir = await captureDir(), manifest = await readManifest(dir), stamp = Date.now();
  const find = (s, kind, width) => manifest && manifest.results.find((r) => r.id === s.id && r.kind === kind && r.width === width);
  const rows = SCREENS.map((s) => `<section><h2>${s.app === "admin" ? "Admin · " : s.app === "store" ? "Store · " : ""}${escape(s.title)} ${statusPill(s)}</h2>
    ${widths(s).map((width) => `<div class="pair">${figure(find(s, "design", width), `Design · ${width}px (${width < 768 ? s.phone : s.desktop})`, stamp)}${figure(find(s, "build", width), `Build · ${width}px`, stamp)}</div>`).join("")}</section>`).join("");
  const totals = manifest && summarize(manifest);
  const run = manifest
    ? `<p>Last run ${escape(manifest.finishedAt || manifest.startedAt)} from <code>${escape(String(manifest.source.sha).slice(0, 12))}</code>${manifest.source.dirty ? " with uncommitted changes" : ""}: ${totals.captured} captured, ${totals.blocked} blocked, ${totals.failed} failed.</p>${(manifest.warnings || []).map((w) => `<p class="note">${escape(w)}</p>`).join("")}`
    : `<p class="note">No captures yet.</p>`;
  return page("Design vs build", `<section><h1>Design vs build</h1><p>Each canvas artboard beside the running v2 app. A build capture only counts when the page landed on the right address and showed the screen's expected UI; <em>Blocked</em> means the preview has no data to reach the artboard's state, so the picture shows what the page does instead. Phone captures are one 390 × 844 screen (with a whole-page link when the page scrolls); desktop captures are the whole page.</p>
    ${run}<form method="post" action="/captures"><button>Capture again</button></form>${state.capturing ? `<p class="note">A capture run is in progress.</p>` : ""}<p class="meta">Captures and <code>manifest.json</code> are saved in <code>${escape(dir)}</code>.</p></section>${rows}`);
}

const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png" };
function startDesign(state) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, design);
    const send = (status, type, body) => { res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    try {
      if (url.pathname === "/") return send(200, TYPES[".html"], await indexPage(state));
      if (url.pathname === "/compare") return send(200, TYPES[".html"], await comparePage(state));
      if (url.pathname === "/captures" && req.method === "POST") {
        if (state.capturing) return send(409, "text/plain", "A capture run is already in progress.");
        state.capturing = true;
        try { await capture(state); } finally { state.capturing = false; }
        res.writeHead(303, { location: "/compare" }); return res.end();
      }
      // One-click sign-in: hand the demo session to this browser (cookies ignore ports).
      const signIn = /^\/sign-in\/(portal|admin\/(owner|operator|reseller))(?:\/(\w+))?$/.exec(url.pathname);
      // /sign-in/portal/<moment> signs in as that renewal-moment demo account.
      const session = signIn && signIn[3] ? signIn[1] === "portal" && state.accounts?.[signIn[3]] : signIn && state.cookie;
      if (signIn && session) {
        const cookies = ["ndahi_ui=v2; Path=/; SameSite=Lax; HttpOnly", signIn[2]
          ? `admin_session=${state.staff[signIn[2]]}; Path=/; SameSite=Lax; HttpOnly`
          : `${session}; Path=/api/account; SameSite=Lax; HttpOnly`];
        res.writeHead(303, { "set-cookie": cookies, location: signIn[2] ? `${admin}/dashboard` : `${portal}/dashboard` });
        return res.end();
      }
      // Opens a screen that needs the guest's saved checkout cookie (cookies ignore ports).
      const opening = /^\/open\/([\w-]+)$/.exec(url.pathname), screen = opening && SCREENS.find((x) => x.id === opening[1] && x.checkout);
      if (screen && state.fixtures?.[screen.checkout]) {
        res.writeHead(303, { "set-cookie": ["ndahi_ui=v2; Path=/; SameSite=Lax; HttpOnly", `ndahi-checkout=${encodeURIComponent(state.fixtures[screen.checkout])}; Path=/; SameSite=Strict`], location: `${portal}${screen.path}` });
        return res.end();
      }
      if (url.pathname === "/design/support.js") return send(200, TYPES[".js"], await readFile(join(root, "scripts/redesign-preview-canvas.js")));
      const [, area, name] = /^\/(design|captures)\/([\w.-]+)$/.exec(url.pathname) || [];
      if (area && name && !name.includes("..")) {
        const folder = area === "design" ? screensDir : await captureDir(), file = join(folder, name);
        if (normalize(file).startsWith(folder.endsWith(sep) ? folder : folder + sep)) return send(200, TYPES[extname(name)] || "application/octet-stream", await readFile(file));
      }
      send(404, "text/plain", "Not found");
    } catch (error) {
      if (error.code === "ENOENT") return send(404, "text/plain", "Not captured yet: use Capture again on the comparison page.");
      // Details stay in the terminal; the browser gets no stack or paths.
      console.error("[preview]", req.method, url.pathname, error);
      send(500, "text/plain", "The preview hit an error; see its terminal output.");
    }
  });
  return listen(server, designPort).then(() => server);
}

const main = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  const state = await startApi();
  await startApps();
  await startDesign(state);
  console.log(`[preview] Portal  ${portal}/login  (phone ${DEMO.phone}, voucher code ${state.code}, then PIN ${DEMO.pin}; v2 by default)`);
  console.log(`[preview] Admin   ${admin}  (sign in as demo staff from ${design})`);
  console.log(`[preview] Design  ${design}  (canvas screens, design vs build, one-click sign-in)`);
  console.log(`[preview] Store   ${storeSite}  (public store for guests)`);
  console.log(`[preview] API     ${api}  (in-memory, mock providers)`);
  const captures = await captureDir();
  console.log(`[preview] Captures go to ${captures}`);
  if (process.argv.includes("--capture")) {
    state.capturing = true;
    const only = process.env.PREVIEW_CAPTURE_ONLY?.split(",").filter(Boolean);
    const manifest = await capture(state, { only }).finally(() => { state.capturing = false; });
    const totals = summarize(manifest);
    for (const r of manifest.results.filter((r) => r.status !== "captured")) console.log(`[preview] ${r.status.padEnd(7)} ${r.id} ${r.kind} ${r.width}px: ${r.error || r.blocked}`);
    console.log(`[preview] Captures in ${captures}:${totals.captured} captured, ${totals.blocked} blocked, ${totals.failed} failed (source ${manifest.source.sha}${manifest.source.dirty ? ", uncommitted changes" : ""})`);
    if (totals.failed) process.exitCode = 1;
  }
}
