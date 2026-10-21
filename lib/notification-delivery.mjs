import { createHash, randomUUID } from "node:crypto";
import webPush from "web-push";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const subscriptionVersion = (subscription) => digest([subscription.endpoint, subscription.keys]);
export const deliveryId = (recipient, eventId, subscription) => "delivery:" + digest([recipient, eventId, subscriptionVersion(subscription)]);
export function recipientSubscriptions(s, recipient) {
  const [type, ...parts] = recipient.split(":"), id = parts.join(":");
  if (type === "customer") {
    const customer = s.customers.find((c) => c.id === id);
    return customer && customer.status !== "suspended" ? customer.pushSubscriptions || [] : [];
  }
  const user = s.adminUsers.find((u) => u.id === id);
  return user && user.active !== false ? (s.notificationStates || []).find((n) => n.id === "preferences:" + recipient)?.subscriptions || [] : [];
}
function removeSubscription(s, recipient, subscription) {
  const [type, ...parts] = recipient.split(":"), id = parts.join(":"), key = type === "customer" ? "pushSubscriptions" : "subscriptions";
  const holder = type === "customer" ? s.customers.find((c) => c.id === id) : s.notificationStates.find((n) => n.id === "preferences:" + recipient);
  if (holder) holder[key] = (holder[key] || []).filter((n) => subscriptionVersion(n) !== subscriptionVersion(subscription));
}

// Both activity and quota delivery use this durable, per-subscription lease.
// resolve must recheck authority, consent, source version and the subscription.
// No provider I/O runs while the store transaction is held.
export async function deliverNotification({ store, recipient, eventId, version, subscription, resolve, config,
  now = () => new Date(), maxAttempts = 5, send = webPush.sendNotification.bind(webPush) }) {
  if (!config.enabled) return { status: "disabled", delivered: false };
  const id = deliveryId(recipient, eventId, subscription), token = randomUUID();
  const current = (s) => {
    const event = resolve(s);
    const target = recipientSubscriptions(s, recipient).find((n) => subscriptionVersion(n) === subscriptionVersion(subscription));
    return event?.version === version && target ? { ...event, subscription: target } : null;
  };
  const claim = await store.transaction((s) => {
    s.notificationStates ??= [];
    let row = s.notificationStates.find((n) => n.id === id);
    if (!row) {
      // Preserve sent/backoff records from the pre-fingerprint activity worker.
      const legacy = s.notificationStates.find((n) => n.id === "delivery:" + digest([recipient, eventId, subscription.endpoint]));
      if (legacy?.version === version) {
        if (Date.parse(legacy.leaseUntil) > +now()) return false;
        row = { ...legacy, id, notificationId: eventId };
        delete row.token; delete row.leaseUntil;
        if (row.attempts >= maxAttempts && row.status !== "sent") row.status = "failed";
        s.notificationStates.push(row);
      }
    }
    if (!current(s)) {
      if (row && !row.token && row.status !== "sent") row.status = "cancelled";
      return false;
    }
    if (Date.parse(row?.leaseUntil) > +now()) return false;
    if (row?.version === version && row.attempts >= maxAttempts && row.status !== "sent") {
      row.status = "failed"; delete row.token; delete row.leaseUntil; delete row.nextAttemptAt; return false;
    }
    if (row?.version === version && (["sent", "gone", "failed", "cancelled"].includes(row.status) || Date.parse(row.nextAttemptAt) > +now())) return false;
    if (!row) { row = { id, actor: recipient, notificationId: eventId }; s.notificationStates.push(row); }
    if (row.version !== version) { row.attempts = 0; delete row.nextAttemptAt; }
    Object.assign(row, { token, version, status: "sending", attempts: (row.attempts || 0) + 1, leaseUntil: new Date(+now() + 30000).toISOString() });
    return true;
  });
  if (!claim) return { status: "skipped", delivered: false };
  // A revoked subscription/role/consent between planning and claiming must not
  // send. This second check also fences a superseded or expired lease.
  const event = await store.transaction((s) => {
    const row = s.notificationStates.find((n) => n.id === id);
    if (row?.token !== token || row.version !== version || !(Date.parse(row.leaseUntil) > +now())) return null;
    const value = current(s);
    if (!value) { row.status = "cancelled"; delete row.token; delete row.leaseUntil; }
    return value;
  });
  if (!event) return { status: "cancelled", delivered: false };
  let status = "retry";
  try {
    const payload = { ...event.payload, url: /^\/(?!\/)[^?]*$/.test(event.payload.url || "") ? event.payload.url : "/dashboard" };
    await send(event.subscription, JSON.stringify(payload), {
      vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
      TTL: event.ttl || 3600, urgency: "high", timeout: 10000, topic: digest([recipient, event.topicKey || eventId]).slice(0, 32),
    });
    status = "sent";
  } catch (error) { if ([404, 410].includes(error?.statusCode)) status = "gone"; }
  await store.transaction((s) => {
    const row = s.notificationStates.find((n) => n.id === id);
    if (row?.token !== token || row.version !== version) return;
    if (status === "gone") removeSubscription(s, recipient, event.subscription);
    row.status = status === "retry" && !current(s) ? "cancelled" : status === "retry" && row.attempts >= maxAttempts ? "failed" : status;
    if (row.status === "retry") row.nextAttemptAt = new Date(+now() + 60000 * 2 ** (row.attempts - 1)).toISOString();
    else delete row.nextAttemptAt;
    row.updatedAt = now().toISOString();
    delete row.token; delete row.leaseUntil;
  });
  return { status, delivered: status === "sent" };
}
