// Browser checks for the design kit reference page (redesign Phase 1):
//   node scripts/check-ui-kit-journeys.mjs
// The page exists only in customer-app-v2, so every context opts in with the
// ndahi_ui=v2 cookie. Screenshots go to /tmp/ndahi-ui-kit-checks.
import assert from "node:assert/strict";
import http from "node:http";
import { mkdir } from "node:fs/promises";
import { createStaticServer } from "../static-server.mjs";

const site = http.createServer();
await new Promise((resolve) => site.listen(0, "127.0.0.1", resolve));
const portal = `http://127.0.0.1:${site.address().port}`;
const assets = createStaticServer("customer", { apiUrl: "http://127.0.0.1:9" });
site.on("request", (req, res) => assets.emit("request", req, res));
const screenshots = "/tmp/ndahi-ui-kit-checks";
let browser, checks = 0;

async function scenario(name, work, { width = 390, lang = "en", mobile = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: lang === "fr" ? "fr-FR" : "en-US", isMobile: mobile, hasTouch: mobile });
  await context.addCookies([{ name: "ndahi_ui", value: "v2", domain: "127.0.0.1", path: "/", httpOnly: true, sameSite: "Lax" }]);
  // Hermetic by default like the other journeys; UI_KIT_FONTS=1 also loads
  // Google Fonts (allowed by the CSP) for screenshots that match the canvas.
  const allowed = [portal, ...(process.env.UI_KIT_FONTS === "1" ? ["https://fonts.googleapis.com", "https://fonts.gstatic.com"] : [])];
  await context.route("**/*", (route) => (allowed.includes(new URL(route.request().url()).origin) ? route.continue() : route.abort()));
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(15000);
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && !/net::ERR_|Failed to load resource/.test(message.text())) errors.push(message.text()); });
  await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (event) => console.error(`CSP ${event.violatedDirective} ${event.blockedURI}`)));
  try {
    await page.goto(portal + "/ui-kit.html");
    await page.locator("#kit-tabbar .nd-tabbar").waitFor();
    await work(page);
    assert.deepEqual(errors, [], "no console errors or CSP violations");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, "no sideways scrolling");
    console.log("PASS " + name);
    checks++;
  } catch (error) {
    await page.screenshot({ path: `${screenshots}/failure-${checks}.png`, fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await context.close();
  }
}

// Measures every rendered text run against the background it actually sits
// on (semi-transparent layers blended), so a light-surface colour used on a
// dark surface fails here even though each token pair passes on its own.
// Large text (24px, or 18.66px bold) needs 3:1, the rest 4.5:1.
const lowContrastText = (page) => page.evaluate(() => {
  const rgba = (value) => {
    const parts = value.match(/[\d.]+/g).map(Number);
    return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
  };
  const blend = ([r, g, b, a], under) => [r * a + under[0] * (1 - a), g * a + under[1] * (1 - a), b * a + under[2] * (1 - a)];
  const luminance = (rgb) => {
    const [r, g, b] = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const backdrop = (element) => {
    const layers = [];
    for (let node = element; node; node = node.parentElement) {
      const colour = rgba(getComputedStyle(node).backgroundColor);
      if (colour[3] > 0) { layers.push(colour); if (colour[3] === 1) break; }
    }
    return layers.reduceRight((under, layer) => blend(layer, under), [255, 255, 255]);
  };
  const failures = [];
  document.querySelectorAll("body *").forEach((element) => {
    const text = [...element.childNodes].filter((node) => node.nodeType === 3).map((node) => node.textContent).join("").trim();
    const box = element.getBoundingClientRect();
    if (!text || !box.width || !box.height || element.closest(".nd-visually-hidden, [disabled], [aria-disabled='true'], .nd-skip-link")) return;
    const style = getComputedStyle(element);
    const under = backdrop(element), colour = blend(rgba(style.color), under);
    const [light, dark] = [luminance(colour), luminance(under)].sort((a, b) => b - a);
    const ratio = (light + 0.05) / (dark + 0.05), size = parseFloat(style.fontSize);
    const minimum = size >= 24 || (size >= 18.66 && Number(style.fontWeight) >= 700) ? 3 : 4.5;
    if (ratio < minimum) failures.push(`${element.tagName}.${element.className} "${text.slice(0, 30)}" ${ratio.toFixed(2)}:1`);
  });
  return failures;
});

const outline = (locator) => locator.evaluate((element) => {
  const style = getComputedStyle(element);
  return { style: style.outlineStyle, width: style.outlineWidth, color: style.outlineColor };
});

try {
  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}) });
  await mkdir(screenshots, { recursive: true });

  for (const lang of ["en", "fr"]) for (const width of [320, 390, 1280]) {
    await scenario(`kit page renders in ${lang} at ${width}px`, async (page) => {
      const french = lang === "fr";
      assert.equal(await page.getAttribute("html", "lang"), lang);
      assert.equal(await page.getAttribute("html", "data-ui-variant"), "v2");
      await page.getByRole("heading", { level: 1, name: french ? "Kit de design NDAHI" : "NDAHI design kit" }).waitFor();
      const tabs = page.locator("#kit-tabbar").getByRole("navigation", { name: french ? "Navigation principale" : "Main" });
      for (const label of french ? ["Accueil", "Internet", "Boutique", "Activité", "Compte"] : ["Home", "Internet", "Shop", "Activity", "Account"]) {
        await tabs.getByRole("link", { name: label, exact: true }).waitFor();
      }
      assert.equal(await tabs.getByRole("link", { name: french ? "Accueil" : "Home" }).getAttribute("aria-current"), "page");
      await page.locator("#kit-sidemenu").getByRole("link", { name: french ? /Paiements, 2 à traiter/ : /Payments, 2 need attention/ }).waitFor();
      await page.getByRole("button", { name: french ? "Afficher le code PIN" : "Show PIN" }).waitFor();
      await page.getByText(french ? "Étape 2 sur 3" : "Step 2 of 3", { exact: true }).waitFor();
      await page.getByRole("switch", { name: french ? "Alertes de données faibles" : "Low data alerts" }).waitFor();
      // Every text node either changed language or is shared (codes, placeholders, brand).
      const leftovers = french ? await page.evaluate(() => [...document.querySelectorAll("[data-i18n]")].filter((element) => /\b(the|your|and)\b/i.test(element.textContent)).map((element) => element.textContent)) : [];
      assert.deepEqual(leftovers, [], "untranslated French strings");
      assert.deepEqual(await lowContrastText(page), [], "rendered text contrast");
      await page.screenshot({ path: `${screenshots}/kit-${lang}-${width}.png`, fullPage: true });
    }, { lang, width });
  }

  await scenario("keyboard users get a skip link and a visible focus ring on light and forest surfaces", async (page) => {
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => document.activeElement.className), "nd-skip-link");
    await page.keyboard.press("Enter");
    assert.equal(await page.evaluate(() => document.activeElement.id), "kit-main");
    for (let i = 0; i < 12 && !(await page.evaluate(() => document.activeElement.classList.contains("nd-btn"))); i++) await page.keyboard.press("Tab");
    assert.deepEqual(await outline(page.locator(":focus")), { style: "solid", width: "3px", color: "rgb(0, 59, 43)" });
    await page.locator("#kit-sidemenu .nd-sidemenu__item").first().focus();
    assert.deepEqual(await outline(page.locator(":focus")), { style: "solid", width: "3px", color: "rgb(185, 238, 46)" }, "lime ring on forest");
    await page.locator("#kit-plans .nd-option").first().click();
    assert.equal((await outline(page.locator("#kit-plans .nd-option").first())).style, "none", "no ring after a mouse click");
  });

  await scenario("tabs, choice groups, switches and the stepper respond to keyboard and pointer", async (page) => {
    const bundles = page.getByRole("tab", { name: "Bundles" }), vouchers = page.getByRole("tab", { name: "Vouchers" });
    await bundles.focus();
    await page.keyboard.press("ArrowRight");
    assert.equal(await vouchers.getAttribute("aria-selected"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "kit-tab-vouchers");
    assert.equal(await page.locator("#kit-panel-vouchers").isVisible(), true);
    assert.equal(await page.locator("#kit-panel-bundles").isHidden(), true);
    assert.equal(await bundles.getAttribute("tabindex"), "-1");
    await page.keyboard.press("Home");
    assert.equal(await bundles.getAttribute("aria-selected"), "true");

    const methods = page.locator("#kit-methods");
    await methods.getByRole("button", { name: "Orange Money" }).click();
    assert.equal(await methods.getByRole("button", { name: "Orange Money" }).getAttribute("aria-pressed"), "true");
    assert.equal(await methods.getByRole("button", { name: "MTN MoMo" }).getAttribute("aria-pressed"), "false");

    const updates = page.getByRole("switch", { name: "Shop order updates" });
    assert.equal(await updates.isChecked(), false);
    await updates.focus();
    await page.keyboard.press("Space");
    assert.equal(await updates.isChecked(), true);

    await page.locator("#kit-stepper").getByRole("button", { name: /Wi-Fi/ }).click();
    assert.equal(await page.locator("#kit-stepper").getByRole("button", { name: /Wi-Fi/ }).getAttribute("aria-current"), "step");
    assert.equal(await page.evaluate(() => document.activeElement.textContent.includes("Wi-Fi")), true, "focus follows the re-rendered step");
    assert.equal(await page.locator("#kit-stepper .nd-stepper__step--done").count(), 2);
  });

  await scenario("form errors are linked to their fields and the PIN can be shown and is hidden on submit", async (page) => {
    const phone = page.locator("#kit-phone"), pin = page.locator("#kit-pin"), form = page.locator("#kit-form");
    await form.getByRole("button", { name: "Sign in" }).click();
    assert.equal(await phone.getAttribute("aria-invalid"), "true");
    assert.equal(await page.evaluate(() => document.activeElement.id), "kit-phone", "focus moves to the first error");
    assert.deepEqual((await phone.getAttribute("aria-describedby")).split(" ").sort(), ["kit-phone-error", "kit-phone-hint"]);
    assert.equal((await page.locator("#kit-phone-error").textContent()).trim(), "Enter the phone number you pay with.");
    assert.equal(await pin.getAttribute("aria-invalid"), "true");

    await phone.fill("612 34 56 78");
    await pin.fill("2468");
    const toggle = page.getByRole("button", { name: "Show PIN" });
    await toggle.click();
    assert.equal(await pin.getAttribute("type"), "text");
    assert.equal(await page.getByRole("button", { name: "Hide PIN" }).textContent(), "Hide");
    assert.equal(await page.locator("[data-nd-pin-status]").textContent(), "Your PIN is visible.");
    await form.getByRole("button", { name: "Sign in" }).click();
    assert.equal(await pin.getAttribute("type"), "password", "the PIN is hidden again on submit");
    assert.equal(await phone.getAttribute("aria-invalid"), null);
    assert.equal(await phone.getAttribute("aria-describedby"), "kit-phone-hint", "the hint stays linked after the error clears");
    await page.waitForFunction(() => document.querySelector("[data-nd-live]").textContent === "Demo only: nothing was sent.");

    const busy = page.locator("#kit-busy");
    await busy.click();
    assert.equal(await busy.getAttribute("aria-busy"), "true");
    assert.equal(await busy.isDisabled(), true);
    assert.equal(await busy.locator(".nd-spinner").count(), 1);
    await page.waitForFunction(() => !document.getElementById("kit-busy").disabled);
    assert.equal(await busy.locator(".nd-spinner").count(), 0);
  });

  await scenario("switching to French relabels every component, is remembered and re-translates errors", async (page) => {
    await page.locator("#kit-form").getByRole("button", { name: "Sign in" }).click();
    await page.locator("#kit-language").getByRole("button", { name: "Français" }).click();
    assert.equal(await page.getAttribute("html", "lang"), "fr");
    assert.equal(await page.title(), "Kit de design — NDAHI Connect");
    assert.equal(await page.locator("#kit-language-2").getByRole("button", { name: "Français" }).getAttribute("aria-pressed"), "true", "both language controls agree");
    assert.equal((await page.locator("#kit-phone-error").textContent()).trim(), "Saisissez le numéro avec lequel vous payez.");
    await page.getByRole("button", { name: "Afficher le code PIN" }).waitFor();
    await page.locator("#kit-tabbar").getByRole("link", { name: "Boutique" }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem("ndahi-lang")), "fr");
    await page.reload();
    await page.locator("#kit-tabbar .nd-tabbar").waitFor();
    assert.equal(await page.getAttribute("html", "lang"), "fr");
    await page.locator("#kit-language-2").getByRole("button", { name: "English" }).click();
    assert.equal(await page.getAttribute("html", "lang"), "en");
    await page.getByRole("button", { name: "Show PIN" }).waitFor();
  });

  await scenario("touch targets are at least 44px on a phone (24px for links beside labels, inline links exempt)", async (page) => {
    const small = await page.evaluate(() => {
      const failures = [];
      document.querySelectorAll("#kit-main a, #kit-main button, #kit-main input:not([type=checkbox]), #kit-main select, #kit-main .nd-switch, .kit-head button").forEach((element) => {
        const box = element.getBoundingClientRect();
        if (!box.width || !box.height || element.closest(".nd-visually-hidden")) return;
        // Links inside a sentence are exempt (WCAG 2.5.8 inline exception).
        if (element.tagName === "A" && element.closest("p")) return;
        const minimum = element.tagName === "A" && element.closest(".nd-label-row") ? 24 : 44;
        if (box.height < minimum || (element.classList.contains("nd-icon-btn") && box.width < 44)) failures.push(`${element.tagName}.${element.className} ${Math.round(box.width)}x${Math.round(box.height)} "${element.textContent.trim().slice(0, 30)}"`);
      });
      return failures;
    });
    assert.deepEqual(small, []);
  }, { mobile: true });

  console.log(`PASS ${checks} design kit browser journeys`);
} finally {
  await browser?.close();
  await new Promise((resolve) => { site.close(resolve); site.closeAllConnections(); });
}
