import { createHash, randomUUID } from "node:crypto";

// PostgreSQL JSONB may return object keys in a different order after commit.
// Canonicalize recursively so a persisted lease keeps the same identity.
const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, canonical(value[key])]),
        )
      : value;
export const emailVersion = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
// Uses the existing domain outbox rows. Claims commit before any provider I/O.
// One logical message keeps its key across timeout/restart; a changed recipient
// after an attempted send requires review instead of sending sensitive mail twice.
export async function deliverEmail({
  store,
  locate,
  resolve,
  send,
  key,
  now = () => new Date(),
  configured = () => true,
  changed = () => {},
  maxAttempts = 5,
  timeoutMs = 10000,
  leaseMs = 30000,
}) {
  const update = (s, row) => changed(s, row);
  const release = (row) => {
    delete row.token;
    delete row.leaseUntil;
  };
  const claim = await store.transaction((s) => {
    const row = locate(s);
    if (!row || ["sent", "cancelled"].includes(row.status)) return null;
    if (
      (row.status === "sending" && Date.parse(row.leaseUntil) > +now()) ||
      Date.parse(row.nextAttemptAt) > +now()
    )
      return null;
    if (
      (row.attempts || 0) >= maxAttempts ||
      (row.firstAttemptAt &&
        +now() - Date.parse(row.firstAttemptAt) >= 23 * 3600000)
    ) {
      release(row);
      row.status = "failed";
      row.lastError =
        "Automatic delivery stopped. Use your portal documents or contact support.";
      delete row.nextAttemptAt;
      update(s, row);
      return null;
    }
    const current = resolve(s);
    if (!current || current.blocked) {
      release(row);
      row.status = current?.blocked || "cancelled";
      row.lastError = current?.reason || "This message is no longer current.";
      update(s, row);
      return null;
    }
    if (row.version && row.version !== current.version) {
      release(row);
      row.status = "cancelled";
      row.lastError =
        "Delivery details changed. Use your portal documents or contact support.";
      delete row.nextAttemptAt;
      update(s, row);
      return null;
    }
    if (!configured()) {
      row.status = "pending";
      row.lastError =
        "Email delivery is temporarily unavailable. Your portal remains available.";
      row.nextAttemptAt = new Date(+now() + 60000).toISOString();
      update(s, row);
      return null;
    }
    row.version = current.version;
    row.token = randomUUID();
    row.status = "sending";
    row.attempts = (row.attempts || 0) + 1;
    row.firstAttemptAt ||= now().toISOString();
    row.leaseUntil = new Date(
      +now() + Math.max(leaseMs, timeoutMs + 10000),
    ).toISOString();
    delete row.nextAttemptAt;
    update(s, row);
    return { token: row.token, version: row.version };
  });
  if (!claim) return { delivered: false };
  // Revalidate authority, preferences and mailbox association after taking the lease.
  const current = await store.transaction((s) => {
    const row = locate(s),
      value = resolve(s);
    if (!row || row.token !== claim.token) return null;
    if (!value || value.blocked || value.version !== claim.version) {
      row.status = value?.blocked || "cancelled";
      row.lastError = value?.reason || "This message is no longer current.";
      delete row.token;
      delete row.leaseUntil;
      update(s, row);
      return null;
    }
    return value;
  });
  if (!current) return { delivered: false };
  let delivered, result, timer;
  try {
    result = await Promise.race([
      Promise.resolve().then(() => send(current.message, key)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error("Delivery timeout")), timeoutMs);
      }),
    ]);
    delivered = true;
  } catch {
    /* Provider response and credentials never enter durable status or logs. */
  } finally {
    clearTimeout(timer);
  }
  await store.transaction((s) => {
    const row = locate(s);
    if (!row || row.token !== claim.token) return;
    delete row.token;
    delete row.leaseUntil;
    if (delivered) {
      row.status = "sent";
      row.sentAt = now().toISOString();
      row.messageId = result?.messageId;
      delete row.lastError;
      delete row.nextAttemptAt;
    } else {
      row.status = "failed";
      row.lastError =
        "Email delivery could not be confirmed. Your portal remains available.";
      if (row.attempts < maxAttempts)
        row.nextAttemptAt = new Date(
          +now() + Math.min(30, 2 ** row.attempts) * 60000,
        ).toISOString();
    }
    update(s, row);
  });
  return { delivered: Boolean(delivered) };
}
