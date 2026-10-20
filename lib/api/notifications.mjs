import { createHash } from "node:crypto";
import { body, json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { notificationCategories, notificationInbox, preferencesRow } from "../notifications.mjs";
import { pushSubscription, usageAlertConfig, maxPushSubscriptions } from "../usage-alerts.mjs";

function apply(s, actor, input, now) {
  const recipient = actor.type + ":" + actor.id, items = notificationInbox(s, actor, now).items;
  const prefs = preferencesRow(s, recipient);
  if (input.action === "preferences") {
    if (input.categories !== undefined && (!input.categories || Array.isArray(input.categories) || typeof input.categories !== "object" ||
      Object.entries(input.categories).some(([key, value]) => !notificationCategories.includes(key) || typeof value !== "boolean"))) return { status: 400, error: "Choose valid notification categories." };
    for (const key of ["pushEnabled", "emailSecurity", "usagePush"]) {
      if (input[key] !== undefined && typeof input[key] !== "boolean") return { status: 400, error: "Choose valid notification preferences." };
    }
    prefs.categories = { ...(prefs.categories || {}), ...(input.categories || {}), security: true };
    if (input.pushEnabled === true && !prefs.pushEnabled) prefs.pushSince = now.toISOString();
    for (const key of ["pushEnabled", "emailSecurity", "usagePush"]) if (input[key] !== undefined) prefs[key] = input[key];
    return {};
  }
  if (input.action === "subscribe" || input.action === "unsubscribe") {
    const holder = actor.type === "customer" ? s.customers.find((c) => c.id === actor.id) : prefs, key = actor.type === "customer" ? "pushSubscriptions" : "subscriptions";
    if (input.action === "unsubscribe") { holder[key] = (holder[key] || []).filter((n) => n.endpoint !== input.endpoint); return {}; }
    const subscription = pushSubscription(input.subscription);
    if (!subscription) return { status: 400, error: "This browser subscription is not supported." };
    holder[key] = (holder[key] || []).filter((n) => n.endpoint !== subscription.endpoint);
    if (holder[key].length >= maxPushSubscriptions) return { status: 409, error: "Turn off notifications on another device before adding this one." };
    holder[key].push(subscription); return {};
  }
  if (!["read", "read-all", "archive", "restore"].includes(input.action)) return { status: 400, error: "Choose a notification action." };
  const selected = input.action === "read-all" ? items : items.filter((n) => n.id === input.id);
  if (!selected.length && input.action !== "read-all") return { status: 404, error: "Notification not found." };
  if (input.action === "archive" && selected.some((n) => n.actionRequired)) return { status: 409, error: "Resolve this action before archiving its notification." };
  for (const item of selected) {
    const id = "inbox:" + createHash("sha256").update(JSON.stringify([recipient, item.id])).digest("hex");
    let row = s.notificationStates.find((n) => n.id === id);
    if (!row) { row = { id, actor: recipient, notificationId: item.id }; s.notificationStates.push(row); }
    if (input.action === "archive") row.archivedVersion = item.version;
    else if (input.action === "restore") delete row.archivedVersion;
    else row.readVersion = item.version;
    row.updatedAt = now.toISOString();
  }
  return {};
}
function handle(req, res, s, actor, input, clock, env) {
  if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "Method not allowed." });
  if (req.method === "POST") {
    const result = apply(s, actor, input, clock());
    if (result.error) return json(res, result.status, { error: result.error });
  }
  const push = usageAlertConfig(env);
  return json(res, 200, { ...notificationInbox(s, actor, clock()), pushAvailable: push.enabled, publicKey: push.publicKey });
}
export function createAccountNotificationRoutes({ mutate, auth, clock, env }) {
  return async (req, res, url) => {
    if (url.pathname !== "/api/account/notifications") return NOT_HANDLED;
    const input = req.method === "POST" ? await body(req) : {};
    return mutate((s) => {
      const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
      if (!customer) return json(res, 401, { error: "Customer session expired." });
      if (customer.status === "suspended") return json(res, 403, { error: "This account is suspended." });
      return handle(req, res, s, { type: "customer", id: customer.id }, input, clock, env);
    }, { res });
  };
}
export function createAdminNotificationRoutes({ clock, env }) {
  return async (req, res, url, { s, i, administrator, adminUser, role }) => {
    if (url.pathname !== "/api/admin/notifications") return NOT_HANDLED;
    return handle(req, res, s, { type: "admin", id: adminUser?.id || administrator.userId || "legacy-admin", role }, i, clock, env);
  };
}
