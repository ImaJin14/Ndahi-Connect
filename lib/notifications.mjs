import { deliverNotification, recipientSubscriptions } from "./notification-delivery.mjs";
import { loginMethods } from "./sign-in-history.mjs";
import { incidentNotice } from "./operational-incidents.mjs";
import { formatDataBalance, usageNotificationId } from "../shared-app/data-usage.js";
import { linkedEmail } from "./email-state.mjs";
import { categoriesFor, compareNotifications, notificationPage, notificationFilters } from "./notification-history.mjs";

export const notificationCategories = ["devices", "payments", "usage", "security", "service", "network", "recovery"];
export const usageAlertLevels = ["90", "low", "100"];
export function notificationPreferences(s, actor) {
  const row = (s.notificationStates || []).find((x) => x.id === "preferences:" + actor);
  return { categories: Object.fromEntries(notificationCategories.map((c) => [c, row?.categories?.[c] !== false])),
    pushEnabled: row?.pushEnabled === true, pushSince: row?.pushSince || null, emailSecurity: row?.emailSecurity !== false, emailTransactions: row?.emailTransactions !== false, emailFallback: row?.emailFallback === true,
    usagePush: row?.usagePush !== false,
    usageThresholds: Array.isArray(row?.usageThresholds) ? usageAlertLevels.filter((level) => row.usageThresholds.includes(level)) : [...usageAlertLevels],
    expiryWarnings: row?.expiryWarnings === true, subscriptionUpdates: row?.subscriptionUpdates !== false };
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
  const items = [], add = (item) => items.push(item), admin = actor.type === "admin",
    prefs = notificationPreferences(s, actor.type + ":" + actor.id);
  const stamp = (value) => Number.isFinite(Date.parse(value)) ? value : "1970-01-01T00:00:00.000Z";
  if (!admin) {
    const c = s.customers.find((c) => c.id === actor.id);
    if (!c || c.status === "suspended" || c.suspended) return [];
    const requests = (s.wifiPairingRequests || []).filter((p) => p.customerId === c.id);
    for (const grant of (s.wifiDeviceGrants || []).filter((g) => g.customerId === c.id)) for (const expiry of grant.expiries || []) {
      const command = (s.routerCommands || []).find((job) => job.id === expiry.commandId);
      const confirmed = Boolean(expiry.routerConfirmedAt), failed = !confirmed && command?.status === "dead_letter";
      const cleanup = confirmed ? "Router cleanup is confirmed." : failed ? "Router cleanup failed and needs support attention." : "Router cleanup is pending confirmation.";
      add({ id: "approval-expiry:" + grant.id + ":" + expiry.generation, category: "devices", title: "Saved device approval expired",
        body: (expiry.name || "Device ending " + (expiry.mac || grant.mac).slice(-5)) + " was absent for 30 minutes of confirmed observations. Fresh main-device approval is required. " + cleanup,
        updatedAt: stamp(expiry.routerConfirmedAt || (failed ? command.deadLetteredAt : null) || expiry.at),
        actionRequired: failed, url: "/dashboard#devices", pushEligible: false });
    }
    for (const incident of s.operationalIncidents || []) if (incident.customerIds.includes(c.id) || incident.global && s.vouchers.some((v) => v.customerId === c.id && Date.parse(v.activatedAt || "1970-01-01") <= Date.parse(incident.lastAt))) add(incidentNotice(incident, false));
    if (!c.wifiMainDevice?.controllerHash && requests.some((p) => ["pending", "awaiting_code"].includes(p.status) && Date.parse(p.expiresAt) > +now)) add({
      id: "main-setup:" + c.id, category: "devices", title: "Set your main device", body: "Choose a main device before approving other devices.",
      updatedAt: stamp(c.wifiFirstConnectedAt || requests.at(-1)?.at), actionRequired: true, url: "/dashboard#devices" });
    for (const p of requests) {
      const active = ["pending", "awaiting_code"].includes(p.status) && Date.parse(p.expiresAt) > +now;
      add({ id: "device:" + p.id, category: "devices", title: p.status === "pending" && active ? "Device requesting access" : p.status === "awaiting_code" && active ? "Approval code ready" : "Device request " + (active || !["pending", "awaiting_code"].includes(p.status) ? p.status : "expired"),
        body: (p.name || "Unnamed device") + " · ending " + p.mac.slice(-5) + (p.status === "pending" && active ? ". Review this request on your main device." : ". Open device controls for details."),
        updatedAt: stamp(p.updatedAt || p.at), actionRequired: active, url: "/dashboard#devices", requestId: p.id,
        pushEligible: !["bootstrap", "reconnect"].includes(p.kind) && p.status !== "awaiting_code" });
    }
    for (const command of s.routerCommands || []) {
      if (command.action !== "disconnect_wifi_device" || !s.vouchers.some((v) => v.id === command.device?.voucherId && v.customerId === c.id) ||
        command.customerId && command.customerId !== c.id) continue;
      const pending = ["queued", "processing", "retry"].includes(command.status), failed = command.status === "dead_letter";
      add({ id: "wifi-disconnect:" + command.id, category: "devices", title: failed ? "Device disconnection needs attention" : pending ? "Device disconnecting" :
        command.result === "superseded" ? "Device connection changed" : "Device disconnection completed",
        body: "Device ending " + String(command.device.mac).slice(-5) + ". " + (failed ? "Removal is not confirmed. Review device controls or contact support." :
          pending ? "Waiting for router confirmation; its slot is not confirmed free." : command.result === "superseded" ? "The targeted session was replaced; this operation does not confirm disconnection." : "Open device controls for current connection and saved-approval status."),
        updatedAt: stamp(command.processedAt || command.lastAttemptAt || command.at), actionRequired: failed,
        url: "/dashboard#devices", pushEligible: command.status === "processed" && ["disconnected", "absent"].includes(command.result) });
    }
    for (const n of (s.securityAlerts || []).filter((n) => n.customerId === c.id && (!n.sourceSignInId || !n.signIn && !s.securityEvents.some((e) => e.id === n.sourceSignInId)))) add({
      id: "security:" + n.id, category: "security", title: n.subject, body: (n.lines || []).join(" "), updatedAt: stamp(n.at),
      actionRequired: false, url: "/dashboard#account" });
    const methods = { pin: "PIN", authenticator: "Authenticator", passkey: "Passkey", recovery: "Recovery code", voucher: "Voucher account", setup: "Account setup" };
    const signIns = new Map(s.securityEvents.filter((e) => e.meta?.customerId === c.id && Object.values(loginMethods).includes(e.type)).map((e) => [e.id, e]));
    for (const alert of (s.securityAlerts || []).filter((n) => n.customerId === c.id && n.signIn && n.sourceSignInId && !signIns.has(n.sourceSignInId))) signIns.set(alert.sourceSignInId, alert.signIn);
    for (const event of signIns.values()) {
      const method = Object.keys(loginMethods).find((m) => loginMethods[m] === event.type), unfamiliar = event.meta.recognized === false;
      add({ id: "sign-in:" + event.id, category: "security", title: methods[method] + " sign-in" + (unfamiliar ? " · Unrecognized browser" : ""),
        body: (event.meta.userAgent ? "Browser reported: " + event.meta.userAgent + ". " : "Browser details unavailable. ") +
          (event.ip ? "IP address: " + event.ip + ". " : "IP address unavailable. ") + "An IP address does not verify a device or physical location. Review active sessions if this was not you.",
        updatedAt: stamp(event.at), actionRequired: false, url: "/dashboard#sessions", linkLabel: "Review sessions", pushEligible: unfamiliar || method === "recovery" });
    }
    for (const p of s.payments.filter((p) => p.customerId === c.id)) {
      const attention = p.fulfillmentStatus === "needs_review" || p.refund?.status === "failed";
      add({ id: "payment:" + p.id, category: "payments", title: attention ? "Payment needs attention" : "Payment " + p.status,
        body: p.refund ? "Refund status: " + p.refund.status + ". Open payment history for details." : "Open payment history to check this payment and any available receipt.",
        updatedAt: stamp(p.refund?.updatedAt || p.updatedAt || p.confirmedAt || p.createdAt), actionRequired: attention, url: "/dashboard#payments" });
    }
    // A queued connect/approval is not a connection. This durable record is
    // written only after the exact router operation succeeds.
    for (const command of s.routerCommands || []) {
      if (command.action !== "connect_wifi_device" || command.status !== "processed" || command.result !== "connected") continue;
      const v = s.vouchers.find(v => v.id === command.device?.voucherId && v.customerId === c.id);
      const request = requests.find(p => p.id === command.targetId && p.customerId === c.id);
      if (!v || !request) continue;
      add({ id: "wifi-connected:" + command.id, category: "devices", title: "Wi-Fi connection confirmed",
        body: "The router confirmed this device connection at the recorded time. Open device controls for its current status.",
        updatedAt: stamp(command.processedAt), actionRequired: false, url: "/dashboard#devices" });
    }
    for (const v of s.vouchers.filter((v) => v.customerId === c.id)) {
      const payment = s.payments.find(p => p.id === v.paymentId && p.customerId === c.id && p.status === "paid" && p.confirmedAt && p.fulfillmentStatus !== "needs_review");
      if (payment && v.activatedAt && ["active", "expired", "exhausted"].includes(v.status)) add({
        id: "voucher-ready:" + v.id + ":" + payment.id, category: "payments", title: "Voucher ready after confirmed payment",
        body: "Your voucher was saved to your account. Open Vouchers to download its PDF again.",
        updatedAt: stamp(v.activatedAt), actionRequired: false, url: "/dashboard#vouchers" });
      const usage = [...(v.usageAlertHistory || []), ...Object.entries(v.usageAlerts || {}).map(([level, n]) => ({ ...n, level, cycle: n.cycle || v.usageAlertCycle || null }))];
      for (const n of usage.filter((n) => n.status !== "skipped" && prefs.usageThresholds.includes(n.level))) add({ id: usageNotificationId(v, n.level, n.cycle), category: "usage",
        title: n.level === "100" ? "Bundle data used up" : n.level === "low" ? "Low-data warning" : n.level + "% of your data used",
        body: Number.isFinite(n.remainingBytes) ? formatDataBalance(n.remainingBytes) + " remained at this reading. Open your bundle for the current balance." : "Open your bundle to check remaining data.",
        updatedAt: stamp(n.at), actionRequired: false, url: "/dashboard#bundles", pushEligible: false });
      if (prefs.expiryWarnings && v.status === "active" && Date.parse(v.expiresAt) > +now && Date.parse(v.expiresAt) <= +now + 3600000 &&
          (v.quotaBytes === null || Number.isFinite(v.quotaBytes) && v.quotaBytes > (v.usedBytes || 0))) add({
        id: "bundle-expiring:" + v.id + ":" + v.expiresAt, category: "usage", title: "Bundle expires within one hour",
        body: "Your bundle's validity ends soon. Open your bundle for the current expiry and balance.",
        updatedAt: new Date(Date.parse(v.expiresAt) - 3600000).toISOString(), actionRequired: false, url: "/dashboard#bundles" });
      if (prefs.subscriptionUpdates && (v.status === "expired" || v.status === "exhausted" && !v.usageAlerts?.[100])) add({ id: "bundle:" + v.id, category: "usage", title: v.status === "expired" ? "Bundle expired" : "Bundle data used up",
        body: "Renew or choose another package to reconnect.", updatedAt: stamp(v.status === "exhausted" ? v.exhaustedAt : v.expiresAt), actionRequired: false, url: "/dashboard#bundles" });
    }
  } else if (["owner", "operator"].includes(actor.role)) {
    for (const incident of s.operationalIncidents || []) add(incidentNotice(incident, true));
    const groups = new Map();
    for (const c of s.routerCommands || []) if (!c.operationalIncidentId && (c.status === "dead_letter" || c.replays > 0 || c.status === "resolved")) {
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
    for (const n of s.securityEvents.filter((n) => n.type === "admin.authorization.denied" || n.type === "admin.recovery_verification.failed")) {
      if (actor.role !== "owner") continue;
      add({ id: "admin-security:" + n.id, category: "security", title: "Administrator security event", body: "A protected administrator action failed verification. Review security activity.",
        updatedAt: stamp(n.at), actionRequired: false, url: "/dashboard#more" });
    }
  }
  if (s.zone?.status && s.zone.status !== "online") add({ id: "service:" + s.zone.id + ":" + s.zone.status, category: "service", title: "Service " + s.zone.status,
    body: s.zone.notes || "Check the service status before retrying.", updatedAt: stamp(s.zone.updatedAt), actionRequired: false, url: admin ? "/#home" : "/dashboard#home" });
  const recipient = actor.type + ":" + actor.id;
  return items.filter((item) => item.actionRequired || item.category === "security" || prefs.categories[item.category])
    .sort(compareNotifications).map((item) => {
      const state = (s.notificationStates || []).find((n) => n.actor === recipient && n.notificationId === item.id);
      const version = item.version || JSON.stringify([item.updatedAt, item.title, item.body, item.actionRequired]);
      return { ...item, version, read: state?.readVersion === version, archived: !item.actionRequired && state?.archivedVersion === version };
    });
}
export function notificationInbox(s, actor, now, filters = notificationFilters(null, actor)) {
  const items = notificationItems(s, actor, now), recipient = actor.type + ":" + actor.id;
  return { ...notificationPage(items, filters, recipient), categories: categoriesFor(actor), unreadCount: items.filter((n) => !n.read && !n.archived).length, actionCount: items.filter((n) => n.actionRequired).length,
    preferences: notificationPreferences(s, recipient), emailAvailable: actor.type === "customer" && Boolean(linkedEmail(s.customers.find((c) => c.id === actor.id))) };
}
export async function deliverActivityPush({ store, config, now = () => new Date(), send }) {
  if (!config.enabled) return { sent: 0 };
  const snapshot = await store.snapshot(), actors = [
    ...snapshot.customers.map((c) => ({ type: "customer", id: c.id })),
    ...snapshot.adminUsers.filter((u) => u.active !== false).map((u) => ({ type: "admin", id: u.id, role: u.role })),
  ];
  let sent = 0;
  for (const actor of actors) {
    const recipient = actor.type + ":" + actor.id;
    const eligible = (s, id) => {
      const prefs = notificationPreferences(s, recipient);
      if (!prefs.pushEnabled || !prefs.pushSince) return null;
      return notificationItems(s, actor, now()).find((n) => n.id === id && !n.read && !n.archived && n.pushEligible !== false &&
        Date.parse(n.updatedAt) >= +now() - 86400000 && prefs.categories[n.category] && (n.category !== "usage" || prefs.usagePush) && Date.parse(n.updatedAt) >= Date.parse(prefs.pushSince));
    };
    for (const item of notificationItems(snapshot, actor, now()).filter((n) => eligible(snapshot, n.id)).slice(0, 10)) {
      for (const subscription of recipientSubscriptions(snapshot, recipient)) {
        const result = await deliverNotification({ store, config, now, send, recipient, eventId: item.id, version: item.version, subscription,
          resolve(s) {
            const current = eligible(s, item.id);
            return current && { version: current.version, ttl: current.category === "devices" ? 300 : 3600, payload: {
              title: "NDAHI Connect", body: actor.type === "admin" ? "New administration activity. Open the admin app to review." : "New account activity. Open your portal to review.",
              tag: "activity-" + current.id, url: current.url,
            } };
          },
        });
        if (result.delivered) sent++;
      }
    }
  }
  return { sent };
}
