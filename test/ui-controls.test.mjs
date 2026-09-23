import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = async (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("every static customer and admin button belongs to a handled form or click action", async () => {
  const files = {
    customerIndex: await source("customer-app/index.html"),
    customerLogin: await source("customer-app/login.html"),
    customerVerify: await source("customer-app/verify.html"),
    onboarding: await source("customer-app/onboarding.html"),
    adminIndex: await source("admin-app/index.html"),
    adminLogin: await source("admin-app/login.html"),
    customerApp: await source("customer-app/app.js"),
    customerLoginJs: await source("customer-app/login.js"),
    customerVerifyJs: await source("customer-app/verify.js"),
    onboardingJs: await source("customer-app/onboarding.js"),
    adminApp: await source("admin-app/app.js"),
    adminLoginJs: await source("admin-app/login.js"),
  };
  assert.match(files.customerApp, /#redeem"\)\.onsubmit/);
  assert.match(files.customerApp, /#logout"\)\.onclick/);
  assert.match(files.customerApp, /button\[data-session\]/);
  assert.match(files.customerApp, /#connectDevice/);
  assert.match(files.customerLoginJs, /#login"\)\.onsubmit/);
  assert.match(files.customerVerifyJs, /#verify"\)\.onsubmit/);
  assert.match(files.onboardingJs, /#closeCheckout"\)\.onclick/);
  assert.match(files.onboardingJs, /#purchase"\)\.onsubmit/);
  assert.match(files.onboardingJs, /ndahi-payment/);
  assert.match(files.onboardingJs, /paymentProvider === "flutterwave"/);
  assert.match(files.onboardingJs, /Payment confirmed/);
  assert.match(files.onboarding, /service fee is added separately/);
  assert.match(files.onboardingJs, /confirm\.onclick/);
  assert.match(files.adminLoginJs, /#login"\)\.onsubmit/);
  for (const id of ["bundle", "bundleEdit", "generate"]) assert.match(files.adminApp, new RegExp(`#${id}.*\\.onsubmit`));
  for (const id of ["syncUsage", "checkOmada", "enrollMfa", "disableMfa", "logout"]) assert.match(files.adminApp, new RegExp(`#${id}.*\\.onclick`));
  for (const action of ["editBundle", "cancel-edit", "deleteBundle", "voucher", "customer", "session", "refund"]) assert.ok(files.adminApp.includes(action), `missing delegated handler for ${action}`);
});

test("interactive status and modal surfaces expose accessible state", async () => {
  const onboarding = await source("customer-app/onboarding.html"),
    dashboard = await source("customer-app/index.html"),
    admin = await source("admin-app/app.js");
  assert.match(onboarding, /role="dialog"/);
  assert.match(onboarding, /aria-modal="true"/);
  assert.match(onboarding, /aria-live="polite"/);
  assert.match(dashboard, /role="status"/);
  assert.match(admin, /aria-live="assertive"/);
});

test("the customer dashboard shows account status before the device-activation form", async () => {
  const dashboard = await source("customer-app/index.html");
  const dashboardIndex = dashboard.indexOf('id="dashboard"'),
    activateIndex = dashboard.indexOf('id="activateDevice"');
  assert.ok(dashboardIndex >= 0 && activateIndex >= 0, "both sections must be present");
  assert.ok(dashboardIndex < activateIndex,
    "remaining data, time, plan, and connection state must appear before device activation (UX-001)");
});

test("plan browse, renew, and switch actions are grouped under one Manage plan area (UX-003)", async () => {
  const dashboard = await source("customer-app/index.html"), app = await source("customer-app/app.js");
  assert.doesNotMatch(dashboard, /class="welcome"[\s\S]*?<a class="button"/,
    "the welcome banner must not carry its own competing plan-navigation button");
  assert.equal((app.match(/onboarding\.html/g) || []).length, 3,
    "browse, renew, and switch must be the only onboarding links, all inside #managePlan");
  assert.match(app, /id="managePlan"[\s\S]*onboarding\.html[\s\S]*onboarding\.html\?action=switch/);
});

test("network status is driven from the API on every customer-facing page, not hardcoded (UX-004)", async () => {
  const files = {
    index: await source("customer-app/index.html"),
    login: await source("customer-app/login.html"),
    onboarding: await source("customer-app/onboarding.html"),
    app: await source("customer-app/app.js"),
    loginJs: await source("customer-app/login.js"),
    onboardingJs: await source("customer-app/onboarding.js"),
    networkStatus: await source("customer-app/network-status.js"),
  };
  for (const html of [files.index, files.login, files.onboarding]) {
    assert.doesNotMatch(html, /class="(network-state|panel-network)"[^>]*>Network online/,
      "no page may hardcode a claimed-online status; it must be fetched and applied at runtime");
  }
  assert.match(files.networkStatus, /unavailable/);
  assert.match(files.app, /applyNetworkStatus\(\$\("\.network-state"\), result\.zone\?\.status\)/);
  assert.match(files.app, /applyNetworkStatus\(\$\("\.network-state"\), "unavailable"\)/);
  assert.match(files.loginJs, /fetchNetworkStatus/);
  assert.match(files.onboardingJs, /fetchNetworkStatus/);
});

test("the dashboard explains and gives a next step for every empty and first-use state (UX-005)", async () => {
  const app = await source("customer-app/app.js");
  assert.match(app, /payment is being confirmed/, "pending voucher/payment state");
  assert.match(app, /data is used up/, "exhausted bundle state");
  assert.match(app, /bundle expired/, "expired bundle state");
  assert.match(app, /trouble connecting this bundle to the network/, "failed provisioning state");
  assert.match(app, /Finishing network setup/, "in-progress provisioning state");
  assert.match(app, /Activate a bundle to connect a device/, "no devices, no bundle state is distinct from no devices with an active bundle");
  assert.match(app, /No devices are currently connected/, "no devices, active bundle state");
  assert.match(app, /Choose a package to get started/, "never purchased state");
});

test("onboarding keeps authenticated renew and switch journeys account-aware", async () => {
  const onboarding = await source("customer-app/onboarding.js");
  assert.match(onboarding, /accountLink\.textContent = "My dashboard"/);
  assert.match(onboarding, /accountAction === "renew"/);
  assert.match(onboarding, /Switch to this plan/);
  assert.match(onboarding, /if \(accountAction\).*saveReturnPath/s);
});
