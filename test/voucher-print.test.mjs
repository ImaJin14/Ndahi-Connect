import test from "node:test";
import assert from "node:assert/strict";
import {
  A4_CARDS_PER_PAGE,
  VOUCHER_PRINT_LAYOUTS,
  formatAllowanceLabel,
  formatDeviceLabel,
  formatPriceFcfa,
  formatValidityLabel,
  renderBulkA4SheetHtml,
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
  assert.match(html58, /<svg/);

  for (const pii of ["c-leak", "Private Customer", "677889900", "699112233", "private@example.com"]) {
    assert.ok(!html58.includes(pii), `Thermal slip leaked ${pii}`);
  }

  const html80 = renderVoucherPrintLayout(vouchers, plan, "thermal-80");
  assert.match(html80, /data-print-surface="thermal-80"/);
  assert.match(html80, /data-paper-width="80mm"/);
});

test("bulk A4 sheet layout chunks vouchers into 21-card (3x7) pages with clean page breaks and no PII", () => {
  const vouchers = Array.from({ length: 25 }, (_, i) => ({
    id: `v-${i + 1}`,
    code: `NC-BULK-${String(i + 1).padStart(4, "0")}`,
    status: "available",
    customerName: `Hidden Buyer ${i + 1}`,
    phone: `6700000${String(i + 1).padStart(2, "0")}`,
  }));
  const plan = { name: "Weekly", price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 2 };

  const html = renderBulkA4SheetHtml(vouchers, plan);
  assert.equal(A4_CARDS_PER_PAGE, 21);
  assert.match(html, /data-print-surface="a4-sheet"/);
  assert.equal((html.match(/class="a4-voucher-page"/g) || []).length, 2, "25 vouchers should span 2 A4 pages (21 + 4)");
  assert.equal((html.match(/class="a4-voucher-card"/g) || []).length, 25);
  assert.match(html, /NC-BULK-0001/);
  assert.match(html, /NC-BULK-0025/);
  assert.ok(!html.includes("Hidden Buyer"));
  assert.ok(!html.includes("6700000"));
});

test("renderQrBlockMarkup renders crisp monochrome SVG matrix for voucher codes", () => {
  const markup = renderQrBlockMarkup({ code: "NC-TEST-9999" });
  assert.match(markup, /class="voucher-qr-box"/);
  assert.match(markup, /<svg[^>]+shape-rendering="crispEdges"/);
  assert.deepEqual(VOUCHER_PRINT_LAYOUTS, ["thermal-58", "thermal-80", "a4-sheet"]);
});

