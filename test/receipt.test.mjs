import test from "node:test";
import assert from "node:assert/strict";
import { receiptDocument, receiptText } from "../lib/receipt.mjs";
import { ensureReceipt } from "../lib/billing.mjs";
import { ResendEmailAdapter } from "../lib/email.mjs";
import { createServer, createStore } from "../server.mjs";

const paid = (overrides = {}, plan) => ensureReceipt({
  id: "7b5a07f7-f33b-4a68-a1eb-385d6693e62e", status: "paid", confirmedAt: "2026-10-02T13:05:00Z",
  amount: 2500, currency: "XAF", provider: "mesomb", providerReference: "MSB-8841273",
  customerName: "Amina Ndah", policyVersion: "2026-09-25",
  planSnapshot: { id: "weekly", name: "Weekly", quotaGb: 10, validityHours: 168, deviceLimit: 2 },
  ...overrides,
}, plan);
const text = (html) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the branded receipt shows the frozen payment and package details", () => {
  const html = receiptDocument(paid());
  for (const expected of ["Payment receipt", "Amount paid FCFA 2,500", "Paid 2 Oct 2026, 14:05 (Africa/Douala)", "Package Weekly",
    "Data 10 GB", "Validity 7 days", "Devices 2 devices", "Receipt number NC-7b5a07f7-f33b-4a68-a1eb-385d6693e62e",
    "Billed to Amina Ndah", "Payment method MeSomb mobile money", "Provider reference MSB-8841273",
    "Total paid FCFA 2,500", "Billing rules 2026-09-25"]) {
    assert.ok(text(html).includes(expected), expected);
  }
  assert.match(html, /^<!doctype html>\s*<html lang="en">/);
  assert.match(html, /<title>NDAHI Connect receipt NC-7b5a07f7/);
});

test("allowances read naturally, and missing historical values say so", () => {
  const daily = text(receiptDocument(paid({ provider: "flutterwave", planSnapshot: { name: "Daily", quotaGb: null, validityHours: 24, deviceLimit: 1 } })));
  for (const expected of ["Data Unlimited (fair use applies)", "Validity 1 day", "Devices 1 device", "Payment method Flutterwave"]) {
    assert.ok(daily.includes(expected), expected);
  }
  const legacy = text(receiptDocument(ensureReceipt({ id: "old", status: "paid", createdAt: "not-a-date", amount: 500, provider: "unknown-provider" },
    { name: "Historical", validityHours: 36 })));
  for (const expected of ["Data Not recorded", "Validity 36 hours", "Devices Not recorded", "Paid not-a-date", "Payment method unknown-provider",
    "Provider reference Not recorded for this historical payment", "Amount paid FCFA 500"]) {
    assert.ok(legacy.includes(expected), expected);
  }
  assert.ok(!legacy.includes("Billing rules"), "no policy line without a recorded version");
});

test("every field is escaped and the document loads nothing external", () => {
  const attack = '"><img src=x onerror=alert(1)><script>alert(2)</script>';
  const html = receiptDocument(paid({ customerName: attack, providerReference: attack, policyVersion: attack,
    planSnapshot: { name: attack, quotaGb: 1, validityHours: 24, deviceLimit: 1 } }));
  // Payloads survive only as escaped text; no tag or attribute reaches the markup.
  assert.doesNotMatch(html, /<img|<script/i);
  assert.ok(html.includes("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;&lt;script&gt;"));
  // It must work offline, in email clients, and under the download's style-only CSP.
  assert.doesNotMatch(html, /<link|<iframe|url\(|https?:\/\//i);
});

test("the plain-text receipt carries the same details for email", () => {
  // Currency formatting keeps the amount together with a non-breaking space.
  const plain = receiptText(paid(), { portalUrl: "https://portal.ndahi.test" }).replace(/\u00a0/g, " ");
  for (const expected of ["Amount paid: FCFA 2,500", "Package: Weekly", "Validity: 7 days", "Receipt number: NC-7b5a07f7",
    "Payment method: MeSomb mobile money", "Provider reference: MSB-8841273", "https://portal.ndahi.test/dashboard"]) {
    assert.ok(plain.includes(expected), expected);
  }
  assert.ok(!receiptText(paid()).includes("undefined"));
});

test("the receipt email sends the branded HTML and its text version", async () => {
  let sent;
  const adapter = new ResendEmailAdapter({ apiKey: "test", from: "receipts@example.test", portalUrl: "https://portal.ndahi.test",
    fetcher: async (_url, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify({ id: "sent" })); } });
  const receipt = paid();
  await adapter.sendReceipt({ to: "amina@example.test", receipt });
  assert.equal(sent.subject, `Your NDAHI Connect receipt ${receipt.number}`);
  assert.equal(sent.html, receiptDocument(receipt));
  assert.equal(sent.text, receiptText(receipt, { portalUrl: "https://portal.ndahi.test" }));
});

test("the downloaded receipt is branded and allows inline styles only", async (t) => {
  const server = createServer({ store: createStore({ persistent: false }), env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
    SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", ADMIN_PIN: "9999", LOG_LEVEL: "error",
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`, jar = [];
  const call = async (path, method = "GET", data) => {
    const response = await fetch(base + path, { method, headers: { "content-type": "application/json", cookie: jar.join("; ") }, body: data && JSON.stringify(data) });
    const cookie = response.headers.get("set-cookie");
    if (cookie) jar.push(cookie.split(";")[0]);
    return response;
  };
  const purchase = await (await call("/api/purchase", "POST", { phone: "670030001", planId: "weekly", name: "Receipt Customer" })).json();
  const confirmed = await (await call(`/api/payments/${purchase.payment.id}/confirm`, "POST")).json();
  await call("/api/account/setup/pin", "POST", { phone: "670030001", code: confirmed.access.code, pin: "2468", confirmPin: "2468" });
  const download = await call(`/api/account/payments/${purchase.payment.id}/receipt`);
  assert.equal(download.status, 200);
  const csp = download.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.match(csp, /style-src 'unsafe-inline'/);
  assert.doesNotMatch(csp, /script-src|img-src|connect-src/);
  assert.match(download.headers.get("content-disposition"), /^attachment; filename="ndahi-receipt-/);
  const html = await download.text();
  assert.ok(text(html).includes("Payment receipt") && text(html).includes("Package Weekly"));
  assert.ok(!html.includes(confirmed.access.code), "receipts never show the activation code");
});
