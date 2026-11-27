// The printed voucher slip's words (canvas: VoucherSlip, #368; owner 26 Nov):
// one model for the card on screen and in the PDF, from the voucher's own
// terms, in English and French.
import test from "node:test";
import assert from "node:assert/strict";
import { format } from "../shared-app/i18n.js";
import { voucherCardModel, voucherCardTerms } from "../shared-app/voucher-card.js";
import { voucherListView, voucherAccess } from "../lib/voucher-access.mjs";

const t = (lang) => (key, values) => format(key, values || {}, lang);
const personal = { id: "v1", code: "NC-QF83-ZK4M", accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, validityHours: 168, quotaBytes: null,
  faceValue: 3500, batchReference: "B-1105-02", useBy: "2027-02-10T12:00:00.000Z", resellerName: "Market kiosk", qrCode: "data:image/png;base64,AAAA" };

test("the card reads as drawn, the code without NC-", () => {
  const m = voucherCardModel(personal, { name: "[PLAN 2]", price: 3500 }, t("en"));
  assert.deepEqual([m.brand, m.kind, m.price, m.plan, m.terms, m.codeLabel, m.code, m.use, m.batch],
    ["NDAHI Connect", "WI-FI VOUCHER", "3,500 FCFA", "[PLAN 2]", "Unlimited · 7 days · 2 devices", "Voucher code", "QF83-ZK4M", "Use before 10 Feb 2027 · single use", "Batch B-1105-02 · Market kiosk"]);
  assert.deepEqual(m.steps, [
    { before: "Join the Wi-Fi network ", strong: "NDAHI", after: "" },
    { before: "The sign-in page opens — tap ", strong: "I have a voucher", after: "" },
    { before: "Type the code above, or scan the QR code", strong: "", after: "" },
  ]);
  assert.equal(m.qrLabel, "QR code for voucher QF83-ZK4M");
});

test("each kind of bundle shows its own terms; a code made before the use-by rule says only single use", () => {
  const en = t("en");
  assert.equal(voucherCardTerms({ accessType: "home_wisp_unlimited", validityHours: 720 }, {}, en), "Home WISP Unlimited · 30 days");
  assert.equal(voucherCardTerms({ accessType: "personal_unlimited", deviceSlots: 1, validityHours: 5 }, {}, en), "Unlimited · 5 hours · 1 device");
  assert.equal(voucherCardTerms({ accessType: "personal_unlimited", deviceSlots: 6, validityHours: 24 }, {}, en), "Unlimited · 24 hours · 6 devices");
  assert.equal(voucherCardTerms({ quotaBytes: 5e9, deviceLimit: 1 }, { quotaGb: 5, validityHours: 168 }, en), "5 GB · 7 days · 1 device", "a data-capped bundle keeps its terms");
  const old = voucherCardModel({ ...personal, useBy: undefined, batchReference: undefined }, { name: "Weekly" }, en);
  assert.deepEqual([old.use, old.batch], ["Single use", ""]);
});

test("French", () => {
  const m = voucherCardModel(personal, { name: "[PLAN 2]" }, t("fr"), { lang: "fr" });
  assert.deepEqual([m.kind, m.terms, m.codeLabel, m.use, m.batch], ["BON WI-FI", "Illimité · 7 jours · 2 appareils", "Code du bon", "À utiliser avant le 10 févr. 2027 · usage unique", "Lot B-1105-02 · Market kiosk"]);
  assert.equal(m.steps[1].strong, "J'ai un bon");
});

test("a batch voucher carries its reseller's name for the slip's foot", () => {
  const s = { adminUsers: [{ id: "r1", displayName: "Market kiosk", role: "reseller" }], sessions: [], vouchers: [], bundles: [] };
  const view = voucherListView(s, { id: "v1", planId: "weekly", status: "available", assignedResellerId: "r1", batchReference: "B-1105-02" }, voucherAccess("owner", { id: "o" }));
  assert.equal(view.resellerName, "Market kiosk");
});
