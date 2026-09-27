import { randomUUID } from "node:crypto";

// Queued inside the same transaction as the triggering change; delivery
// happens later so a slow or unreachable email provider never blocks the
// customer-facing request (mirrors lib/billing.mjs's receipt delivery).
export function queueSecurityAlert(s, { customerId, kind, subject, lines }, now = new Date()) {
  s.securityAlerts ??= [];
  s.securityAlerts.push({
    id: randomUUID(), type: "security_alert", customerId, kind, subject, lines,
    status: "pending", attempts: 0,
    at: now.toISOString(), nextAttemptAt: now.toISOString(),
  });
  s.securityAlerts = s.securityAlerts.slice(-500);
}

export function createSecurityAlertService({ store, email, now = () => new Date(), timeoutMs = 10000 }) {
  const stamp = () => now().toISOString();
  async function bounded(task) {
    let timer;
    try {
      return await Promise.race([task(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Email provider unavailable")), timeoutMs);
      })]);
    } finally { clearTimeout(timer); }
  }
  async function deliver(id) {
    const claim = await store.transaction((s) => {
      s.securityAlerts ??= [];
      const a = s.securityAlerts.find((x) => x.id === id);
      if (!a || a.status !== "pending" || Date.parse(a.nextAttemptAt) > +now()) return null;
      const customer = s.customers.find((c) => c.id === a.customerId);
      if (!customer?.email) {
        a.status = "skipped";
        a.lastError = "No account email on file.";
        return null;
      }
      a.token = randomUUID();
      return { alert: structuredClone(a), email: customer.email };
    });
    if (!claim) return;
    let delivered = false, error;
    try {
      await bounded(() => email.sendSecurityAlert({ to: claim.email, alert: claim.alert }));
      delivered = true;
    } catch (e) { error = String(e?.message || e).slice(0, 200); }
    await store.transaction((s) => {
      const a = (s.securityAlerts || []).find((x) => x.id === id);
      if (!a || a.token !== claim.alert.token) return;
      delete a.token;
      if (delivered) {
        a.status = "sent";
        a.sentAt = stamp();
        delete a.lastError;
        return;
      }
      a.attempts += 1;
      a.lastError = error || "Delivery failed.";
      a.status = a.attempts >= 8 ? "failed" : "pending";
      a.nextAttemptAt = new Date(+now() + Math.min(30, 2 ** a.attempts) * 60000).toISOString();
    });
  }
  let running;
  function run() {
    if (running) return running;
    running = (async () => {
      const state = await store.snapshot();
      for (const a of (state.securityAlerts || []).filter((a) => a.status === "pending").slice(0, 25)) {
        await deliver(a.id);
      }
    })().finally(() => { running = undefined; });
    return running;
  }
  return { run, deliver };
}
