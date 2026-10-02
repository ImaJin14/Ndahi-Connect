import test from "node:test";
import assert from "node:assert/strict";
import { receiptDocument, receiptText, receiptView, paymentMethodLabel } from "../lib/receipt.mjs";
import { receiptPdf, receiptFilename } from "../lib/receipt-pdf.mjs";
import { ensureReceipt, paymentView } from "../lib/billing.mjs";
import { createPaymentRoutes } from "../lib/api/payments.mjs";
import { ResendEmailAdapter } from "../lib/email.mjs";
import { createServer, createStore } from "../server.mjs";

const paid = (overrides = {}, plan) => ensureReceipt({
  id: "7b5a07f7-f33b-4a68-a1eb-385d6693e62e", status: "paid", confirmedAt: "2026-10-02T13:05:00Z",
  amount: 2500, currency: "XAF", provider: "mesomb", network: "mtn", providerReference: "MSB-8841273",
  customerName: "Amina Ndah", policyVersion: "2026-09-25",
  planSnapshot: { id: "weekly", name: "Weekly", quotaGb: 10, validityHours: 168, deviceLimit: 2 },
  ...overrides,
}, plan);
const text = (html) => html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the branded receipt shows the frozen payment and package details", () => {
  const html = receiptDocument(paid());
  for (const expected of ["Payment receipt", "Amount paid FCFA 2,500", "Paid 2 Oct 2026, 14:05 (Africa/Douala)", "Package Weekly",
    "Data 10 GB", "Validity 7 days", "Devices 2 devices", "Receipt number NC-7b5a07f7-f33b-4a68-a1eb-385d6693e62e",
    "Billed to Amina Ndah", "Payment method MTN Mobile Money", "Provider reference MSB-8841273",
    "Total paid FCFA 2,500", "Billing rules 2026-09-25"]) {
    assert.ok(text(html).includes(expected), expected);
  }
  assert.match(html, /^<!doctype html>\s*<html lang="en">/);
  assert.match(html, /<title>NDAHI Connect receipt NC-7b5a07f7/);
});

test("allowances read naturally, and missing historical values say so", () => {
  const daily = text(receiptDocument(paid({ provider: "flutterwave", network: "orange", planSnapshot: { name: "Daily", quotaGb: null, validityHours: 24, deviceLimit: 1 } })));
  for (const expected of ["Data Unlimited (fair use applies)", "Validity 1 day", "Devices 1 device", "Payment method Orange Money"]) {
    assert.ok(daily.includes(expected), expected);
  }
  const legacy = text(receiptDocument(ensureReceipt({ id: "old", status: "paid", createdAt: "not-a-date", amount: 500, provider: "unknown-provider" },
    { name: "Historical", validityHours: 36 })));
  for (const expected of ["Data Not recorded", "Validity 36 hours", "Devices Not recorded", "Paid not-a-date", "Payment method Mobile Money",
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
    "Payment method: MTN Mobile Money", "Provider reference: MSB-8841273", "https://portal.ndahi.test/dashboard"]) {
    assert.ok(plain.includes(expected), expected);
  }
  assert.ok(!receiptText(paid()).includes("undefined"));
});

test("the receipt email sends branded HTML, text and an actual PDF attachment", async () => {
  let sent;
  const adapter = new ResendEmailAdapter({ apiKey: "test", from: "receipts@example.test", portalUrl: "https://portal.ndahi.test",
    fetcher: async (_url, options) => { sent = JSON.parse(options.body); return new Response(JSON.stringify({ id: "sent" })); } });
  const receipt = paid();
  await adapter.sendReceipt({ to: "amina@example.test", receipt });
  assert.equal(sent.subject, `Your NDAHI Connect receipt ${receipt.number}`);
  assert.equal(sent.html, receiptDocument(receipt));
  assert.equal(sent.text, receiptText(receipt, { portalUrl: "https://portal.ndahi.test" }));
  assert.equal(sent.attachments.length, 1);
  assert.equal(sent.attachments[0].filename, receiptFilename(receipt));
  assert.deepEqual(Buffer.from(sent.attachments[0].content, "base64"), await receiptPdf(receipt));
});

test("the receipt downloads as a private PDF and offers a safe popup preview", async (t) => {
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
  const purchase = await (await call("/api/purchase", "POST", { phone: "670030001", planId: "weekly", name: "Receipt Customer", network: "orange" })).json();
  const confirmed = await (await call(`/api/payments/${purchase.payment.id}/confirm`, "POST")).json();
  await call("/api/account/setup/pin", "POST", { phone: "670030001", code: confirmed.access.code, pin: "2468", confirmPin: "2468" });
  const download = await call(`/api/account/payments/${purchase.payment.id}/receipt`);
  assert.equal(download.status, 200);
  const csp = download.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline/);
  assert.doesNotMatch(csp, /script-src|img-src|connect-src/);
  assert.equal(download.headers.get("content-type"), "application/pdf");
  assert.equal(download.headers.get("content-disposition"), `attachment; filename="ndahi-receipt-${purchase.payment.id}.pdf"`);
  assert.equal(download.headers.get("cache-control"), "no-store");
  const pdf = Buffer.from(await download.arrayBuffer());
  assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  assert.match(pdf.toString("latin1"), /%%EOF\s*$/);
  const preview = await call(`/api/account/payments/${purchase.payment.id}/receipt?format=json`);
  assert.equal(preview.headers.get("cache-control"), "no-store");
  const { receipt } = await preview.json();
  assert.equal(receipt.plan.name, "Weekly");
  assert.equal(receipt.paymentId, purchase.payment.id);
  assert.ok(!JSON.stringify(receipt).includes(confirmed.access.code), "receipts never show the activation code");
});

test("receipts preserve network and safely enrich historical snapshots without changing paid details", () => {
  const p = { id: "old", status: "paid", network: "orange", provider: "mesomb", amount: 900,
    receipt: { paymentId: "old", amount: 500, plan: { name: "Original" }, provider: "mesomb" } };
  const record = ensureReceipt(p, { name: "Updated" });
  assert.equal(record.network, "orange");
  assert.equal(record.amount, 500);
  assert.equal(record.plan.name, "Original");
  assert.equal(receiptView(record).methodLabel, "Orange Money");
  p.network = "mtn";
  assert.equal(ensureReceipt(p).network, "orange", "recorded network is frozen after enrichment");
  assert.equal(paymentView(p).methodLabel, "Orange Money");
  for (const provider of ["mesomb", "flutterwave", "unknown-provider"]) {
    assert.equal(paymentMethodLabel({ provider }), "Mobile Money");
    assert.equal(paymentMethodLabel({ provider, network: "mtn" }), "MTN Mobile Money");
  }
});

test("expired unconfirmed records cannot advertise stale receipts or recheck recovery instructions", () => {
  for (const status of ["expired", "failed", "cancelled"]) {
    const p = { id: "closed", status, receipt: { number: "stale" }, creationState: "uncertain", verificationError: "unavailable" };
    assert.equal(ensureReceipt(p), null);
    const view = paymentView(p);
    assert.equal(view.receiptAvailable, false);
    assert.doesNotMatch(view.recoveryMessage || "", /recheck|do not pay again/i);
    assert.equal(view.refund, null);
  }
});

test("the preview shows current refund state without changing the original receipt", () => {
  const receipt = paid();
  const view = receiptView(receipt, { status: "completed", message: "<script>untrusted</script>" });
  assert.equal(view.refundStatus, "completed");
  assert.equal(view.refundMessage, "This payment has been refunded.");
  assert.equal(receipt.refundStatus, undefined);
  assert.equal(receiptView(receipt, { status: "invented" }).refundMessage, undefined);
});

test("PDF generation is deterministic for email retries and filenames cannot inject headers", async () => {
  const record = paid({ customerName: "Amina Ndah", planSnapshot: { name: "Weekly", quotaGb: null, validityHours: 168, deviceLimit: 2 } });
  assert.deepEqual(await receiptPdf(record), await receiptPdf(record));
  assert.equal(receiptFilename({ paymentId: 'bad"\r\nHeader: value' }), "ndahi-receipt-bad___Header__value.pdf");
});

test("receipt authorization is revalidated after a concurrent logout, reassignment or removal", async () => {
  for (const change of ["logout", "reassign", "remove"]) {
    const p = { id: "payment", customerId: "owner", status: "paid", amount: 500 };
    const session = { customerId: "owner" };
    const state = { payments: [p], dashboardSessions: [session] };
    let status;
    const res = { writeHead(code) { status = code; }, end() {} };
    const routes = createPaymentRoutes({ store: { snapshot: async () => state },
      auth: (_req, s) => s.dashboardSessions[0], sessionScope: () => ({}),
      mutate: async (fn) => {
        if (change === "logout") state.dashboardSessions = [];
        if (change === "reassign") session.customerId = "different";
        if (change === "remove") state.payments = [];
        return fn(state);
      },
    });
    await routes({ method: "GET" }, res, new URL("https://api.test/api/account/payments/payment/receipt"));
    assert.equal(status, change === "logout" ? 401 : 404);
  }
});
