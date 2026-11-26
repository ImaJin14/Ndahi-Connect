import assert from "node:assert/strict";
import http from "node:http";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { emailConfirmationCode, emailConfirmationLinkToken } from "../lib/transactional-email.mjs";
import { uiV2 } from "./portal-tabs.mjs";
const server = http.createServer();
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const portal = `http://127.0.0.1:${server.address().port}`;
const f = await pairingFixture({
  origin: portal,
  now: new Date(),
  liveClock: true,
  env: { NODE_ENV: "test", EMAIL_MODE: "mock", PAYMENT_MODE: "mock" },
});
await f.store.transaction((s) => {
  Object.assign(s.customers[0], {
    email: "owner@example.test",
    emailVerifiedAt: f.now().toISOString(),
  });
});
const baseline = await f.store.snapshot();
const assets = createStaticServer("customer", { apiUrl: f.api });
server.on("request", (req, res) => assets.emit("request", req, res));
let browser;
try {
  const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE || "playwright"
  );
  browser = await chromium.launch({
    headless: true,
    ...(process.env.PLAN_CHROME_PATH ? { executablePath: process.env.PLAN_CHROME_PATH } : {}),
  });
  for (const width of [320, 1280])
    // v2 (canvas: PhoneEditProfile, #398): the number is read-only, so name and
    // email are the fields; the PIN is asked after Save and a link confirms.
    for (const fields of uiV2 ? [["name"], ["email"], ["name", "email"]] : [
      ["name"],
      ["phone"],
      ["email"],
      ["name", "phone"],
      ["name", "email"],
      ["phone", "email"],
      ["name", "phone", "email"],
    ]) {
      const saveLabel = uiV2 ? "Save changes" : "Save profile";
      await f.store.transaction((s) =>
        Object.assign(s, structuredClone(baseline)),
      );
      const context = await browser.newContext({
        viewport: { width, height: 900 },
      });
      await context.addCookies([
        {
          name: "customer_session",
          value: "main",
          domain: "127.0.0.1",
          path: "/api/account",
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      await context.route("**/*", (route) =>
        [portal, f.api].includes(new URL(route.request().url()).origin)
          ? route.continue()
          : route.abort(),
      );
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      const errors = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(portal + "/dashboard#account");
      // v2 Account is a hub (canvas: PhoneAccount); its Edit link opens the profile page.
      const edit = uiV2
        ? page.locator('.portal-account a[href="/dashboard#editProfile"]:visible').first()
        : page.getByText("Edit profile", { exact: true });
      await edit.waitFor({ state: "visible" });
      if (!uiV2)
        assert.equal(
          await page.getByText("Edit profile", { exact: true }).count(),
          1,
        );
      assert.equal(
        await page.locator("#changeName,#changePhone,#linkEmail").count(),
        0,
      );
      await edit.focus();
      await page.keyboard.press("Enter");
      if (uiV2) await page.locator("#editProfile[open]").waitFor();
      const form = page.locator("#profileEdit");
      assert.equal(
        await form.getByLabel("Full name", { exact: true }).inputValue(),
        "Imajin",
      );
      if (uiV2) {
        const number = form.getByLabel("Phone number", { exact: true });
        assert.equal(await number.inputValue(), "+237 6•• •• 00 01");
        assert.equal(await number.getAttribute("readonly"), "");
        assert.equal(await form.locator('[name="phone"], [name="pin"]').count(), 0);
      } else {
      assert.equal(
        await form.getByLabel("Account number", { exact: true }).inputValue(),
        "+237670050001",
      );
      await page
        .getByText("Likely provider: MTN Mobile Money", { exact: true })
        .waitFor();
      }
      if (fields.includes("name"))
        await form.getByLabel("Full name", { exact: true }).fill("New Name");
      if (fields.includes("phone")) {
        await form
          .getByLabel("Account number", { exact: true })
          .fill("+237 690 050 099");
        await page
          .getByText("Likely provider: Orange Money", { exact: true })
          .waitFor();
        assert.equal(
          (await f.store.snapshot()).customers[0].phone,
          "670050001",
        );
      }
      if (fields.includes("email"))
        await form
          .getByLabel(uiV2 ? "Email" : "Email (optional)", { exact: true })
          .fill("new@example.test");
      if (!uiV2 && (fields.includes("phone") || fields.includes("email")))
        await form
          .getByLabel("Current PIN (for number or email changes)", { exact: true })
          .fill("2468");
      if (width === 320 && fields.length === 1 && fields[0] === "name") {
        await page.route(
          "**/api/account/profile",
          (route) =>
            route.fulfill({
              status: 503,
              json: { error: "Synthetic profile unavailable" },
            }),
          { times: 1 },
        );
        await form
          .getByRole("button", { name: saveLabel, exact: true })
          .click();
        await page.locator('#profileEditMessage [role="alert"]').waitFor();
        assert.equal(
          await form
            .getByRole("button", { name: saveLabel, exact: true })
            .isEnabled(),
          true,
        );
        assert.equal(
          await form.getByLabel("Full name", { exact: true }).inputValue(),
          "New Name",
        );
      }
      const uncertainPhone = width === 320 && fields.length === 1 && fields[0] === "phone";
    if (uncertainPhone) {
      await page.route("**/api/account/profile", route => route.abort("failed"), {times:1});
      await form.getByRole("button", {name:"Save profile",exact:true}).click();
      await page.locator('#profileEditMessage [role="alert"]').waitFor();
      assert.equal((await f.store.snapshot()).customers[0].phone,"670050001");
      assert.equal(await form.getByLabel("Account number",{exact:true}).inputValue(),"+237 690 050 099");
      await page.route("**/api/account/profile", async route => {await route.fetch();await route.abort("failed");}, {times:1});
    }
    const saved = uncertainPhone ? null : page.waitForResponse(r => r.url().endsWith("/api/account/profile") && r.request().method()==="POST");
    await form.getByRole("button", {name:saveLabel,exact:true}).click();
    if (uiV2 && fields.includes("email")) {
      // The PIN, asked after Save because the email changed.
      const dialog = page.locator("#profilePinDialog");
      await dialog.waitFor({ state: "visible" });
      await dialog.getByLabel("PIN", { exact: true }).fill("2468");
      await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
    }
    if(saved)assert.ok([200,202].includes((await saved).status()));
    if (uiV2 && fields.includes("email")) {
        await page.getByText("Saved. Check new@example.test to confirm it.", { exact: true }).waitFor();
        let c = (await f.store.snapshot()).customers[0];
        assert.equal(c.name, "Imajin");
        assert.equal(c.email, "owner@example.test");
        assert.equal(c.pendingEmail.method, "link");
        await f.handler.transactionalEmails.run();
        c = (await f.store.snapshot()).customers[0];
        const token = emailConfirmationLinkToken(c.id, c.pendingEmail, "pairing-tests");
        const mailbox = await context.newPage();
        mailbox.on("pageerror", (e) => errors.push(e.message));
        await mailbox.goto(`${portal}/confirm-email#${encodeURIComponent(token)}`);
        await mailbox.getByRole("button", { name: "Confirm email", exact: true }).click();
        await mailbox.getByRole("heading", { name: "Email confirmed", exact: true }).waitFor();
        await mailbox.close();
        // Confirming signs every device out; this journey signs back in to check the page.
        assert.equal((await f.store.snapshot()).dashboardSessions.some((x) => x.customerId === "c1"), false);
        await f.store.transaction((s) => { s.dashboardSessions.push(...structuredClone(baseline.dashboardSessions.filter((x) => x.customerId === "c1"))); });
    } else if (fields.includes("email")) {
        await page.locator("#confirmEmail").waitFor();
        let c = (await f.store.snapshot()).customers[0];
        assert.equal(c.name, "Imajin");
        assert.equal(c.phone, "670050001");
        assert.equal(c.email, "owner@example.test");
        await f.handler.transactionalEmails.run();
        await page.reload();
        await page.locator("#confirmEmail").waitFor();
        c = (await f.store.snapshot()).customers[0];
        const code = emailConfirmationCode(
          c.id,
          c.pendingEmail,
          "pairing-tests",
        );
        if (width === 320 && fields.length === 3)
          await page.route(
            "**/api/account/profile/email/confirm",
            async (route) => {
              await route.fetch();
              await route.abort("failed");
            },
            { times: 1 },
          );
        await page
          .getByLabel("Email confirmation code", { exact: true })
          .fill(code);
        await page
          .getByRole("button", { name: "Confirm email", exact: true })
          .click();
        await page.locator("#confirmEmail").waitFor({ state: "detached" });
      } else if (uiV2)
        await page.locator("#profileEditMessage", { hasText: "Saved." }).waitFor();
      else
        await page
          .getByText("Your profile was updated.", { exact: true })
          .waitFor();
      const s = await f.store.snapshot(),
        c = s.customers[0];
      assert.equal(c.id, "c1");
      assert.equal(c.name, fields.includes("name") ? "New Name" : "Imajin");
      assert.equal(
        c.phone,
        fields.includes("phone") ? "690050099" : "670050001",
      );
      assert.equal(
        c.email,
        fields.includes("email") ? "new@example.test" : "owner@example.test",
      );
      for (const key of [
        "payments",
        "vouchers",
        "routerCommands",
        "wifiDeviceGrants",
      ])
        assert.deepEqual(s[key], baseline[key]);
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth > innerWidth,
        ),
        false,
      );
      await page.reload();
      if (uiV2)
        await page
          .locator("#accountHubTitle:visible, #editProfileTitle:visible")
          .first()
          .waitFor();
      else
        await page
          .getByRole("heading", { name: "Your profile", exact: true })
          .waitFor();
      assert.deepEqual(errors, []);
      await context.close();
      console.log(
        `PASS ${fields.join("+")} fields, provider suggestion, atomic ownership/history, reload and responsive controls at ${width}px`,
      );
    }
} finally {
  await browser?.close();
  await f.close();
  await new Promise((r) => {
    server.close(r);
    server.closeAllConnections();
  });
}
