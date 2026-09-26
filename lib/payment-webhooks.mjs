import { createHash, randomUUID } from "node:crypto";

const result = (status, body) => ({ status, body });
const isJob = (event) => event?.kind === "payment_webhook";
const fingerprint = (p) => JSON.stringify([
  p.provider, p.providerReference, p.amount, p.currency, p.customerId,
  p.planId, p.action, p.replaceVoucherId, p.upgradeFromVoucherId,
]);
const timestamp = (now) => now().toISOString();

// Call only after the adapter has authenticated the original webhook signature.
export async function enqueuePaymentWebhook(store, provider, data, raw, now = () => new Date()) {
  if (!["mesomb", "flutterwave"].includes(provider) || !data?.paymentId ||
    [data.paymentId, data.eventId, data.transactionId, data.type].some((v) =>
      v != null && (!["string", "number"].includes(typeof v) || String(v).length > 256))) {
    return result(400, { error: "Invalid provider event." });
  }
  const digest = (value) => createHash("sha256").update(value).digest("hex");
  const id = `webhook:${provider}:${digest(data.eventId == null ? raw : String(data.eventId))}`;
  const payload = { paymentId: String(data.paymentId),
    transactionId: data.transactionId == null ? null : String(data.transactionId),
    type: data.type == null ? null : String(data.type) };
  return store.transaction((s) => {
    const old = s.providerEvents.find((event) => event?.id === id);
    if (old) {
      if (JSON.stringify(old.payload) !== JSON.stringify(payload)) {
        return result(409, { error: "Provider event ID conflicts with its stored payload." });
      }
      return { id, duplicate: true, status: old.status };
    }
    s.providerEvents.push({ id, kind: "payment_webhook", provider,
      eventId: data.eventId == null ? null : String(data.eventId), payload,
      payloadHash: digest(raw), status: "queued", attempts: 0, totalAttempts: 0,
      at: timestamp(now), nextAttemptAt: timestamp(now) });
    return { id, duplicate: false, status: "queued" };
  });
}

export function scheduleWebhookReplay(s, id, now = () => new Date()) {
  const event = s.providerEvents.find((event) => isJob(event) && event.id === id);
  if (!event) return result(404, { error: "Webhook event not found." });
  if (!["retry", "dead_letter"].includes(event.status)) {
    return result(409, { error: "Only failed webhook events can be replayed." });
  }
  event.status = "queued";
  event.attempts = 0;
  event.replays = (event.replays || 0) + 1;
  event.replayedAt = timestamp(now);
  event.nextAttemptAt = timestamp(now);
  delete event.leaseToken;
  delete event.leaseUntil;
  return result(202, { accepted: true, eventId: event.id });
}

export function webhookSummary(s) {
  const events = s.providerEvents.filter(isJob);
  return {
    pending: events.filter((e) => ["queued", "retry", "processing"].includes(e.status)).length,
    deadLetters: events.filter((e) => e.status === "dead_letter").length,
    events: events.filter((e) => e.status !== "processed").map((e) => ({
      id: e.id, provider: e.provider, paymentId: e.payload.paymentId,
      status: e.status, attempts: e.attempts, totalAttempts: e.totalAttempts,
      lastError: e.lastError, nextAttemptAt: e.nextAttemptAt, at: e.at,
    })),
  };
}

export function createWebhookProcessor({ store, payments, settle, now = () => new Date(),
  maxAttempts = 5, timeoutMs = 20000, batchSize = 25 }) {
  const fail = (event, reason, permanent = false) => {
    event.lastError = reason;
    event.status = permanent || event.attempts >= maxAttempts ? "dead_letter" : "retry";
    event.nextAttemptAt = event.status === "retry"
      ? new Date(+now() + Math.min(3600000, 30000 * 2 ** (event.attempts - 1))).toISOString() : null;
    if (event.status === "dead_letter") event.deadLetteredAt = timestamp(now);
    delete event.leaseToken;
    delete event.leaseUntil;
  };
  async function process(id) {
    const claim = await store.transaction((s) => {
      const event = s.providerEvents.find((e) => isJob(e) && (!id || e.id === id) &&
        (["queued", "retry"].includes(e.status) && Date.parse(e.nextAttemptAt) <= +now() ||
          e.status === "processing" && Date.parse(e.leaseUntil) <= +now()));
      if (!event) return null;
      if (event.attempts >= maxAttempts) {
        fail(event, "retry_limit_exceeded", true);
        return { exhausted: true };
      }
      event.status = "processing";
      event.attempts++;
      event.totalAttempts++;
      event.lastAttemptAt = timestamp(now);
      event.leaseToken = randomUUID();
      event.leaseUntil = new Date(+now() + timeoutMs + 30000).toISOString();
      const payment = s.payments.find((p) => p.id === event.payload.paymentId && p.provider === event.provider);
      return { event: structuredClone(event), payment: payment && structuredClone(payment) };
    });
    if (!claim) return { ...result(202, { accepted: true, idempotent: true }), idle: true };
    if (claim.exhausted) return result(409, { error: "Webhook retry limit reached." });
    const { event, payment } = claim;
    let verified, reason, timer;
    if (!payment) reason = "payment_not_found";
    else {
      try {
        verified = await Promise.race([
          payments[event.provider].verifyPayment(payment, event.payload.transactionId || undefined),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error("timeout")), timeoutMs); }),
        ]);
      } catch { reason = "provider_verification_unavailable"; }
      finally { clearTimeout(timer); }
    }
    // Settlement and completion marker commit atomically. On storage failure the
    // processing lease expires and the event is safely eligible for retry.
    return store.transaction(async (s) => {
      const current = s.providerEvents.find((e) => e?.id === event.id);
      if (current?.leaseToken !== event.leaseToken) return result(202, { accepted: true });
      const p = s.payments.find((p) => p.id === event.payload.paymentId && p.provider === event.provider);
      if (reason || !p) {
        fail(current, reason || "payment_not_found");
        return result(reason === "provider_verification_unavailable" ? 502 : 404, { error: "Webhook saved for retry." });
      }
      if (fingerprint(p) !== fingerprint(payment)) {
        fail(current, "payment_changed_during_verification");
        return result(409, { error: "Payment changed; webhook saved for retry." });
      }
      if (!verified || !["paid", "failed", "pending", "refunded"].includes(verified.status) ||
        !verified.providerReference || verified.transactionReference !== p.id ||
        Number(verified.amount) !== p.amount || verified.currency !== p.currency ||
        (event.payload.transactionId && String(verified.providerReference) !== event.payload.transactionId) ||
        s.payments.some((other) => other.id !== p.id && other.providerReference === verified.providerReference)) {
        fail(current, "payment_details_mismatch", true);
        return result(400, { error: "Verified payment details do not match this order." });
      }
      let response;
      if (verified.status === "paid") {
        if (["refunded", "refund-pending"].includes(p.status)) {
          fail(current, "payment_already_refunded", true);
          return result(409, { error: "Refunded payments cannot be fulfilled again." });
        }
        response = await settle(s, p, verified.providerReference);
        if (response.status >= 400) {
          fail(current, "fulfillment_conflict", true);
          return response;
        }
      } else {
        // An out-of-order callback must never downgrade fulfilled/refunded access.
        if (!["paid", "refunded", "refund-pending"].includes(p.status) &&
          !s.vouchers.some((v) => v.paymentId === p.id)) {
          p.status = verified.status;
          if (verified.status === "failed") p.providerFailedAt = timestamp(now);
        }
        response = result(200, { accepted: true, status: p.status });
      }
      current.status = "processed";
      current.processedAt = timestamp(now);
      current.nextAttemptAt = null;
      delete current.lastError;
      delete current.leaseToken;
      delete current.leaseUntil;
      return response;
    });
  }
  let running;
  return {
    process,
    run() {
      if (running) return running;
      running = (async () => {
        for (let i = 0; i < batchSize; i++) {
          if ((await process()).idle) break;
        }
      })().finally(() => { running = undefined; });
      return running;
    },
  };
}
