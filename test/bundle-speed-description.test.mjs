import test from "node:test";
import assert from "node:assert/strict";
import { speedText, hasSpeedLimit } from "../shared-app/bundle-speed.js";
import { comparePlans as compareV1 } from "../customer-app/plan-presentation.js";
import { comparePlans as compareV2 } from "../customer-app-v2/plan-presentation.js";
import { receiptView, receiptDocument, receiptText } from "../lib/receipt.mjs";
import { sanitizePrintableVoucher, voucherSlipRows } from "../admin-app/voucher-slip.js";
import { sanitizePrintableVoucher as sanitizeV2, voucherSlipRows as rowsV2 } from "../admin-app-v2/voucher-slip.js";
import { giftView } from "../lib/reservations.mjs";
import { promotionView } from "../lib/store-promotions.mjs";

// A bundle with a speed limit says so wherever it is described (owner, 21 Nov:
// "a bundle with rate limit of 2mbps should clearly state it in the bundle
// description"). One limit covers all of a bundle's devices (#263).

test("the speed in words, in English and French, shared when a bundle has several devices", () => {
  assert.equal(speedText({ downloadMbps: 2, uploadMbps: 1 }), "Up to 2 Mbps download, 1 Mbps upload");
  assert.equal(speedText({ downloadMbps: 2, uploadMbps: null }), "Up to 2 Mbps download");
  assert.equal(speedText({ downloadMbps: null, uploadMbps: 0.5 }), "Up to 0.5 Mbps upload");
  assert.equal(speedText({ downloadMbps: 10, uploadMbps: 2 }, { devices: 3 }), "Up to 10 Mbps download, 2 Mbps upload, shared by all devices");
  assert.equal(speedText({ downloadMbps: 1.5, uploadMbps: 1 }, { lang: "fr", devices: 2 }),
    "Jusqu’à 1,5 Mbit/s en téléchargement, 1 Mbit/s en envoi, partagés entre tous les appareils");
  // No limit: nothing, never "unlimited speed".
  for (const none of [{}, { downloadMbps: null, uploadMbps: null }, null, undefined, { downloadMbps: 0 }]) {
    assert.equal(speedText(none), "");
    assert.equal(hasSpeedLimit(none), false);
  }
});

test("comparing packages shows the speed when either has a limit", () => {
  const weekly = { price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 1 };
  const fast = { price: 3000, quotaGb: 15, validityHours: 720, deviceLimit: 1, downloadMbps: 10, uploadMbps: 2 };
  for (const compare of [compareV1, compareV2]) {
    assert.equal(compare(weekly, { ...weekly, price: 2000 }).length, 4, "no speed row without limits");
    const row = compare(weekly, fast).at(-1);
    assert.deepEqual(row, { key: "speed", label: "Speed", current: "No speed limit", next: "Up to 10 Mbps download, 2 Mbps upload",
      change: "Download limited to 10 Mbps", direction: "decrease" });
    assert.equal(compare(fast, { ...fast, downloadMbps: 20 }).at(-1).change, "10 Mbps faster download");
    assert.equal(compare(fast, fast).at(-1).change, "Same speed");
  }
});

test("the receipt shows the speed the bundle was bought with, in every format", () => {
  const receipt = { number: "R-1", paymentId: "p1", amount: 2000, currency: "XAF", paidAt: "2026-11-21T10:00:00Z", provider: "mesomb", network: "mtn",
    providerReference: "ref", customerName: "Amina", plan: { name: "Fast Weekly", quotaGb: 5, validityHours: 168, deviceLimit: 2, downloadMbps: 2, uploadMbps: 1 } };
  const view = receiptView(receipt);
  assert.equal(view.speedLabel, "Up to 2 Mbps download, 1 Mbps upload, shared by all devices");
  assert.match(receiptText(receipt), /\nSpeed: Up to 2 Mbps download, 1 Mbps upload, shared by all devices\n/);
  assert.match(receiptDocument(receipt), />Speed</);
  const plain = { ...receipt, plan: { name: "Weekly", quotaGb: 5, validityHours: 168, deviceLimit: 1 } };
  assert.equal("speedLabel" in receiptView(plain), false);
  assert.doesNotMatch(receiptText(plain), /Speed:/);
  assert.doesNotMatch(receiptDocument(plain), />Speed</);
});

test("voucher slips (print, PDF and email) show the voucher's speed as issued", () => {
  const voucher = { code: "NC-ABCD-EFGH", status: "available", deviceLimit: 2, speedSnapshot: { downloadMbps: 2, uploadMbps: null } };
  const plan = { name: "Fast Weekly", price: 2000, quotaGb: 5, validityHours: 168, deviceLimit: 2, downloadMbps: 50 };
  for (const [sanitize, rows] of [[sanitizePrintableVoucher, voucherSlipRows], [sanitizeV2, rowsV2]]) {
    const item = sanitize(voucher, plan);
    assert.deepEqual(rows(item).find(([label]) => label === "Speed"), ["Speed", "Up to 2 Mbps download, shared by all devices"], "the voucher's snapshot, not today's plan");
    assert.equal(rows(sanitize({ ...voucher, speedSnapshot: undefined }, plan)).some(([label]) => label === "Speed"), false, "an older voucher has no limit");
  }
});

test("a gift's claim page and the Black Friday free bundle carry the speed", () => {
  const s = { customers: [] }, plan = { id: "fast", name: "Fast", validityHours: 168, deviceLimit: 1 };
  const v = { id: "v1", quotaBytes: 5e9, deviceLimit: 1, reservation: { by: { type: "ndahi" }, expiresAt: "2027-01-01T00:00:00Z" } };
  assert.equal("downloadMbps" in giftView(s, v, plan).plan, false);
  assert.deepEqual(giftView(s, { ...v, speedSnapshot: { downloadMbps: 2, uploadMbps: null } }, plan).plan,
    { id: "fast", name: "Fast", quotaBytes: 5e9, validityHours: 168, deviceLimit: 1, accessType: null, deviceSlots: null, downloadMbps: 2, uploadMbps: null });
  // An Unlimited gift carries its own terms (#365).
  assert.deepEqual(giftView(s, { ...v, quotaBytes: null, deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2 }, plan).plan,
    { id: "fast", name: "Fast", quotaBytes: null, validityHours: 168, deviceLimit: 2, accessType: "personal_unlimited", deviceSlots: 2 });
  const promotion = { id: "bf", name: { en: "Black Friday", fr: "Black Friday" }, terms: { en: "", fr: "" }, salePrice: 100000, startsAt: "2026-11-26T23:00:00Z",
    endsAt: "2026-11-30T22:59:00Z", perNumberLimit: 1, bonus: { planId: "unlimited", validityHours: 1080, startsAt: "payment_confirmation" } };
  const unlimited = { id: "unlimited", name: "Unlimited Home", quotaGb: null, deviceLimit: 6, fairUse: true, price: 30000 };
  assert.equal("downloadMbps" in promotionView(promotion, null, unlimited).bonus, false);
  assert.deepEqual(speedText(promotionView(promotion, null, { ...unlimited, downloadMbps: 20 }).bonus, { devices: 6 }), "Up to 20 Mbps download, shared by all devices");
});
