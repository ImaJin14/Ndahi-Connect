import { deliverNotification, deliverySettled, recipientSubscriptions } from "./notification-delivery.mjs";
import { loginMethods } from "./sign-in-history.mjs";
import { incidentNotice } from "./operational-incidents.mjs";
import { formatDataBalance, usageNotificationId } from "../shared-app/data-usage.js";
import { linkedEmail } from "./email-state.mjs";
import { categoriesFor, compareNotifications, notificationPage, notificationFilters } from "./notification-history.mjs";
import { purchasedPlan } from "./api/state.mjs";
import { planReminders, bookingReminders, planDeadline, slotStart } from "./store-kit-orders.mjs";

// Renewal moments (redesign PhoneRenew, #252): "today" or "tomorrow" and the
// time, on the network's clock.
const ZONE = "Africa/Douala";
const localDay = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE });
const localTime = (at) => new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: ZONE });

export const notificationCategories = ["devices", "payments", "usage", "security", "service", "network", "recovery", "orders"];
// Shop order updates start off (#357, as drawn); every other category starts on.
const offByDefault = new Set(["orders"]);
export const usageAlertLevels = ["90", "low", "100"];
export function notificationPreferences(s, actor) {
  const row = (s.notificationStates || []).find((x) => x.id === "preferences:" + actor);
  return { categories: Object.fromEntries(notificationCategories.map((c) => [c, offByDefault.has(c) ? row?.categories?.[c] === true : row?.categories?.[c] !== false])),
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
    // Outages (#259): the notice while it lasts, then "We're back online" with
    // the time added, to customers whose bundle ran during it.
    for (const o of (s.outages || []).filter((o) => o.notify && o.showToCustomers)) {
      const running = (v) => v.customerId === c.id && Date.parse(v.activatedAt) <= Date.parse(o.fixedAt || now.toISOString()) && Date.parse(v.expiresAt) > Date.parse(o.startedAt);
      if (!s.vouchers.some(running)) continue;
      const last = o.updates.at(-1);
      if (o.status === "live") add({ id: "outage:" + o.id, category: "service", title: `Internet is down in ${o.area}`, body: o.message.en + (last ? ` Update: ${last.text}` : ""),
        updatedAt: stamp(last ? last.at : o.createdAt), actionRequired: false, url: "/dashboard#home", pushEligible: true });
      else if (o.status === "fixed" && +now - Date.parse(o.fixedAt) < 7 * 86400000) {
        const credit = s.vouchers.filter((v) => v.customerId === c.id).flatMap((v) => v.outageCredits || []).find((x) => x.outageId === o.id);
        add({ id: "outage-fixed:" + o.id, category: "service", title: "We're back online",
          body: credit ? `Sorry for the interruption. We added ${credit.hours} ${credit.hours === 1 ? "hour" : "hours"} to your bundle to make up for it.` : "Sorry for the interruption.",
          updatedAt: stamp(o.fixedAt), actionRequired: false, url: "/dashboard#home", pushEligible: true });
      }
    }
    // Shop order updates (#357, owner: built as drawn, off by default): one notice
    // per paid order that follows it from placed to ready to collected. Never
    // action-required, so the Account switch alone decides whether it shows; the
    // collection code stays on the order page, not on a lock screen.
    for (const o of (s.storeOrders || []).filter((o) => o.customerId === c.id && o.payment?.status === "paid" && ["preparing", "ready", "collected"].includes(o.status))) {
      const name = typeof o.product?.name === "object" ? o.product.name.en : o.product?.name || "Your order",
        last = (action) => [...(o.history || [])].reverse().find((entry) => entry.action === action)?.at;
      const notice = { preparing: ["Order placed", `${name}: we're preparing it. We'll let you know when it's ready to collect.`, o.payment.confirmedAt || o.createdAt],
        ready: ["Order ready to collect", `${name} is ready to collect. Open the order for its collection code and pickup details.`, last("ready") || o.createdAt],
        collected: ["Order collected", `${name} was collected. Thank you for shopping with NDAHI.`, last("collect") || o.createdAt] }[o.status];
      add({ id: "order:" + o.id, category: "orders", title: notice[0], body: notice[1], updatedAt: stamp(notice[2]), actionRequired: false,
        url: "/dashboard#order/" + encodeURIComponent(o.id), pushEligible: true });
    }
    // Pay in 3 reminders (#426): 3 days and 1 day before each date, staff's
    // reminder, and a late payment's last day. Payments, so they show by default.
    // Installation (#425): booked, and the day before; shop order updates.
    for (const o of (s.storeOrders || []).filter((o) => o.customerId === c.id && o.kind !== "plan_payment" && (o.plan || o.installation))) {
      const name = o.kit?.name?.en || "your kit", day = (at) => new Date(at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "Africa/Douala" });
      for (const r of planReminders(o, now)) add({ id: `plan:${o.id}:${r.key}`, category: "payments", title: `Payment ${r.n} of 3 due ${day(r.dueAt)}`,
        body: `${r.amount.toLocaleString("en-US")} FCFA for ${name}. You can pay early, or pay everything left at once.`, updatedAt: stamp(r.manual ? r.key.slice(7) : new Date(Date.parse(r.dueAt) - r.days * 86400000)),
        actionRequired: false, url: "/dashboard#plan/" + encodeURIComponent(o.id), pushEligible: true });
      const late = o.plan?.status === "running" && o.plan.payments.find((p) => !p.paidAt && Date.parse(p.dueAt) < +now);
      if (late) add({ id: `plan-late:${o.id}:${late.n}`, category: "payments", title: `Payment ${late.n} of 3 is late`,
        body: `Pay by ${day(planDeadline(o.plan, late))} to keep ${name}; after that the plan is cancelled and everything paid is refunded except the Mobile Money fees.`,
        updatedAt: stamp(late.dueAt), actionRequired: true, url: "/dashboard#plan/" + encodeURIComponent(o.id), pushEligible: true });
      if (o.plan?.status === "cancelled") add({ id: `plan-cancelled:${o.id}`, category: "payments", title: "Payment plan cancelled",
        body: `${name}: everything you paid is being refunded except the Mobile Money fees.`, updatedAt: stamp(o.plan.cancelledAt), actionRequired: false,
        url: "/dashboard#order/" + encodeURIComponent(o.id), pushEligible: true });
      for (const r of bookingReminders(o, now)) { const b = o.installation, slot = b.slot === "morning" ? "morning" : "afternoon";
        add({ id: `install:${o.id}:${r.key}`, category: "orders", title: r.kind === "tomorrow" ? "Installation tomorrow" : "Installation booked",
          body: `${day(`${b.day}T12:00:00Z`)} · ${slot}, ${b.area.name}. The technician calls 30 minutes before arriving.`,
          updatedAt: stamp(r.kind === "tomorrow" ? new Date(+slotStart(b.day, b.slot) - 1.5 * 86400000) : o.payment.confirmedAt), actionRequired: false,
          url: "/dashboard#order/" + encodeURIComponent(o.id), pushEligible: true }); }
    }
    for (const incident of s.operationalIncidents || []) if (incident.customerIds.includes(c.id) || incident.global && s.vouchers.some((v) => v.customerId === c.id && Date.parse(v.activatedAt || "1970-01-01") <= Date.parse(incident.lastAt))) add(incidentNotice(incident, false));
    if (!c.wifiMainDevice?.controllerHash && requests.some((p) => ["pending", "awaiting_code", "awaiting_confirmation"].includes(p.status) && Date.parse(p.expiresAt) > +now)) add({
      id: "main-setup:" + c.id, category: "devices", title: "Set your main device", body: "Choose a main device before approving other devices.",
      updatedAt: stamp(c.wifiFirstConnectedAt || requests.at(-1)?.at), actionRequired: true, url: "/dashboard#devices" });
    for (const p of requests) {
      const active = ["pending", "awaiting_code", "awaiting_confirmation"].includes(p.status) && Date.parse(p.expiresAt) > +now;
      add({ id: "device:" + p.id, category: "devices", title: ["pending", "awaiting_confirmation"].includes(p.status) && active ? "Device requesting access" : p.status === "awaiting_code" && active ? "Approval code ready" : "Device request " + (active || !["pending", "awaiting_code", "awaiting_confirmation"].includes(p.status) ? p.status : "expired"),
        body: (p.name || "Unnamed device") + " · ending " + p.mac.slice(-5) + (["pending", "awaiting_confirmation"].includes(p.status) && active ? ". Review this request on your main device." : ". Open device controls for details."),
        updatedAt: stamp(p.updatedAt || p.at), actionRequired: active, url: p.protocol === 3 && active ? "/pair-review.html?request=" + p.id : "/dashboard#devices", requestId: p.id,
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
    // From staff (Customers bulk message, #257).
    for (const m of (s.customerMessages || []).filter((m) => m.customerId === c.id)) add({
      id: "message:" + m.id, category: "service", title: "Message from NDAHI", body: m.body,
      updatedAt: stamp(m.at), actionRequired: false, url: "/dashboard#home", pushEligible: true });
    for (const v of s.vouchers.filter((v) => v.customerId === c.id)) {
      // A bundle staff gave this account (canvas: AdminVouchers, #343; owner 26 Nov).
      if (v.givenAt && !v.reservation && ["active", "available"].includes(v.status)) add({
        id: "given:" + v.id, category: "payments", title: "A bundle was added to your account",
        body: v.startsOnFirstConnection ? "NDAHI added a bundle to your account. It starts when you first connect; see it in Internet." : "NDAHI added a bundle to your account. It's active now; see it in Internet.",
        updatedAt: stamp(v.givenAt), actionRequired: false, url: "/dashboard#internet", pushEligible: true });
      // A gift bundle saved in the account until the customer starts it (#257).
      else if (v.status === "available" && v.saleType === "gift") add({
        id: "gift:" + v.id, category: "payments", title: "A gift bundle is waiting for you",
        body: "It's saved in your account. Enter its code from Vouchers when you're ready to start it.",
        updatedAt: stamp(v.giftedAt || v.createdAt), actionRequired: false, url: "/dashboard#vouchers", pushEligible: true });
      const payment = s.payments.find(p => p.id === v.paymentId && p.customerId === c.id && p.status === "paid" && p.confirmedAt && p.fulfillmentStatus !== "needs_review");
      if (payment && v.activatedAt && ["active", "expired", "exhausted"].includes(v.status)) add({
        id: "voucher-ready:" + v.id + ":" + payment.id, category: "payments", title: "Voucher ready after confirmed payment",
        body: "Your voucher was saved to your account. Open Vouchers to download its PDF again.",
        updatedAt: stamp(v.activatedAt), actionRequired: false, url: "/dashboard#vouchers" });
      // Someone bought this customer a bundle (#255); it waits in the account until they start it.
      const giver = v.giftedBy && v.status === "available" && s.customers.find((x) => x.id === v.giftedBy);
      if (giver) add({ id: "gift-from:" + v.id, category: "payments", title: `${String(giver.name || "Someone").trim().split(/\s+/)[0]} bought you a bundle`,
        body: v.giftNote ? `"${v.giftNote}" It's saved in your account. Start it from Vouchers when you're ready.` : "It's saved in your account. Start it from Vouchers when you're ready.",
        updatedAt: stamp(v.giftedAt || v.createdAt), actionRequired: false, url: "/dashboard#vouchers", pushEligible: true });
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
      const planName = purchasedPlan(s, v)?.name || "bundle";
      // The day before it ends (#252): one reminder, with "buy again" to follow.
      // Only for bundles longer than a day; a daily bundle is always that close.
      const ends = Date.parse(v.expiresAt), lasts = ends - (Date.parse(v.activatedAt) || ends);
      if (prefs.subscriptionUpdates && v.status === "active" && lasts > 1.5 * 86400000 && ends > +now + 3600000 && ends <= +now + 86400000) add({
        id: "bundle-ending:" + v.id + ":" + v.expiresAt, category: "usage",
        // As PhoneNotifications draws it (#362): "Bundle ends tomorrow", then the plan and time; it opens Internet.
        title: `Bundle ends ${localDay(ends) === localDay(+now) ? "today" : "tomorrow"}`,
        body: `${planName} ends ${localDay(ends) === localDay(+now) ? "today" : "tomorrow"} at ${localTime(ends)}. You can buy your next bundle once it ends.`,
        updatedAt: new Date(ends - 86400000).toISOString(), actionRequired: false, url: "/dashboard#internet", pushEligible: true });
      if (prefs.subscriptionUpdates && (v.status === "expired" || v.status === "exhausted" && !v.usageAlerts?.[100])) add({ id: "bundle:" + v.id, category: "usage", title: v.status === "expired" ? `Your ${planName} has ended` : "Bundle data used up",
        body: "Tap to buy it again in one step.", updatedAt: stamp(v.status === "exhausted" ? v.exhaustedAt : v.expiresAt), actionRequired: false, url: "/dashboard#home",
        pushEligible: !s.vouchers.some(other => other.id !== v.id && other.customerId === c.id && ["active", "expired", "exhausted"].includes(other.status) && Date.parse(other.activatedAt) > Date.parse(v.activatedAt || "1970-01-01T00:00:00Z")) });
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
    // A reseller asked for more codes from their phone home (#261); the owner
    // assigns or prints them from Resellers.
    if (actor.role === "owner") for (const u of (s.adminUsers || []).filter((u) => u.role === "reseller")) for (const r of (u.stockRequests || []).slice(-20)) add({
      id: "stock-request:" + r.id, category: "payments", title: `${u.displayName || u.username} asked for more codes`,
      body: "Assign or print codes for this reseller from Resellers.", updatedAt: stamp(r.createdAt), actionRequired: false, url: "/dashboard#resellers", pushEligible: true });
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
// The background workers build every customer's notifications from one snapshot.
// notificationItems searches whole collections for one customer's records, so
// calling it per customer on the whole snapshot cost customers × records, every
// 15 seconds, and stalled sign-in (#464). This indexes the snapshot once. A
// customer's view holds every record notificationItems (and the email
// fallback's checks) can match for that customer, in the original order, and
// shares everything else, so notificationItems(view(id), customer) gives the
// same list as notificationItems(s, customer).
const customerCollections = ["vouchers", "payments", "securityEvents", "securityAlerts", "wifiPairingRequests",
  "wifiDeviceGrants", "customerMessages", "routerCommands", "notificationStates"];
export function customerNotificationViews(s) {
  const refs = (rows, pairs) => {
    const map = new Map();
    for (const row of rows || []) for (const [key, customerId] of pairs(row)) {
      if (key == null || customerId == null) continue;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(customerId);
    }
    return map;
  };
  const recipients = new Map(), preferences = new Map();
  for (const c of s.customers || []) { recipients.set("customer:" + c.id, c.id); preferences.set("preferences:customer:" + c.id, c.id); }
  // Records reached through another record: a voucher's router commands and
  // payment (a gift's payment is the giver's), a saved device approval's expiry
  // commands, and the sign-in a security alert points at.
  const voucherOwners = refs(s.vouchers, (v) => [[v.id, v.customerId]]),
    paymentRefs = refs(s.vouchers, (v) => [[v.paymentId, v.customerId]]),
    commandRefs = refs(s.wifiDeviceGrants, (g) => (g.expiries || []).map((e) => [e.commandId, g.customerId])),
    eventRefs = refs(s.securityAlerts, (n) => [[n.sourceSignInId, n.customerId]]);
  const owners = {
    vouchers: (v) => [v.customerId],
    payments: (p) => [p.customerId, ...paymentRefs.get(p.id) || []],
    securityEvents: (e) => [e.meta?.customerId, ...eventRefs.get(e.id) || []],
    securityAlerts: (n) => [n.customerId],
    wifiPairingRequests: (p) => [p.customerId],
    wifiDeviceGrants: (g) => [g.customerId],
    customerMessages: (m) => [m.customerId],
    routerCommands: (c) => [...commandRefs.get(c.id) || [], ...voucherOwners.get(c.device?.voucherId) || []],
    notificationStates: (n) => [recipients.get(n.actor), preferences.get(n.id)],
  };
  const own = new Map();
  for (const key of customerCollections) for (const row of s[key] || []) {
    for (const customerId of new Set(owners[key](row))) {
      if (customerId == null) continue;
      if (!own.has(customerId)) own.set(customerId, Object.fromEntries(customerCollections.map((k) => [k, []])));
      own.get(customerId)[key].push(row);
    }
  }
  const none = Object.fromEntries(customerCollections.map((k) => [k, []]));
  return (customerId) => ({ ...s, ...own.get(customerId) || none });
}
export function notificationInbox(s, actor, now, filters = notificationFilters(null, actor)) {
  const items = notificationItems(s, actor, now), recipient = actor.type + ":" + actor.id;
  return { ...notificationPage(items, filters, recipient), categories: categoriesFor(actor), unreadCount: items.filter((n) => !n.read && !n.archived).length, actionCount: items.filter((n) => n.actionRequired).length,
    preferences: notificationPreferences(s, recipient), emailAvailable: actor.type === "customer" && Boolean(linkedEmail(s.customers.find((c) => c.id === actor.id))) };
}
export async function deliverActivityPush({ store, config, now = () => new Date(), send }) {
  if (!config.enabled) return { sent: 0 };
  const snapshot = await store.snapshot(), view = customerNotificationViews(snapshot), actors = [
    ...snapshot.customers.map((c) => ({ type: "customer", id: c.id })),
    ...snapshot.adminUsers.filter((u) => u.active !== false).map((u) => ({ type: "admin", id: u.id, role: u.role })),
  ];
  let sent = 0;
  for (const actor of actors) {
    const recipient = actor.type + ":" + actor.id, own = actor.type === "customer" ? view(actor.id) : snapshot;
    const pushOn = (s) => { const prefs = notificationPreferences(s, recipient); return prefs.pushEnabled && prefs.pushSince ? prefs : null; };
    const pushable = (prefs, n) => !n.read && !n.archived && n.pushEligible !== false &&
      Date.parse(n.updatedAt) >= +now() - 86400000 && prefs.categories[n.category] && (n.category !== "usage" || prefs.usagePush) && Date.parse(n.updatedAt) >= Date.parse(prefs.pushSince);
    const eligible = (s, id) => {
      const prefs = pushOn(s);
      return prefs ? notificationItems(s, actor, now()).find((n) => n.id === id && pushable(prefs, n)) : null;
    };
    // Nothing can be pushed to someone with push off or no subscription, so
    // their list is not built at all. Everyone else's is built once (#464).
    const prefs = pushOn(own), subscriptions = prefs ? recipientSubscriptions(own, recipient) : [];
    if (!subscriptions.length) continue;
    const items = notificationItems(own, actor, now()), due = new Set(items.filter((n) => pushable(prefs, n)).map((n) => n.id));
    for (const item of items.filter((n) => due.has(n.id)).slice(0, 10)) {
      for (const subscription of subscriptions) {
        if (deliverySettled(own, recipient, item.id, item.version, subscription, now())) continue;
        const result = await deliverNotification({ store, config, now, send, recipient, eventId: item.id, version: item.version, subscription,
          resolve(s) {
            const current = eligible(s, item.id);
            if (!current) return null;
            const expiry = s.vouchers.find(v => current.id === "bundle-expiring:" + v.id + ":" + v.expiresAt)?.expiresAt;
            const ttl = Math.max(1, Math.min(current.category === "devices" ? 300 : 3600,
              expiry ? Math.floor((Date.parse(expiry) - +now()) / 1000) : 3600));
            return { version: current.version, ttl, payload: {
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
