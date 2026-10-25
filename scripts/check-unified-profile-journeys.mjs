import assert from "node:assert/strict";
import http from "node:http";
import { createStaticServer } from "../static-server.mjs";
import { pairingFixture } from "../test/helpers/wifi-pairing-fixture.mjs";
import { emailConfirmationCode } from "../lib/transactional-email.mjs";
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
  browser = await chromium.launch({ headless: true });
  for (const width of [320, 1280])
    for (const fields of [
      ["name"],
      ["phone"],
      ["email"],
      ["name", "phone"],
      ["name", "email"],
      ["phone", "email"],
      ["name", "phone", "email"],
    ]) {
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
      assert.equal(
        await page.getByText("Edit profile", { exact: true }).count(),
        1,
      );
      assert.equal(
        await page.locator("#changeName,#changePhone,#linkEmail").count(),
        0,
      );
      await page.getByText("Edit profile", { exact: true }).focus();
      await page.keyboard.press("Enter");
      const form = page.locator("#profileEdit");
      assert.equal(
        await form.getByLabel("Full name", { exact: true }).inputValue(),
        "Imajin",
      );
      assert.equal(
        await form.getByLabel("Account number", { exact: true }).inputValue(),
        "+237670050001",
      );
      await page
        .getByText("Likely provider: MTN Mobile Money", { exact: true })
        .waitFor();
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
          .getByLabel("Email (optional)", { exact: true })
          .fill("new@example.test");
      if (fields.includes("phone") || fields.includes("email"))
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
          .getByRole("button", { name: "Save profile", exact: true })
          .click();
        await page.locator('#profileEditMessage [role="alert"]').waitFor();
        assert.equal(
          await form
            .getByRole("button", { name: "Save profile", exact: true })
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
    await form.getByRole("button", {name:"Save profile",exact:true}).click();
    if(saved)assert.ok([200,202].includes((await saved).status()));
    if (fields.includes("email")) {
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
      } else
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
