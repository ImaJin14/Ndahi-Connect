import test from "node:test";
import assert from "node:assert/strict";
import { renderVoucherCard, renderVoucherCardsHtml, voucherCardFacts, voucherCardSteps } from "../shared-app/voucher-card.js";
import { sanitizePrintableVoucher } from "../admin-app/voucher-slip.js";
import { printSelection } from "../lib/api/voucher-print.mjs";
import { prepareVoucherSlip, voucherBatchPdf } from "../lib/voucher-pdf.mjs";

const plan = { id: "weekly", name: "Weekly", price: 1000, quotaGb: 5, validityHours: 168, deviceLimit: 3 };
const item = (code, extra = {}) => sanitizePrintableVoucher({ code, status: "available", deviceLimit: 3, ...extra }, plan);

test("the A6 card shows the canvas's content (VoucherSlip) and nothing personal", () => {
  const card = renderVoucherCard(item("NC-QF83-ZK4M", { customerName: "Private Person", phone: "670000001" }));
  for (const text of ["NDAHI Connect", "WI-FI VOUCHER", "1,000 FCFA", "Weekly", "5 GB · 7 days · 3 devices", "Voucher code", "NC-QF83-ZK4M", "Type the code above", "Starts on first redemption", "Keep this code private"])
    assert.ok(card.includes(text), text);
  assert.doesNotMatch(card, /Private Person|670000001| style=/);
  assert.match(card, /QR unavailable/, "no QR is drawn without the server's PNG");
});

test("cards escape their text, name an unusable status, and group four to an A4 sheet", () => {
  const hostile = renderVoucherCard(item('<img src=x onerror="1">'));
  assert.doesNotMatch(hostile, /<img src=x/);
  assert.match(renderVoucherCard({ ...item("NC-OLD"), statusLabel: "expired", statusHeading: "Current status" }), /Current status: expired/);
  assert.doesNotMatch(renderVoucherCard(item("NC-NEW")), /Current status/);
  const html = renderVoucherCardsHtml(["A", "B", "C", "D", "E"].map((code) => item(code)));
  assert.equal(html.match(/class="voucher-a4-sheet"/g).length, 2);
  assert.equal(html.match(/class="voucher-card"/g).length, 5);
  assert.equal(voucherCardFacts({ allowanceLabel: "Unlimited data (fair use)", validityLabel: "24 hours (1 day)", deviceLabel: "1 device" }), "Unlimited data · 1 day · 1 device");
  assert.match(voucherCardSteps({ qrConnection: true })[2], /PIN or passkey/);
});

test("print requests choose A6 cards or a thermal width, nothing else", () => {
  assert.deepEqual(printSelection({ voucherIds: ["v1"], layout: "a6" }), ["v1"]);
  assert.deepEqual(printSelection({ voucherIds: ["v1"], widthMm: 80 }), ["v1"]);
  assert.equal(printSelection({ voucherIds: ["v1"], layout: "a5" }), null);
  assert.equal(printSelection({ voucherIds: ["v1"], layout: "a6", widthMm: 210 }) !== null, true, "width is ignored for cards");
  assert.equal(printSelection({ voucherIds: ["v1"] }), null);
});

test("the A6 PDF puts four cards on each A4 page", async () => {
  const entries = [];
  for (let i = 0; i < 5; i++) {
    const voucher = { id: `v${i}`, code: `NC-CARD-000${i}`, status: "available", planId: "weekly", deviceLimit: 3 };
    entries.push({ voucher, slip: await prepareVoucherSlip({ voucher, plan }) });
  }
  const pdf = (await voucherBatchPdf({ entries, layout: "a6" })).toString("latin1");
  assert.equal(pdf.match(/\/Type\s*\/Page\b/g).length, 2);
  const [, width, height] = pdf.match(/\/MediaBox\s*\[\s*0\s+0\s+([\d.]+)\s+([\d.]+)\s*\]/).map(Number);
  assert.ok(Math.abs(width - 595.28) < 1 && Math.abs(height - 841.89) < 1, "A4");
});
