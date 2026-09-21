import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createPaymentReconciler, reconciliationConfig } from "../lib/payment-reconciliation.mjs";
import { MeSombPaymentAdapter } from "../lib/payments.mjs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const date = new Date("2026-09-21T12:00:00Z");
const payment = (overrides = {}) => ({ id: "p1", provider: "mesomb", providerReference: "r1",
  amount: 500, currency: "XAF", status: "pending", createdAt: "2026-09-21T11:00:00Z", ...overrides });
const verified = (p, overrides = {}) => ({ status: p.status, providerReference: p.providerReference,
  transactionReference: p.id, amount: p.amount, currency: p.currency, ...overrides });
async function fixture(records, verify, options = {}) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.payments = records; });
  const args = { store, payments: { mesomb: { verifyPayment: verify }, flutterwave: { verifyPayment: verify } },
    now: () => date, ...options };
  return { store, args, run: createPaymentReconciler(args) };
}

test("detects missed settlements and delayed payments for both providers without issuing access", async () => {
  const f = await fixture([payment(), payment({ id: "p2", provider: "flutterwave", providerReference: "123" })],
    (p) => verified(p, { status: "paid" }));
  assert.equal((await f.run()).checked, 2);
  const s = await f.store.snapshot();
  for (const p of s.payments) {
    assert.deepEqual(p.reconciliation.issues, ["delayed_payment", "settlement_missing"]);
    assert.equal(p.status, "pending");
  }
  assert.equal(s.vouchers.length, 0);
  assert.equal((await f.run()).checked, 0);
});

test("detects duplicate references and missing or duplicate vouchers", async () => {
  const f = await fixture([payment({ status: "paid" }), payment({ id: "p2", status: "paid" })], (p) => verified(p));
  await f.store.transaction((s) => { s.vouchers = [{ paymentId: "p2" }, { paymentId: "p2" }]; });
  await f.run();
  const s = await f.store.snapshot();
  assert.deepEqual(s.payments[0].reconciliation.issues, ["voucher_missing", "duplicate_provider_reference"]);
  assert.deepEqual(s.payments[1].reconciliation.issues, ["duplicate_vouchers", "duplicate_provider_reference"]);
});

test("rejects mismatched amounts, currencies, order IDs, references and invalid results", async () => {
  for (const mismatch of [{ amount: 100 }, { currency: "USD" }, { transactionReference: "other" },
    { providerReference: "other" }, { amount: undefined }, { status: "unknown" }]) {
    const f = await fixture([payment()], (p) => verified(p, mismatch));
    await f.run();
    assert.ok((await f.store.snapshot()).payments[0].reconciliation.issues.includes("payment_details_mismatch"));
  }
});

test("distinguishes absent provider records from temporary failures and redacts errors", async () => {
  for (const [code, issue] of [["PAYMENT_NOT_FOUND", "provider_payment_missing"], ["ETIMEDOUT", "verification_unavailable"]]) {
    const f = await fixture([payment()], () => { throw Object.assign(Error("secret credential"), { code }); });
    await f.run();
    const s = await f.store.snapshot();
    assert.ok(s.payments[0].reconciliation.issues.includes(issue));
    assert.ok(!JSON.stringify(s).includes("secret credential"));
    assert.equal(s.payments[0].status, "pending");
  }
});

test("MeSomb identifies a missing transaction explicitly", async () => {
  const adapter = new MeSombPaymentAdapter({ client: { checkTransactions: async () => [] } });
  await assert.rejects(adapter.verifyPayment(payment()), { code: "PAYMENT_NOT_FOUND" });
});

test("leases exclude concurrent workers and stale results cannot overwrite webhook state", async () => {
  let release, started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const f = await fixture([payment()], (p) => { started(); return new Promise((resolve) => { release = () => resolve(verified(p)); }); });
  const first = f.run();
  await waiting;
  assert.equal((await createPaymentReconciler(f.args)()).checked, 0);
  // This transaction completing before release also proves provider I/O holds no store lock.
  await f.store.transaction((s) => { s.payments[0].status = "paid"; });
  release();
  await first;
  const p = (await f.store.snapshot()).payments[0];
  assert.equal(p.status, "paid");
  assert.equal(p.reconciliation.checkedAt, undefined);
  assert.equal(p.reconciliation.leaseToken, undefined);
});

test("expired leases recover after restart and bounded batches fairly rotate", async () => {
  const f = await fixture([payment({ reconciliation: { leaseUntil: "2026-09-21T11:59:00Z" } }),
    payment({ id: "p2", providerReference: "r2" })], (p) => verified(p), { batchSize: 1 });
  assert.equal((await f.run()).checked, 1);
  assert.equal((await createPaymentReconciler(f.args)()).checked, 1);
  assert.ok((await f.store.snapshot()).payments.every((p) => p.reconciliation.checkedAt));
});

test("provider timeout is recorded and does not stall later payments", async () => {
  const f = await fixture([payment(), payment({ id: "p2", providerReference: "r2" })],
    (p) => p.id === "p1" ? new Promise(() => {}) : verified(p), { timeoutMs: 5 });
  assert.equal((await f.run()).checked, 2);
  assert.ok((await f.store.snapshot()).payments[0].reconciliation.issues.includes("verification_unavailable"));
});

test("resolved discrepancies clear and emit one resolution event", async () => {
  let time = date;
  const f = await fixture([payment({ status: "failed" })], (p) => verified(p, { status: "paid" }), { now: () => time });
  await f.run();
  await f.store.transaction((s) => { s.payments[0].status = "paid"; s.vouchers.push({ paymentId: "p1" }); });
  time = new Date(+date + 300001);
  await f.run();
  const s = await f.store.snapshot();
  assert.equal(s.payments[0].reconciliation.status, "matched");
  assert.equal(s.events[0].type, "payment.reconciliation_resolved");
});

test("mock payments are never automatically confirmed and configuration is bounded", async () => {
  const f = await fixture([payment({ provider: "mock" })], () => { throw Error("must not run"); });
  assert.equal((await f.run()).checked, 0);
  assert.equal(reconciliationConfig({ NODE_ENV: "production" }).enabled, true);
  assert.equal(reconciliationConfig({ NODE_ENV: "production", PAYMENT_RECONCILIATION_ENABLED: "false" }).enabled, false);
  assert.equal(reconciliationConfig({ PAYMENT_RECONCILIATION_BATCH_SIZE: "100000" }).batchSize, 100);
});

test("findings survive a store restart and repeated failures do not flood events", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "ndahi-reconciliation-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "state.json");
  let store = createStore({ file });
  await store.transaction((s) => { s.payments.push(payment()); });
  const payments = { mesomb: { verifyPayment: (p) => verified(p, { amount: 1 }) } };
  await createPaymentReconciler({ store, payments, now: () => date })();
  store = createStore({ file });
  assert.ok((await store.snapshot()).payments[0].reconciliation.issues.includes("payment_details_mismatch"));
  await createPaymentReconciler({ store, payments, now: () => new Date(+date + 300001) })();
  assert.equal((await store.snapshot()).events.length, 1);
});

test("missing references and refund discrepancies are flagged without reversing financial state", async () => {
  const f = await fixture([payment({ providerReference: undefined, status: "refund-pending" })],
    (p) => verified(p, { providerReference: "found-reference", status: "refunded" }));
  await f.run();
  const p = (await f.store.snapshot()).payments[0];
  assert.deepEqual(p.reconciliation.issues, ["provider_reference_missing", "payment_status_mismatch"]);
  assert.equal(p.status, "refund-pending");
});
