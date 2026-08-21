import test from "node:test";
import assert from "node:assert/strict";
import { ResendEmailAdapter } from "../lib/email.mjs";

const delivery = {
  customer: { name: "Ada & Co", email: "ada@example.com" },
  payment: { amount: 500, currency: "XAF" },
  plan: { name: "Student Weekly", quotaGb: 5 },
  voucher: {
    id: "voucher-123",
    code: "NC-ABCD-2345",
    deviceLimit: 1,
    expiresAt: "2026-08-28T12:00:00.000Z",
  },
};

test("Resend sends a complete voucher confirmation with an idempotency key", async () => {
  let request;
  const adapter = new ResendEmailAdapter({
    apiKey: "secret",
    from: "NDAHI Connect <connect@updates.ndahiconnect.net>",
    portalUrl: "https://portal.ndahiconnect.net",
    fetcher: async (url, options) => {
      request = { url, options };
      return new Response(JSON.stringify({ id: "email-1" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  assert.deepEqual(await adapter.sendVoucher(delivery), { messageId: "email-1" });
  const body = JSON.parse(request.options.body);
  assert.equal(request.url, "https://api.resend.com/emails");
  assert.equal(request.options.headers["idempotency-key"], "voucher-confirmation/voucher-123");
  assert.deepEqual(body.to, ["ada@example.com"]);
  assert.match(body.text, /NC-ABCD-2345/);
  assert.match(body.text, /Student Weekly/);
  assert.match(body.html, /portal\.ndahiconnect\.net\/login/);
  assert.doesNotMatch(body.html, /Ada & Co/);
});

test("Resend errors are sanitized and do not expose the API key", async () => {
  const adapter = new ResendEmailAdapter({
    apiKey: "never-expose-me",
    from: "NDAHI <connect@example.com>",
    fetcher: async () => new Response(JSON.stringify({ message: "Domain not verified" }), { status: 403 }),
  });
  await assert.rejects(adapter.sendVoucher(delivery), (error) => {
    assert.match(error.message, /Domain not verified/);
    assert.doesNotMatch(error.message, /never-expose-me/);
    return true;
  });
});
