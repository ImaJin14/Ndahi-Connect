// Redesigned portal shell (customer-app-v2): one kit nav in the header, the
// hooks shared code relies on, and the journey selector helper for both versions.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TRANSLATIONS } from "../shared-app/i18n.js";

const root = new URL("..", import.meta.url).pathname;
const read = (path) => readFile(join(root, path), "utf8");

test("the v2 dashboard has one nav, inside the kit header, with the hooks shared code expects", async () => {
  const html = await read("customer-app-v2/index.html");
  assert.equal((html.match(/<nav\b/g) || []).length, 1, "one navigation landmark");
  const header = /<header class="nd-topnav nd-topnav--phone-bar">([\s\S]*?)<\/header>/.exec(html);
  assert.ok(header, "kit header");
  assert.match(header[1], /<nav id="portalNav" class="nd-topnav__links" aria-label="Main" data-i18n-aria-label="uiNavMain" hidden><\/nav>/);
  // shared-app/notifications.js puts the bell before `header #logout`; app.js binds #logout on load.
  assert.match(header[1], /<button id="logout"[^>]*>Logout<\/button>/);
  assert.match(header[1], /class="network-state nd-wide-only"/, "app.js updates .network-state");
  assert.doesNotMatch(html, /class="portal-nav"/, "the v1 nav is gone from v2");
  assert.match(html, /<section class="surface" id="shopPanel" data-portal-view="shop" hidden>/);
  assert.match(html, /href="\/shared\/ui\/tokens\.css"[\s\S]*href="\/shared\/ui\/components\.css"/);
  for (const key of [...html.matchAll(/data-i18n(?:-[\w-]+)?="(\w+)"/g)].map((match) => match[1])) {
    assert.ok(TRANSLATIONS.en[key] && TRANSLATIONS.fr[key], key);
  }
});

test("the v2 portal script keeps the exports other pages import and maps every v1 route", async () => {
  const source = await read("customer-app-v2/portal-nav.js");
  for (const name of ["activePortalView", "activePortalTab", "mountPortalNavigation", "mountThemeToggle"]) {
    assert.match(source, new RegExp(`export function ${name}\\(`), name);
  }
  // Every view a v1 panel or link uses still reaches a tab.
  const panelTabs = /const PANEL_TABS = (\{[^}]+\})/.exec(source)[1];
  for (const view of ["home", "bundles", "vouchers", "payments", "account", "shop"]) assert.match(panelTabs, new RegExp(`\\b${view}:`), view);
  const aliases = /const aliases = \{([^}]+)\}/.exec(source)[1];
  for (const route of ["internet", "activity", "devices", "managePlan", "billing", "accountSecurity", "notificationSettings", "sessionActivity", "sessions"]) {
    assert.match(aliases, new RegExp(`\\b${route}:`), route);
  }
  assert.match(source, /nd-keyboard-open/, "the tab bar hides while the on-screen keyboard is open");
});

test("v1 keeps its own navigation", async () => {
  const html = await read("customer-app/index.html");
  assert.match(html, /<nav id="portalNav" class="portal-nav" aria-label="Portal" hidden><\/nav>/);
  assert.doesNotMatch(await read("customer-app/portal-nav.js"), /shared\/ui/);
});

test("journey selectors follow the version under test", async () => {
  const saved = process.env.NDAHI_UI_VARIANT;
  try {
    delete process.env.NDAHI_UI_VARIANT;
    const v1 = await import("../scripts/portal-tabs.mjs?v1");
    process.env.NDAHI_UI_VARIANT = "v2";
    const v2 = await import("../scripts/portal-tabs.mjs?v2");
    assert.equal(v1.uiV2, false);
    assert.equal(v1.portalTab("payments"), '[data-portal-tab="payments"]');
    assert.equal(v1.portalTabBadge("payments"), '[data-portal-tab="payments"] .nav-badge');
    assert.equal(v1.portalNavDesktopWidth, 1000);
    assert.equal(v2.uiV2, true);
    assert.deepEqual(["home", "bundles", "vouchers", "payments", "account"].map(v2.portalTab),
      ["home", "internet", "internet", "activity", "account"].map((tab) => `[data-portal-tab="${tab}"]`));
    assert.equal(v2.portalTabBadge("payments"), '[data-portal-tab="activity"] .nd-topnav__badge');
    assert.equal(v2.portalNavDesktopWidth, 768);
  } finally {
    if (saved === undefined) delete process.env.NDAHI_UI_VARIANT;
    else process.env.NDAHI_UI_VARIANT = saved;
  }
  assert.match(await read("scripts/ui-v2-journeys.mjs"), /process\.env\.NDAHI_UI_VARIANT = "v2";/);
});
