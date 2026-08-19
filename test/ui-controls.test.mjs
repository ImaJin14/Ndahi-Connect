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
  assert.match(files.customerLoginJs, /#login"\)\.onsubmit/);
  assert.match(files.customerVerifyJs, /#verify"\)\.onsubmit/);
  for (const id of ["continue", "closeCheckout"]) assert.match(files.onboardingJs, new RegExp(`#${id}.*\\.onclick`));
  assert.match(files.onboardingJs, /#purchase"\)\.onsubmit/);
  assert.match(files.onboardingJs, /openProvider\.onclick/);
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
