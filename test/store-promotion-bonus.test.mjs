// The free bundle of a store promotion (#302): who gets it, when it is not
// given, and that resuming never acts on a partly loaded state.
import test from "node:test";
import assert from "node:assert/strict";
import { bonusRecipient, issuePromotionBonus, resumePausedBundles, endPromotionBonus } from "../lib/store-promotion-bonus.mjs";

const now = new Date("2026-11-27T10:00:00Z"), DAY = 864e5;
const plan = { id: "unlimited", name: "Unlimited Home", price: 30000, quotaGb: null, validityHours: 720, deviceLimit: 6 };
const order = (extra = {}) => ({ id: "o1", reference: "NS-1", status: "preparing", customerId: null,
  payment: { status: "paid", confirmedAt: now.toISOString(), payerPhone: "670000002" },
  promotion: { id: "black-friday", bonus: { planId: "unlimited", validityHours: 1080, startsAt: "payment_confirmation", planName: "Unlimited Home" } }, ...extra });
const state = () => ({ customers: [{ id: "signed-in", phone: "670000001" }, { id: "payer", phone: "670000002" }, { id: "off", phone: "670000003", status: "suspended" }],
  vouchers: [], routerCommands: [], auditLogs: [], storeOrders: [] });
let n = 0;
const code = () => `NC-TEST-${String(++n).padStart(4, "0")}`;

test("the signed-in buyer's account comes first, then the paying number's; never a suspended one", () => {
  const s = state();
  assert.equal(bonusRecipient(s, order({ customerId: "signed-in" })).id, "signed-in");
  assert.equal(bonusRecipient(s, order()).id, "payer");
  assert.equal(bonusRecipient(s, order({ payment: { payerPhone: "670000003" } })), null);
  assert.equal(bonusRecipient(s, order({ payment: { payerPhone: "699999999" } })), null);
});

test("no bonus for an order that isn't paid and preparing, and one per order", () => {
  for (const extra of [{ status: "review" }, { status: "awaiting_payment" }, { payment: { status: "pending", payerPhone: "670000002" } }]) {
    const s = state();
    assert.equal(issuePromotionBonus(s, order(extra), now, { plan, code }), null, JSON.stringify(extra));
    assert.equal(s.vouchers.length, 0);
  }
  const s = state(), o = order();
  issuePromotionBonus(s, o, now, { plan, code });
  assert.equal(issuePromotionBonus(s, o, now, { plan, code }), null, "a second call gives nothing more");
  assert.equal(s.vouchers.length, 1);
});

test("a missing plan holds the bonus for staff review instead of inventing one", () => {
  const s = state(), o = order();
  assert.equal(issuePromotionBonus(s, o, now, { plan: undefined, code }).status, "needs_review");
  assert.equal(s.vouchers.length, 0);
  assert.ok(s.auditLogs.some((a) => a.action === "store.promotion_bonus_needs_review"));
});

test("resuming acts only when the free bundle is loaded and over", () => {
  const s = state();
  s.vouchers.push({ id: "weekly", status: "paused", pausedFor: { voucherId: "bonus", remainingMs: 3 * DAY } });
  assert.deepEqual(resumePausedBundles(s, now), [], "the free bundle isn't loaded: leave it paused");
  s.vouchers.push({ id: "bonus", status: "active" });
  assert.deepEqual(resumePausedBundles(s, now), [], "still running");
  s.vouchers[1].status = "expired";
  assert.deepEqual(resumePausedBundles(s, now), ["weekly"]);
  assert.equal(s.vouchers[0].expiresAt, new Date(+now + 3 * DAY).toISOString());
  assert.ok(s.routerCommands.some((c) => c.action === "sync_voucher" && c.targetId === "weekly"));
});

test("ending is idempotent, and an order whose bonus was never given records that", () => {
  const s = state(), o = order({ customerId: "signed-in" });
  issuePromotionBonus(s, o, now, { plan, code });
  assert.equal(endPromotionBonus(s, o, now, "refund").status, "ended");
  const audits = s.auditLogs.length;
  assert.equal(endPromotionBonus(s, o, now, "refund").status, "ended");
  assert.equal(s.auditLogs.length, audits, "nothing new the second time");
  const never = order({ status: "review" });
  assert.equal(endPromotionBonus(s, never, now, "refund").status, "not_given");
  assert.equal(endPromotionBonus(s, order({ promotion: { id: "p" } }), now, "refund"), null, "no free bundle on the offer");
});
