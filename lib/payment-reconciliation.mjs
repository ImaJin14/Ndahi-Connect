import { randomUUID } from "node:crypto";

const fingerprint = (p) => JSON.stringify([
  p.provider, p.providerReference, p.status, p.amount, p.currency,
]);
const positive = (value, fallback, max) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, max) : fallback;
};

export function reconciliationConfig(env = {}) {
  return {
    enabled: env.PAYMENT_RECONCILIATION_ENABLED === "true" ||
      (env.PAYMENT_RECONCILIATION_ENABLED !== "false" &&
        env.NODE_ENV === "production" && env.BOOTSTRAP_MODE !== "true"),
    intervalMs: positive(env.PAYMENT_RECONCILIATION_INTERVAL_SECONDS, 300, 86400) * 1000,
    batchSize: positive(env.PAYMENT_RECONCILIATION_BATCH_SIZE, 25, 100),
    delayedMs: positive(env.PAYMENT_RECONCILIATION_DELAY_SECONDS, 900, 604800) * 1000,
  };
}

// Provider reads deliberately run outside the state transaction. Leases and
// results live on payment payloads, so they survive restarts on both stores.
export function createPaymentReconciler({ store, payments, now = () => new Date(),
  intervalMs = 300000, batchSize = 25, delayedMs = 900000, timeoutMs = 20000 }) {
  async function checkOne() {
    const claim = await store.transaction((s) => {
      const time = now().getTime();
      const p = s.payments.filter((p) =>
        ["mesomb", "flutterwave"].includes(p.provider) && payments[p.provider] &&
        (typeof payments[p.provider].configured !== "function" || payments[p.provider].configured()) &&
        !(Date.parse(p.reconciliation?.leaseUntil) > time) &&
        !(Date.parse(p.reconciliation?.nextCheckAt) > time)
      ).sort((a, b) => (Date.parse(a.reconciliation?.checkedAt) || 0) -
        (Date.parse(b.reconciliation?.checkedAt) || 0))[0];
      if (!p) return null;
      const token = randomUUID();
      p.reconciliation = { ...p.reconciliation, leaseToken: token,
        leaseUntil: new Date(time + timeoutMs + 30000).toISOString() };
      return { payment: structuredClone(p), token, fingerprint: fingerprint(p) };
    });
    if (!claim) return false;
    let verified, errorCode, timer;
    try {
      verified = await Promise.race([
        payments[claim.payment.provider].verifyPayment(claim.payment),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Provider timeout")), timeoutMs);
        }),
      ]);
    } catch (error) {
      errorCode = error.code === "PAYMENT_NOT_FOUND" ? "provider_payment_missing" : "verification_unavailable";
    } finally { clearTimeout(timer); }
    await store.transaction((s) => {
      const p = s.payments.find((p) => p.id === claim.payment.id);
      if (!p || p.reconciliation?.leaseToken !== claim.token) return;
      delete p.reconciliation.leaseToken;
      delete p.reconciliation.leaseUntil;
      // A webhook/refund may have changed the order while the provider replied.
      if (fingerprint(p) !== claim.fingerprint) {
        p.reconciliation.nextCheckAt = new Date(+now() + intervalMs).toISOString();
        return;
      }
      const time = now(), issues = [];
      const vouchers = s.vouchers.filter((v) => v.paymentId === p.id);
      if (!p.providerReference) issues.push("provider_reference_missing");
      if (p.status === "paid" && !vouchers.length) issues.push("voucher_missing");
      if (vouchers.length > 1) issues.push("duplicate_vouchers");
      const reference = verified?.providerReference || p.providerReference;
      if (reference && s.payments.some((other) => other.id !== p.id &&
        other.provider === p.provider && String(other.providerReference) === String(reference))) {
        issues.push("duplicate_provider_reference");
      }
      if (p.status === "pending" && time - new Date(p.createdAt) >= delayedMs) issues.push("delayed_payment");
      if (errorCode) issues.push(errorCode);
      else if (!verified || !["paid", "pending", "failed", "refunded"].includes(verified.status) ||
        !verified.providerReference || verified.transactionReference !== p.id ||
        !Number.isFinite(Number(verified.amount)) || Number(verified.amount) !== p.amount ||
        verified.currency !== p.currency ||
        (p.providerReference && String(verified.providerReference) !== String(p.providerReference))) {
        issues.push("payment_details_mismatch");
      } else if (verified.status !== p.status) {
        issues.push(verified.status === "paid" && ["pending", "failed"].includes(p.status)
          ? "settlement_missing" : "payment_status_mismatch");
      }
      const previous = p.reconciliation.issues || [];
      p.reconciliation = {
        checkedAt: time.toISOString(), nextCheckAt: new Date(+time + intervalMs).toISOString(),
        issues, status: issues.length ? "needs_review" : "matched",
        ...(!errorCode && verified ? { providerStatus: verified.status } : {}),
      };
      if (JSON.stringify(previous) !== JSON.stringify(issues)) {
        s.events.unshift({ id: randomUUID(), type: issues.length
          ? "payment.reconciliation_issue" : "payment.reconciliation_resolved",
          at: time.toISOString(), meta: { paymentId: p.id, provider: p.provider, issues } });
        s.events = s.events.slice(0, 500);
      }
    });
    return true;
  }
  let running;
  return function run() {
    if (running) return running;
    running = (async () => {
      let checked = 0;
      while (checked < batchSize && await checkOne()) checked++;
      return { checked };
    })().finally(() => { running = undefined; });
    return running;
  };
}
