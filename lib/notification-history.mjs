import { createHash } from "node:crypto";

export const notificationCategoryLabels = {
  customer: { devices: "Devices / access", security: "Security / sign-ins", usage: "Data / bundles", payments: "Payments / refunds", service: "Service" },
  admin: { network: "Network / router", payments: "Payments / refunds", security: "Staff / security", recovery: "Support / recovery", service: "Service" },
};
export function categoriesFor(actor) {
  if (actor.type !== "admin") return notificationCategoryLabels.customer;
  return Object.fromEntries(Object.entries(notificationCategoryLabels.admin).filter(([key]) => key === "service" ||
    ["owner", "operator"].includes(actor.role) && ["network", "payments"].includes(key) || actor.role === "owner"));
}
export const compareNotifications = (a, b) => Number(b.actionRequired) - Number(a.actionRequired) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || a.id.localeCompare(b.id);
const validDate = (value) => !value || /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + "T00:00:00Z")) && new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;
export function notificationFilters(query, actor) {
  const get = (key, fallback) => query?.get(key) || fallback;
  const filters = { view: get("view", "all"), category: get("category", "all"), from: get("from", ""), to: get("to", ""), limit: Number(get("limit", 25)), cursor: get("cursor", ""), includeArchived: !query?.has("view") };
  if (!["all", "unread", "action", "archived"].includes(filters.view) || filters.category !== "all" && !Object.hasOwn(categoriesFor(actor), filters.category) ||
    !validDate(filters.from) || !validDate(filters.to) || filters.from && filters.to && filters.from > filters.to || !Number.isInteger(filters.limit) || filters.limit < 1 || filters.limit > 100 || filters.cursor.length > 1024) throw Error("Choose valid notification filters and a page size from 1 to 100.");
  return filters;
}
export function matchingNotifications(items, filters) {
  return items.filter((n) => (filters.category === "all" || n.category === filters.category) &&
    (filters.view === "archived" ? n.archived : (filters.includeArchived || !n.archived) && (filters.view === "unread" ? !n.read : filters.view === "action" ? n.actionRequired : true)) &&
    (!filters.from || n.updatedAt.slice(0, 10) >= filters.from) && (!filters.to || n.updatedAt.slice(0, 10) <= filters.to));
}
export function notificationPage(items, filters, recipient) {
  const matching = matchingNotifications(items, filters), fingerprint = createHash("sha256").update(JSON.stringify([recipient, filters.view, filters.category, filters.from, filters.to, filters.limit, filters.includeArchived])).digest("hex");
  let after;
  if (filters.cursor) {
    try { after = JSON.parse(Buffer.from(filters.cursor, "base64url").toString()); } catch { /* Reject malformed cursors below. */ }
    if (!after || after.fingerprint !== fingerprint || typeof after.id !== "string" || after.id.length > 200 || typeof after.actionRequired !== "boolean" || !Number.isFinite(Date.parse(after.updatedAt))) throw Error("This notification page does not match the selected filters. Return to the first page.");
  }
  const rows = after ? matching.filter((n) => compareNotifications(n, after) > 0) : matching;
  const page = rows.slice(0, filters.limit), last = page.at(-1);
  return { items: page, page: { total: matching.length, limit: filters.limit, nextCursor: rows.length > page.length ? Buffer.from(JSON.stringify({ fingerprint, id: last.id, updatedAt: last.updatedAt, actionRequired: last.actionRequired })).toString("base64url") : null } };
}
