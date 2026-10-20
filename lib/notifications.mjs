import { createHash, randomUUID } from "node:crypto";
import webPush from "web-push";
import { linkedEmail } from "./email-state.mjs";

export const notificationCategories = ["devices", "payments", "usage", "security", "service", "network", "recovery"];
export function notificationPreferences(s, actor) {
  const row = (s.notificationStates || []).find((x) => x.id === "preferences:" + actor);
  return { categories: Object.fromEntries(notificationCategories.map((c) => [c, row?.categories?.[c] !== false])),
    pushEnabled: row?.pushEnabled === true, pushSince: row?.pushSince || null, emailSecurity: row?.emailSecurity !== false,
    usagePush: row?.usagePush !== false };
}
export function preferencesRow(s, actor) {
  s.notificationStates ??= [];
  let row = s.notificationStates.find((x) => x.id === "preferences:" + actor);
  if (!row) { row = { id: "preferences:" + actor, actor }; s.notificationStates.push(row); }
  return row;
}
// Content comes from durable domain records. Per-person read/archive/delivery state
// is separate: viewing an alert never changes a payment or approves a request.
export function notificationItems(s, actor, now = new Date()) {
  if (actor.type === "admin") {
    const current = s.adminUsers.find((u) => u.id === actor.id);
    if (current?.active === false) return [];
    if (current) actor = { ...actor, role: current.role };
  }
  const items = [], add = (item) => items.push(item), admin = actor.type === "admin";
  const stamp = (value) => Number.isFinite(Date.parse(value)) ? value : "1970-01-01T00:00:00.000Z";
  if (!admin) {
    const c = s.customers.find((c) => c.id === actor.id);
    if (!c || c.status === "suspended") return [];
    const requests = (s.wifiPairingRequests || []).filter((p) => p.customerId === c.id);
    if (!c.wifiMainDevice?.controllerHash && requests.some((p) => ["pending", "awaiting_code"].includes(p.status) && Date.parse(p.expiresAt) > +now)) add({
      id: "main-setup:" + c.id, category: "devices", title: "Set your main device", body: "Choose a main device before approving other devices.",
      updatedAt: stamp(c.wifiFirstConnectedAt || requests.at(-1)?.at), actionRequired: true, url: "/dashboard#home" });
    for (const p of requests.filter((p) => !["bootstrap", "reconnect"].includes(p.kind))) {
      const active = ["pending", "awaiting_code"].includes(p.status) && Date.parse(p.expiresAt) > +now;
      add({ id: "device:" + p.id, category: "devices", title: p.status === "pending" && active ? "Device requesting access" : p.status === "awaiting_code" && active ? "Approval code ready" : "Device request " + (active || !["pending", "awaiting_code"].includes(p.status) ? p.status : "expired"),
        body: (p.name || "Unnamed device") + " · ending " + p.mac.slice(-5) + (p.status === "pending" && active ? ". Review this request on your main device." : ". Open device controls for details."),
        updatedAt: stamp(p.updatedAt || p.at), actionRequired: p.status === "pending" && active, url: "/dashboard#home", requestId: p.id,
        pushEligible: p.status !== "awaiting_code" });
    }
    for (const n of (s.securityAlerts || []).filter((n) => n.customerId === c.id)) add({
      id: "security:" + n.id, category: "security", title: n.subject, body: (n.lines || []).join(" "), updatedAt: stamp(n.at),
      actionRequired: false, url: "/dashboard#account" });
    for (const p of s.payments.filter((p) => p.customerId === c.id)) {
      const attention = p.fulfillmentStatus === "needs_review" || p.refund?.status === "failed";
      add({ id: "payment:" + p.id, category: "payments", title: attention ? "Payment needs attention" : "Payment " + p.status,
        body: p.refund ? "Refund status: " + p.refund.status + ". Open payment history for details." : "Open payment history to check this payment and any available receipt.",
        updatedAt: stamp(p.refund?.updatedAt || p.updatedAt || p.confirmedAt || p.createdAt), actionRequired: attention, url: "/dashboard#payments" });
    }
    for (const v of s.vouchers.filter((v) => v.customerId === c.id)) {
      for (const [level, n] of Object.entries(v.usageAlerts || {})) add({ id: "usage:" + v.id + ":" + level, category: "usage",
        title: level === "100" ? "Bundle data used up" : level + "% of your data used", body: "Open your bundle to check remaining data.",
        updatedAt: stamp(n.at), actionRequired: false, url: "/dashboard#bundles", pushEligible: false });
      if (["expired", "exhausted"].includes(v.status)) add({ id: "bundle:" + v.id, category: "usage", title: v.status === "expired" ? "Bundle expired" : "Bundle data used up",
        body: "Renew or choose another package to reconnect.", updatedAt: stamp(v.expiresAt), actionRequired: false, url: "/dashboard#bundles" });
    }
  } else if (["owner", "operator"].includes(actor.role)) {
    const groups = new Map();
    for (const c of s.routerCommands || []) if (c.status === "dead_letter" || c.replays > 0 || c.status === "resolved") {
      const group = groups.get(c.action) || []; group.push(c); groups.set(c.action, group);
    }
    for (const [action, commands] of groups) {
      const failed = commands.filter((c) => c.status === "dead_letter").length, pending = commands.some((c) => ["queued", "retry", "processing"].includes(c.status));
      add({ id: "network:" + action, category: "network", title: failed ? "Router work needs attention" : pending ? "Router recovery in progress" : "Router work recovered",
        body: failed ? failed + " failed " + action.replaceAll("_", " ") + " operation(s). Review the network queue." : "Review the network queue and audit history for this recovery.",
        updatedAt: stamp(commands.map((c) => c.processedAt || c.resolvedAt || c.lastAttemptAt || c.at).sort().at(-1)), actionRequired: failed > 0, url: "/dashboard#more" });
    }
    for (const p of s.payments.filter((p) => p.fulfillmentStatus === "needs_review" || p.refund)) add({
      id: "admin-payment:" + p.id, category: "payments", title: p.refund ? "Refund " + p.refund.status : "Payment activation needs review",
      body: "Review the payment record before taking action.", updatedAt: stamp(p.refund?.requestedAt || p.refund?.updatedAt || p.updatedAt || p.createdAt),
      actionRequired: p.fulfillmentStatus === "needs_review" || ["failed", "requested"].includes(p.refund?.status), url: "/dashboard#payments" });
    if (actor.role === "owner") for (const n of s.auditLogs.filter((n) => n.action === "customer.support_recovery.approved")) add({
      id: "recovery:" + n.id, category: "recovery", title: "Account recovery approved", body: "An identity-verified support recovery was recorded. Review the audit trail.",
      updatedAt: stamp(n.at), actionRequired: false, url: "/dashboard#more" });
    for (const n of s.securityEvents.filter((n) => n.type === "admin.authorization.denied" || n.type === "admin.recovery_verification.failed").slice(0, 20)) {
      if (actor.role !== "owner") continue;
      add({ id: "admin-security:" + n.id, category: "security", title: "Administrator security event", body: "A protected administrator action failed verification. Review security activity.",
        updatedAt: stamp(n.at), actionRequired: false, url: "/dashboard#more" });
    }
  }
  if (s.zone?.status && s.zone.status !== "online") add({ id: "service:" + s.zone.id + ":" + s.zone.status, category: "service", title: "Service " + s.zone.status,
    body: s.zone.notes || "Check the service status before retrying.", updatedAt: stamp(s.zone.updatedAt), actionRequired: false, url: admin ? "/#home" : "/dashboard#home" });
  const recipient = actor.type + ":" + actor.id, prefs = notificationPreferences(s, recipient);
  return items.filter((item) => item.actionRequired || item.category === "security" || prefs.categories[item.category])
    .sort((a, b) => Number(b.actionRequired) - Number(a.actionRequired) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 100).map((item) => {
      const state = (s.notificationStates || []).find((n) => n.actor === recipient && n.notificationId === item.id);
      const version = JSON.stringify([item.updatedAt, item.title, item.body, item.actionRequired]);
      return { ...item, version, read: state?.readVersion === version, archived: !item.actionRequired && state?.archivedVersion === version };
    });
}
export function notificationInbox(s, actor, now) {
  const items = notificationItems(s, actor, now), recipient = actor.type + ":" + actor.id;
  return { items, unreadCount: items.filter((n) => !n.read && !n.archived).length, actionCount: items.filter((n) => n.actionRequired).length,
    preferences: notificationPreferences(s, recipient), emailAvailable: actor.type === "customer" && Boolean(linkedEmail(s.customers.find((c) => c.id === actor.id))) };
}
export async function deliverActivityPush({ store, config, now = () => new Date(), send = webPush.sendNotification.bind(webPush) }) {
  if (!config.enabled) return { sent: 0 };
  const snapshot = await store.snapshot(), actors = [
    ...snapshot.customers.map((c) => ({ type: "customer", id: c.id })),
    ...snapshot.adminUsers.filter((u) => u.active !== false).map((u) => ({ type: "admin", id: u.id, role: u.role })),
  ];
  let sent = 0;
  for (const actor of actors) {
    const recipient = actor.type + ":" + actor.id, prefs = notificationPreferences(snapshot, recipient);
    if (!prefs.pushEnabled || !prefs.pushSince) continue;
    const subscriptions = actor.type === "customer" ? snapshot.customers.find((c) => c.id === actor.id)?.pushSubscriptions || []
      : preferencesRow(snapshot, recipient).subscriptions || [];
    for (const item of notificationItems(snapshot, actor, now()).filter((n) => !n.read && !n.archived && n.pushEligible !== false && Date.parse(n.updatedAt) >= Date.parse(prefs.pushSince)).slice(0, 10)) {
      for (const subscription of subscriptions) {
        const id = "delivery:" + createHash("sha256").update(JSON.stringify([recipient, item.id, subscription.endpoint])).digest("hex"), token = randomUUID();
        const claim = await store.transaction((s) => {
          s.notificationStates ??= [];
          let row = s.notificationStates.find((n) => n.id === id);
          if (row?.version === item.version && (row.status === "sent" || row.attempts >= 5 || Date.parse(row.nextAttemptAt) > +now())) return false;
          if (row?.leaseUntil && Date.parse(row.leaseUntil) > +now()) return false;
          // Recheck consent and current domain state after taking the lock.
          if (!notificationPreferences(s, recipient).pushEnabled || !notificationItems(s, actor, now()).some((n) => n.id === item.id && n.version === item.version && !n.read && !n.archived)) return false;
          const currentSubscriptions = actor.type === "customer" ? s.customers.find((c) => c.id === actor.id)?.pushSubscriptions : preferencesRow(s, recipient).subscriptions;
          if (!currentSubscriptions?.some((n) => n.endpoint === subscription.endpoint)) return false;
          if (!row) { row = { id, actor: recipient }; s.notificationStates.push(row); }
          if (row.version !== item.version) row.attempts = 0;
          Object.assign(row, { token, version: item.version, attempts: (row.attempts || 0) + 1, leaseUntil: new Date(+now() + 30000).toISOString() });
          return true;
        });
        if (!claim) continue;
        let delivered = false, gone = false;
        try {
          await send(subscription, JSON.stringify({ title: "NDAHI Connect", body: actor.type === "admin" ? "New administration activity. Open the admin app to review." : "New account activity. Open your portal to review.",
            tag: "activity-" + item.id, url: item.url }), { vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey }, TTL: item.category === "devices" ? 300 : 3600, timeout: 10000 });
          delivered = true; sent++;
        } catch (error) { gone = [404, 410].includes(error?.statusCode); }
        await store.transaction((s) => {
          const row = s.notificationStates.find((n) => n.id === id);
          if (row?.token !== token) return;
          row.status = delivered || gone ? "sent" : "retry"; row.nextAttemptAt = new Date(+now() + 60000 * 2 ** row.attempts).toISOString(); delete row.token; delete row.leaseUntil;
          if (gone) {
            const holder = actor.type === "customer" ? s.customers.find((c) => c.id === actor.id) : preferencesRow(s, recipient);
            const key = actor.type === "customer" ? "pushSubscriptions" : "subscriptions";
            holder[key] = (holder[key] || []).filter((n) => n.endpoint !== subscription.endpoint);
          }
        });
      }
    }
  }
  return { sent };
}
