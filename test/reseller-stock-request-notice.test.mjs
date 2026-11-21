import test from "node:test";
import assert from "node:assert/strict";
import { notificationItems } from "../lib/notifications.mjs";

// #261: "Ask for more codes" on the reseller's phone home reaches the owner as
// a notification that opens Resellers. Only the owner sees it.
test("a reseller's request for more codes notifies the owner only", () => {
  const s = { payments: [], auditLogs: [], securityEvents: [], routerCommands: [], notificationStates: [], adminUsers: [
    { id: "owner", role: "owner", active: true },
    { id: "operator", role: "operator", active: true },
    { id: "auditor", role: "auditor", active: true },
    { id: "r-kiosk", role: "reseller", active: true, username: "brenda", displayName: "Market kiosk",
      stockRequests: [{ id: "stock-1", operationKey: "k".repeat(32), createdAt: "2026-11-20T08:00:00.000Z" }] },
    { id: "r-plain", role: "reseller", active: true, username: "joel", stockRequests: [{ id: "stock-2", operationKey: "j".repeat(32), createdAt: "2026-11-19T08:00:00.000Z" }] },
  ] };
  const owner = notificationItems(s, { type: "admin", id: "owner" }, new Date("2026-11-20T09:00:00Z")).filter((n) => n.id.startsWith("stock-request:"));
  assert.deepEqual(owner.map((n) => [n.id, n.title, n.url, n.category, n.actionRequired]), [
    ["stock-request:stock-1", "Market kiosk asked for more codes", "/dashboard#resellers", "payments", false],
    ["stock-request:stock-2", "joel asked for more codes", "/dashboard#resellers", "payments", false],
  ]);
  for (const id of ["operator", "auditor", "r-kiosk"])
    assert.equal(notificationItems(s, { type: "admin", id }, new Date("2026-11-20T09:00:00Z")).some((n) => n.id.startsWith("stock-request:")), false, id);
  // Muting payments hides it, like the other sales notices.
  s.notificationStates.push({ id: "preferences:admin:owner", actor: "admin:owner", categories: { payments: false } });
  assert.equal(notificationItems(s, { type: "admin", id: "owner" }).some((n) => n.id.startsWith("stock-request:")), false);
});
