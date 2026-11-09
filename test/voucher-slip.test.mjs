import test from "node:test";
import assert from "node:assert/strict";
import { PNG } from "pngjs";
import jsQR from "jsqr";
import { prepareVoucherSlip, voucherPdf } from "../lib/voucher-pdf.mjs";
import {
  renderVoucherSlip,
  renderThermalSlipsHtml,
  sanitizePrintableVoucher,
  voucherSlipRows,
} from "../admin-app/voucher-slip.js";
import { ResendEmailAdapter } from "../lib/email.mjs";

const plan = {
  name: "Weekly",
  price: 1000,
  quotaGb: 5,
  validityHours: 168,
  deviceLimit: 2,
};
const voucher = {
  id: "private-id",
  code: "NC-TEST-2345",
  status: "active",
  activatedAt: "2030-01-01T12:00:00Z",
  expiresAt: "2030-01-08T12:00:00Z",
  quotaBytes: 5e9,
  usedBytes: 0,
  deviceLimit: 2,
};

test("shared slip protects identity, escapes fields, and preserves issued versus current status without mutation", () => {
  const source = {
    ...voucher,
    plan,
    phone: "670111222",
    customerId: "secret-owner",
    paymentId: "secret-payment",
  };
  const before = structuredClone(source),
    now = Date.parse("2031-01-01");
  const current = sanitizePrintableVoucher(source, {}, { now });
  assert.equal(current.statusLabel, "expired");
  assert.equal(
    sanitizePrintableVoucher(source, {}, { now, issued: true }).statusLabel,
    "active",
  );
  assert.equal(
    sanitizePrintableVoucher(
      { ...source, usedBytes: 5e9 },
      {},
      { now: Date.parse("2030-01-02") },
    ).statusLabel,
    "exhausted",
  );
  const html = renderVoucherSlip(current);
  for (const secret of ["670111222", "secret-owner", "secret-payment"])
    assert.ok(!html.includes(secret));
  assert.match(html, /2030-01-08 13:00/);
  assert.match(html, /does not reactivate/);
  assert.deepEqual(source, before);
  const dangerous = sanitizePrintableVoucher(
    {
      code: '<script>alert("x")</script>',
      status: "refunded",
      expiresAt: "bad-date",
    },
    { ...plan, name: "<img src=x onerror=alert(1)>" },
  );
  assert.doesNotMatch(renderVoucherSlip(dangerous), /<script>|<img src=x/i);
  assert.equal(dangerous.expiryNote, "Expiry not recorded");
  assert.equal(dangerous.statusLabel, "refunded");
});

test("canonical thermal PDF supports both widths and long fields on a single page with an embedded QR", async () => {
  for (const widthMm of [58, 80]) {
    const long = {
      ...plan,
      name: "Very long package name with Unicode é and details ".repeat(8),
    };
    const pdf = await voucherPdf({ voucher, plan: long, widthMm });
    const raw = pdf.toString("latin1");
    assert.equal((raw.match(/\/Type\s*\/Page\b/g) || []).length, 1);
    const box = raw.match(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/);
    assert.ok(box);
    assert.ok(Math.abs(Number(box[1]) - (widthMm * 72) / 25.4) < 0.01);
    assert.ok(Number(box[2]) + 0.01 >= (160 * 72) / 25.4);
    assert.match(raw, /\/Subtype \/Image/);
  }
});

test("email and customer PDFs share a slip model, purchase snapshot and decodable QR without a live send", async () => {
  const requests = [];
  const adapter = new ResendEmailAdapter({
    apiKey: "test",
    from: "hello@example.test",
    portalUrl: "https://portal.ndahiconnect.net",
    fetcher: async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return Response.json({ id: "test-email" });
    },
  });
  const input = {
    customer: {
      name: "Owner",
      email: "owner@example.test",
      phone: "670111222",
    },
    payment: { planSnapshot: plan },
    plan: { ...plan, name: "Changed catalogue", price: 99000 },
    voucher,
    deliveryKey: "test",
  };
  await adapter.sendVoucher(input);
  await adapter.sendVoucher(input);
  assert.deepEqual(requests[0], requests[1]);
  const body = requests[0],
    slip = await prepareVoucherSlip({ voucher, plan, issued: true });
  assert.ok(body.html.includes(renderVoucherSlip(slip, { email: true })));
  assert.doesNotMatch(
    body.html,
    /Changed catalogue|670111222|99000|data:image/,
  );
  assert.match(body.html, /cid:ndahi-voucher-qr/);
  for (const [, value] of voucherSlipRows(slip))
    assert.ok(body.text.includes(value));
  const [pdf, qr] = body.attachments;
  assert.deepEqual(
    Buffer.from(pdf.content, "base64"),
    await voucherPdf({ voucher, plan, issued: true }),
  );
  assert.equal(qr.content_id, "ndahi-voucher-qr");
  const png = PNG.sync.read(Buffer.from(qr.content, "base64"));
  const decoded = jsQR(new Uint8ClampedArray(png.data), png.width, png.height);
  assert.ok(decoded);
  const url = new URL(decoded.data);
  assert.equal(url.origin, "https://portal.ndahiconnect.net");
  assert.equal(url.searchParams.get("code"), voucher.code);
  assert.deepEqual([...url.searchParams.keys()].sort(), ["action", "code"]);
  // The admin renderer consumes the same model and safe field ordering.
  const html = renderThermalSlipsHtml(
    [{ ...voucher, plan, qrCode: slip.qrCode }],
    plan,
  );
  assert.match(html, /WI-FI VOUCHER SLIP/);
  assert.match(html, /1,000 FCFA/);
});
