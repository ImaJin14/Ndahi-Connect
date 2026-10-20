import webPush from "web-push";
import { notificationPreferences } from "./notifications.mjs";

// Data-usage alerts at 50%, 75% and 100% of a bundle's quota, delivered as Web
// Push notifications to the devices a customer opted in.
export const USAGE_THRESHOLDS = [50, 75, 100];

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
  const percent = (v.usedBytes / v.quotaBytes) * 100, alerts = (v.usageAlerts ??= {}),
    reached = USAGE_THRESHOLDS.filter((threshold) => percent >= threshold && !alerts[threshold]);
  if (!reached.length) return false;
  const at = now().toISOString();
  for (const threshold of reached) {
    alerts[threshold] = { at, status: threshold === reached.at(-1) ? "pending" : "skipped", attempts: 0 };
  }
  return true;
}

const gb = (bytes) => `${(Math.max(0, bytes) / 1e9).toFixed(bytes < 1e9 ? 2 : 1)} GB`;
export function usageAlertMessage(v, threshold) {
  return threshold >= 100
    ? { title: "Bundle data used up", body: "Your bundle's data is used up. Renew or switch your plan to stay connected." }
    : { title: `${threshold}% of your data used`, body: `You've used ${threshold}% of your bundle's data. ${gb(v.quotaBytes - v.usedBytes)} left.` };
}

export function createUsageAlertSender({ store, config, now = () => new Date(), logger, maxAttempts = 3,
  send = (subscription, payload, options) => webPush.sendNotification(subscription, payload, options) }) {
  const options = (threshold) => ({
    vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
    TTL: threshold >= 100 ? 86400 : 21600, urgency: "high", timeout: 10000,
  });
  async function runOnce() {
    const s = await store.snapshot(), due = [];
    for (const v of s.vouchers) for (const [key, alert] of Object.entries(v.usageAlerts || {})) {
      if (alert?.status === "pending" && !(Date.parse(alert.nextAttemptAt) > +now())) due.push({ v, threshold: Number(key) });
    }
    let sent = 0;
    for (const { v, threshold } of due.slice(0, 50)) {
      const preferences = notificationPreferences(s, "customer:" + v.customerId),
        subscriptions = preferences.usagePush && preferences.categories.usage ? s.customers.find((c) => c.id === v.customerId)?.pushSubscriptions || [] : [],
        payload = JSON.stringify({ ...usageAlertMessage(v, threshold), tag: `usage-${v.id}`, url: "/dashboard" }),
        gone = [];
      let delivered = 0;
      // Network I/O stays outside the transaction; one bad device does not block the others.
      for (const subscription of subscriptions) {
        try { await send(subscription, payload, options(threshold)); delivered++; }
        catch (error) { if ([404, 410].includes(error?.statusCode)) gone.push(subscription.endpoint); }
      }
      await store.transaction((state) => {
        const voucher = state.vouchers.find((x) => x.id === v.id), alert = voucher?.usageAlerts?.[threshold];
        if (!alert || alert.status !== "pending") return;
        const customer = state.customers.find((c) => c.id === v.customerId);
        if (customer && gone.length) customer.pushSubscriptions = (customer.pushSubscriptions || []).filter((x) => !gone.includes(x.endpoint));
        alert.attempts = (alert.attempts || 0) + 1;
        if (delivered) Object.assign(alert, { status: "sent", sentAt: now().toISOString() });
        else if (!subscriptions.length || subscriptions.length === gone.length) alert.status = "no_subscription";
        else if (alert.attempts >= maxAttempts) alert.status = "failed";
        else alert.nextAttemptAt = new Date(+now() + 60000 * 2 ** (alert.attempts - 1)).toISOString();
        if (alert.status !== "pending") delete alert.nextAttemptAt;
      });
      if (delivered) sent++;
      logger?.info("usage_alert.processed", { voucherId: v.id, threshold, delivered, expired: gone.length });
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
