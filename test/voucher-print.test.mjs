import test from "node:test";
import assert from "node:assert/strict";
import { blank } from "../server.mjs";
import { createAdminVouchersRoutes } from "../lib/api/admin-vouchers.mjs";
import {
  VOUCHER_PRINT_LAYOUTS,
  formatAllowanceLabel,
  formatDeviceLabel,
  formatPriceFcfa,
  formatValidityLabel,
  renderQrBlockMarkup,
  renderThermalSlipsHtml,
  renderVoucherPrintLayout,
  sanitizePrintableVoucher,
} from "../admin-app/voucher-print.js";

test("format helpers produce clear FCFA, allowance, validity, and device strings", () => {
  assert.equal(formatPriceFcfa(1000), "1,000 FCFA");
  assert.equal(formatPriceFcfa(0), "0 FCFA");
  assert.equal(formatAllowanceLabel(5, 5e9), "5 GB");
  assert.equal(formatAllowanceLabel(null, null), "Unlimited data (fair use)");
  assert.equal(formatValidityLabel(24), "24 hours (1 day)");
  assert.equal(formatValidityLabel(168), "7 days (168 hours)");
  assert.equal(formatValidityLabel(720), "30 days (720 hours)");
  assert.equal(formatValidityLabel(12), "12 hours");
  assert.equal(formatDeviceLabel(1), "1 device");
  assert.equal(formatDeviceLabel(3), "3 devices");
  assert.equal(formatDeviceLabel(2, "home"), "All home devices");
});

test("sanitizePrintableVoucher strips all personal customer and payment identifiers", () => {
  const dirtyVoucher = {
    id: "v-123",
    code: "NC-ABCD-1234",
    status: "available",
    planId: "weekly",
    deviceLimit: 2,
    quotaBytes: 5e9,
    customerId: "cust-secret-99",
    customerName: "Amina Mbarga",
    name: "Amina Mbarga",
    phone: "670112233",
    phoneE164: "+237670112233",
    accountPhone: "670112233",
    payerPhone: "699887766",
    email: "amina@example.com",
    paymentId: "pay-secret-1",
    ownership: { customerId: "cust-secret-99", name: "Amina Mbarga", accountPhone: "670112233" },
    payment: { id: "pay-secret-1", payerPhone: "699887766", providerReference: "MOMO-REF-999" },
  };
  const plan = { id: "weekly", name: "Weekly", price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 2 };

  const safe = sanitizePrintableVoucher(dirtyVoucher, plan);
  assert.equal(safe.code, "NC-ABCD-1234");
  assert.equal(safe.planName, "Weekly");
  assert.equal(safe.priceLabel, "1,000 FCFA");
  assert.equal(safe.allowanceLabel, "5 GB");
  assert.equal(safe.validityLabel, "7 days (168 hours)");
  assert.equal(safe.deviceLabel, "2 devices");
  assert.equal(safe.expiryNote, "Starts on first redemption");

  const serialized = JSON.stringify(safe);
  for (const forbidden of [
    "cust-secret-99",
    "Amina Mbarga",
    "670112233",
    "+237670112233",
    "699887766",
    "amina@example.com",
    "pay-secret-1",
    "MOMO-REF-999",
  ]) {
    assert.ok(!serialized.includes(forbidden), `Leaked PII in sanitized model: ${forbidden}`);
  }
});

test("thermal POS slip layout renders 58mm and 80mm high-contrast slips without PII leakage", () => {
  const vouchers = [
    {
      id: "v1",
      code: "NC-POS1-5800",
      status: "available",
      customerId: "c-leak",
      customerName: "Private Customer",
      phone: "677889900",
      payerPhone: "699112233",
      email: "private@example.com",
    },
  ];
  const plan = { name: "Daily", price: 250, quotaGb: 1, validityHours: 24, deviceLimit: 1 };

  const html58 = renderThermalSlipsHtml(vouchers, plan, 58);
  assert.match(html58, /data-print-surface="thermal-58"/);
  assert.match(html58, /data-paper-width="58mm"/);
  assert.match(html58, /NDAHI CONNECT/);
  assert.match(html58, /NC-POS1-5800/);
  assert.match(html58, /250 FCFA/);
  assert.match(html58, /1 GB/);
  assert.match(html58, /24 hours \(1 day\)/);
  assert.match(html58, /Starts on first redemption/);
  assert.match(html58, /QR unavailable/);

  for (const pii of ["c-leak", "Private Customer", "677889900", "699112233", "private@example.com"]) {
    assert.ok(!html58.includes(pii), `Thermal slip leaked ${pii}`);
  }

  const html80 = renderVoucherPrintLayout(vouchers, plan, "thermal-80");
  assert.match(html80, /data-print-surface="thermal-80"/);
  assert.match(html80, /data-paper-width="80mm"/);
});

test("retired and unknown print layouts fall back to thermal slips without dropping bulk vouchers", () => {
  const vouchers = Array.from({ length: 25 }, (_, i) => ({ code: `NC-BULK-${i + 1}` }));
  for (const layout of ["a4-sheet", "unknown", undefined]) {
    const html = renderVoucherPrintLayout(vouchers, {}, layout);
    assert.match(html, /data-print-surface="thermal-58"/);
    assert.equal((html.match(/class="thermal-slip"/g) || []).length, 25);
    assert.ok(!html.includes("a4-voucher"));
  }
});

test("QR markup only accepts encoded PNG and cannot inject SVG or pretend to encode a missing QR", () => {
  assert.match(renderQrBlockMarkup({ code: "NC-TEST" }), /QR unavailable/);
  const malicious = '<svg onload="alert(1)"><text>Private customer</text></svg>';
  const safe = sanitizePrintableVoucher({ code: "NC-TEST", qrCode: malicious });
  assert.equal(safe.qrCode, "");
  assert.ok(!renderQrBlockMarkup({ code: "NC-TEST", qrCode: malicious }).includes("<svg"));
  assert.deepEqual(VOUCHER_PRINT_LAYOUTS, ["thermal-58", "thermal-80"]);
});

test("POST /api/admin/vouchers/print prepares a single active or available voucher slip with QR and enforces RBAC and PII boundaries", async () => {
  const s = blank();
  const route = createAdminVouchersRoutes({
    deliverVoucherEmail: async () => false,
    clock: () => new Date("2030-01-01T12:00:00Z"),
    customerOrigin: "https://portal.ndahiconnect.net",
  });
  s.customers.push(
    { id: "c-user-1", name: "User One", phone: "670111222", email: "user1@example.com" },
    { id: "c-no-voucher", name: "User Two", phone: "670333444" },
  );
  s.payments.push({
    id: "pay-1",
    customerId: "c-user-1",
    planId: "weekly",
    status: "paid",
    amount: 1000,
    payerPhone: "699000111",
    providerReference: "REF-SECRET-1",
  });
  s.vouchers.push(
    {
      id: "v-user-1",
      customerId: "c-user-1",
      paymentId: "pay-1",
      planId: "weekly",
      code: "NC-USER-0001",
      status: "active",
      activatedAt: "2030-01-01T12:00:00Z",
      expiresAt: "2030-01-08T12:00:00Z",
      quotaBytes: 5e9,
      usedBytes: 1e9,
      deviceLimit: 2,
    },
    {
      id: "v-reseller-own",
      customerId: null,
      planId: "daily",
      code: "NC-RESL-0002",
      status: "available",
      generatedByAdmin: true,
      generatedByAdminId: "staff-reseller",
      assignedResellerId: "staff-reseller",
      quotaBytes: 1e9,
      usedBytes: 0,
      deviceLimit: 1,
    },
    {
      id: "v-expired",
      customerId: "c-user-1",
      planId: "daily",
      code: "NC-EXPR-0003",
      status: "expired",
      expiresAt: "2029-12-31T12:00:00Z",
      quotaBytes: 1e9,
      usedBytes: 1e9,
      deviceLimit: 1,
    },
  );

  async function callPrint(i, role = "owner", adminUser = { id: `staff-${role}`, role }) {
    const res = {
      writeHead(status) { this.status = status; },
      end(value) { this.text = value; this.body = JSON.parse(value); },
    };
    await route(
      { method: "POST", headers: {}, socket: {}, adminActor: role },
      res,
      new URL("http://api.test/api/admin/vouchers/print"),
      { s, i, role, adminUser, administrator: { userId: adminUser?.id }, effects: {} },
    );
    return res;
  }

  // Print by voucherId
  const byVoucher = await callPrint({ voucherId: "v-user-1" }, "owner");
  assert.equal(byVoucher.status, 200);
  assert.equal(byVoucher.body.voucher.code, "NC-USER-0001");
  assert.match(byVoucher.body.voucher.qrCode, /^data:image\/png;base64,/);
  assert.equal(byVoucher.body.plan.name, "Weekly");
  assert.equal(byVoucher.body.voucher.customerId, undefined);
  assert.equal(byVoucher.body.voucher.paymentId, undefined);
  for (const forbidden of ["c-user-1", "User One", "670111222", "user1@example.com", "pay-1", "699000111", "REF-SECRET-1"]) {
    assert.ok(!byVoucher.text.includes(forbidden), `Print response leaked ${forbidden}`);
  }
  const activeSlipHtml = renderThermalSlipsHtml([byVoucher.body.voucher], byVoucher.body.plan, 58);
  assert.match(activeSlipHtml, /NC-USER-0001/);
  assert.match(activeSlipHtml, /Expires 2030-01-08/);
  assert.match(activeSlipHtml, /<img src="data:image\/png;base64,/);

  // Print by customerId
  const byCustomer = await callPrint({ customerId: "c-user-1" }, "operator");
  assert.equal(byCustomer.status, 200);
  assert.equal(byCustomer.body.voucher.id, "v-user-1");
  assert.equal(byCustomer.body.voucher.code, "NC-USER-0001");

  // Customer without active voucher -> 404
  const noActive = await callPrint({ customerId: "c-no-voucher" }, "owner");
  assert.equal(noActive.status, 404);
  assert.match(noActive.body.error, /does not have an active voucher/i);

  // Expired voucher -> 409
  const expiredRes = await callPrint({ voucherId: "v-expired" }, "owner");
  assert.equal(expiredRes.status, 409);
  assert.match(expiredRes.body.error, /Only active or available vouchers can be printed/);

  // Auditor denied -> 403
  const auditorRes = await callPrint({ voucherId: "v-user-1" }, "auditor");
  assert.equal(auditorRes.status, 403);

  // Reseller can print own stock, but not another customer's voucher or customerId lookup
  const resellerOwn = await callPrint({ voucherId: "v-reseller-own" }, "reseller", { id: "staff-reseller", role: "reseller" });
  assert.equal(resellerOwn.status, 200);
  assert.equal(resellerOwn.body.voucher.code, "NC-RESL-0002");

  const resellerOther = await callPrint({ voucherId: "v-user-1" }, "reseller", { id: "staff-reseller", role: "reseller" });
  assert.equal(resellerOther.status, 404);

  const resellerCustomerLookup = await callPrint({ customerId: "c-user-1" }, "reseller", { id: "staff-reseller", role: "reseller" });
  assert.equal(resellerCustomerLookup.status, 403);
});
