import { deliverNotification, recipientSubscriptions, deliveryId } from "./notification-delivery.mjs";
import { notificationPreferences, notificationItems } from "./notifications.mjs";
import { createHash } from "node:crypto";
import { formatDataBalance, dataWarning, usageNotificationId } from "../shared-app/data-usage.js";
export { usageNotificationId } from "../shared-app/data-usage.js";

// Data-usage alerts at 90%, positive <=2MB remaining and exhaustion, delivered as Web
// Push notifications to the devices a customer opted in.
export const USAGE_THRESHOLDS = [90, 100];
export const usageAllocation = (v) => createHash("sha256").update(JSON.stringify([v.id, v.allocationId, v.paymentId, v.activatedAt, v.expiresAt, v.quotaBytes])).digest("hex").slice(0, 20);
// A newer issued allocation makes older quota warnings historical, even if
// legacy state has no customer.activeVoucherId pointer.
export const newerUsageAllocation = (s, voucher) => s.vouchers.some(other =>
  other.id !== voucher.id && other.customerId === voucher.customerId &&
  ["active", "expired", "exhausted"].includes(other.status) &&
  Date.parse(other.activatedAt) > Date.parse(voucher.activatedAt || "1970-01-01T00:00:00Z"));
const rank = (level) => level === "100" ? 3 : level === "low" ? 2 : level === "90" ? 1 : 0;

// The API posts to stored endpoints, so only browser push services are
// accepted; a subscription cannot point the server at an arbitrary host.
const pushHosts = [/^fcm\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/, /(^|\.)push\.apple\.com$/];
const base64Url = /^[A-Za-z0-9_-]+={0,2}$/;
export const maxPushSubscriptions = 5;

export function pushSubscription(input) {
  let url;
  try { url = new URL(String(input?.endpoint || "")); } catch { return null; }
  const { p256dh, auth } = input?.keys || {};
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.href.length > 1024 ||
      !pushHosts.some((host) => host.test(url.hostname))) return null;
  if (typeof p256dh !== "string" || !base64Url.test(p256dh) || p256dh.length < 80 || p256dh.length > 100 ||
      typeof auth !== "string" || !base64Url.test(auth) || auth.length < 16 || auth.length > 32) return null;
  return { endpoint: url.href, keys: { p256dh, auth } };
}

// Partial or malformed push settings would leave alerts silently off, so the
// pre-deploy check reports them. Unset means alerts are intentionally off.
export function usageAlertConfigErrors(env = {}) {
  const keys = ["WEB_PUSH_PUBLIC_KEY", "WEB_PUSH_PRIVATE_KEY", "WEB_PUSH_SUBJECT"], set = keys.filter((key) => String(env[key] || "").trim());
  if (!set.length) return [];
  const errors = keys.filter((key) => !set.includes(key)).map((key) => `${key} is missing; set all three WEB_PUSH_* values or none`);
  const subject = String(env.WEB_PUSH_SUBJECT || "").trim(), address = subject.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1];
  if (subject && !/^(?:mailto:[^\s<>@]+@[^\s<>@]+|https:\/\/\S+)$/.test(subject)) {
    errors.push(`WEB_PUSH_SUBJECT must be a mailto: or https: URI${address ? `, for example mailto:${address}` : ""}`);
  }
  return errors;
}

export function usageAlertConfig(env = {}) {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY || "", privateKey = env.WEB_PUSH_PRIVATE_KEY || "",
    subject = env.WEB_PUSH_SUBJECT || "";
  return { enabled: Boolean(publicKey && privateKey && /^(?:mailto:|https:\/\/)/.test(subject)), publicKey, privateKey, subject };
}

// Marks the highest threshold newly reached as due. Lower thresholds reached
// by the same reading are skipped, so a large jump sends one alert.
export function recordUsageAlerts(v, now = () => new Date()) {
  if (!v.customerId || v.quotaBytes === null || !(v.quotaBytes > 0)) return false;
  const cycle = usageAllocation(v);
  if (v.usageAlertCycle !== cycle) {
    v.usageAlertHistory = [...(v.usageAlertHistory || []), ...Object.entries(v.usageAlerts || {}).map(([level, alert]) => ({ ...alert, level, cycle: v.usageAlertCycle || null,
      status: alert.status === "pending" ? "superseded" : alert.status }))].slice(-50);
    v.usageAlerts = {}; v.usageAlertCycle = cycle;
  }
  const percent = (v.usedBytes / v.quotaBytes) * 100, remaining = Math.max(0, v.quotaBytes - v.usedBytes), alerts = (v.usageAlerts ??= {}),
    reached = [percent >= 90 && "90", remaining > 0 && remaining <= 2000000 && "low", remaining === 0 && "100"].filter((level) => level && !alerts[level]);
  if (!reached.length) return false;
  const at = now().toISOString();
  const highest = dataWarning(v);
  for (const [level, alert] of Object.entries(alerts)) if (alert.status === "pending" && rank(level) < rank(highest)) alert.status = "superseded";
  for (const threshold of reached) {
    alerts[threshold] = { at, readingAt: v.lastUsageSyncAt || at, remainingBytes: remaining, cycle,
      status: threshold === reached.at(-1) ? "pending" : "skipped", attempts: 0 };
  }
  return true;
}

export function usageAlertMessage(v, threshold) {
  return Number(threshold) >= 100
    ? { title: "Bundle data used up", body: "Your bundle's data is used up. Renew or switch your plan to stay connected." }
    : { title: threshold === "low" ? "Your bundle data is nearly used up" : `${threshold}% of your data used`,
      body: `${formatDataBalance(v.quotaBytes - v.usedBytes)} left at the latest reading. Renew or choose a plan before data runs out.` };
}

export function createUsageAlertSender({ store, config, now = () => new Date(), logger, maxAttempts = 3, send }) {
  const version = (v, key) => JSON.stringify(v.usageAlertCycle ? [v.id, v.customerId, key, v.usageAlertCycle, v.usageAlerts[key].at || null, v.quotaBytes] : [v.id, v.customerId, key, v.usageAlerts[key].at || null, v.quotaBytes]);
  const eligible = (s, id, key) => {
    const v = s.vouchers.find((v) => v.id === id), alert = v?.usageAlerts?.[key];
    if (!alert || alert.status !== "pending" || newerUsageAllocation(s, v)) return null;
    if (!["90", "low", "100"].includes(key) || rank(dataWarning(v)) < rank(key)) return null;
    if (v.usageAlertCycle && v.usageAlertCycle !== usageAllocation(v) || alert.cycle && alert.cycle !== v.usageAlertCycle ||
      alert.readingAt && Date.parse(v.lastUsageSyncAt || alert.readingAt) < +now() - 120000 ||
      key === "low" && dataWarning(v) !== "low") return null;
    const c = s.customers.find((c) => c.id === v.customerId), prefs = notificationPreferences(s, "customer:" + v.customerId);
    if (!c || c.status === "suspended" || c.suspended || !prefs.usagePush || !prefs.categories.usage || !prefs.usageThresholds.includes(key) ||
      !["active", "exhausted"].includes(v.status) || Date.parse(v.expiresAt) <= +now() ||
      Date.parse(alert.at) < +now() - (Number(key) >= 100 ? 86400000 : 21600000) ||
      c.activeVoucherId && c.activeVoucherId !== v.id || Object.keys(v.usageAlerts).some((level) => rank(level) > rank(key))) return null;
    const item = notificationItems(s, { type: "customer", id: c.id }, now()).find((n) => n.id === usageNotificationId(v, key));
    if (item?.read || item?.archived) return null;
    return v;
  };
  async function runOnce() {
    if (!config.enabled) return { due: 0, sent: 0 };
    const snapshot = await store.snapshot(), due = [];
    for (const v of snapshot.vouchers) for (const [key, alert] of Object.entries(v.usageAlerts || {})) {
      if (alert?.status === "pending" && !(Date.parse(alert.nextAttemptAt) > +now())) due.push({ v, key });
    }
    let sent = 0;
    for (const { v, key } of due.slice(0, 50)) {
      const recipient = "customer:" + v.customerId, eventId = usageNotificationId(v, key), subscriptions = recipientSubscriptions(snapshot, recipient);
      let delivered = 0;
      for (const subscription of subscriptions) {
        const result = await deliverNotification({ store, config, now, send, maxAttempts, recipient, eventId, subscription, version: version(v, key),
          resolve(s) {
            const current = eligible(s, v.id, key);
            return current && { version: version(current, key), topicKey: "usage:" + current.id, ttl: key === "low" ? 60 : key === "90" ? 300 : Number(key) >= 100 ? 86400 : 21600,
              payload: { ...usageAlertMessage(current, key), tag: "usage-" + current.id, url: "/dashboard#bundles" } };
          },
        });
        if (result.delivered) delivered++;
      }
      await store.transaction((s) => {
        const voucher = s.vouchers.find((x) => x.id === v.id), alert = voucher?.usageAlerts?.[key];
        if (!alert || alert.status !== "pending" || version(voucher, key) !== version(v, key)) return;
        if (!eligible(s, v.id, key)) { alert.status = "cancelled"; delete alert.nextAttemptAt; return; }
        const targets = recipientSubscriptions(s, recipient), rows = targets.map((sub) => s.notificationStates.find((n) => n.id === deliveryId(recipient, eventId, sub) && n.version === version(v, key)));
        const allRows = s.notificationStates.filter((n) => n.actor === recipient && n.notificationId === eventId && n.version === version(v, key));
        const pending = rows.some((row) => !row || ["sending", "retry"].includes(row.status));
        alert.attempts = Math.max(0, ...allRows.map((r) => r.attempts));
        if (!pending) alert.status = allRows.some((r) => r.status === "sent") ? "sent" : targets.length ? "failed" : "no_subscription";
        if (alert.status === "sent") alert.sentAt = now().toISOString();
        const next = rows.filter((r) => r?.status === "retry").map((r) => r.nextAttemptAt).sort()[0];
        if (pending && next) alert.nextAttemptAt = next; else delete alert.nextAttemptAt;
      });
      if (delivered) sent++;
      logger?.info("usage_alert.processed", { voucherId: v.id, threshold: key, delivered });
    }
    return { due: due.length, sent };
  }
  let running;
  return function run() {
    if (running) return running;
    running = runOnce().finally(() => { running = undefined; });
    return running;
  };
}
