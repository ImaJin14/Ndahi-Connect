// Server task 6 for the redesign's AdminCustomers bulk actions (#257): one
// audited, idempotent request gives a gift voucher (saved in each account, with
// fresh administrator proof) or sends a message (in-app and email).
import test from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { notificationItems } from "../lib/notifications.mjs";
import { redeemVoucher } from "../lib/domain/vouchers.mjs";
import { createNotificationEmailSender } from "../lib/notification-email.mjs";

const secret = "bulk-customer-actions", pin = "482913", key = (n) => `bulk-request-${n}-0123456789`;

async function fixture(t) {
  const store = createStore({ persistent: false }), passwordHash = await argon2.hash(pin);
  await store.transaction((s) => {
    s.customers.push({ id: "c1", name: "Amina", phone: "670001245", email: "amina@example.test", emailVerifiedAt: "2026-01-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c2", name: "Fon", phone: "670004019", createdAt: "2026-01-01T00:00:00.000Z" },
      { id: "c3", name: "Nji", phone: "670005920", status: "suspended", createdAt: "2026-01-01T00:00:00.000Z" });
    for (const role of ["owner", "operator", "auditor", "reseller"]) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, role, active: true, passwordHash, passkeys: [] });
      s.adminSessions.push({ userId: `staff-${role}`, role, tokenHash: hashSecret(`token-${role}`, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", PAYMENT_MODE: "mock",
    BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const bulk = async (role, body) => {
    const r = await fetch(base + "/api/admin/customers/bulk", { method: "POST", body: JSON.stringify(body),
      headers: { "content-type": "application/json", origin: "http://admin.test", cookie: `admin_session=token-${role}`, "x-csrf-token": `csrf-${role}` } });
    return { status: r.status, body: await r.json() };
  };
  return { store, bulk };
}

test("a message reaches each active customer once, in the app and by email", async (t) => {
  const f = await fixture(t), request = { action: "message", customerIds: ["c1", "c2", "c3", "missing", "c1"], message: "  We miss you!\r\nWeekly is back on sale.  ", requestKey: key(1) };
  const sent = await f.bulk("operator", request);
  assert.equal(sent.status, 200);
  assert.equal(sent.body.done, 2);
  assert.deepEqual(sent.body.skipped.map((x) => [x.customerId, x.reason]).sort(), [["c3", "suspended"], ["missing", "not_found"]]);
  const again = await f.bulk("operator", request);
  assert.equal(again.body.idempotent, true, "the same request key never sends twice");
  const s = await f.store.snapshot();
  assert.equal(s.customerMessages.length, 2);
  assert.equal(s.customerMessages[0].body, "We miss you!\nWeekly is back on sale.");
  assert.equal(s.auditLogs.filter((a) => a.action === "customer.bulk_message").length, 1);
  const item = notificationItems(s, { type: "customer", id: "c1" }).find((n) => n.id.startsWith("message:"));
  assert.deepEqual([item.category, item.title, item.body], ["service", "Message from NDAHI", "We miss you!\nWeekly is back on sale."]);
  // Email for the verified address, as an account message.
  const mails = [], sender = createNotificationEmailSender({ store: f.store, config: { enabled: false },
    email: { configured: () => true, sendAccountMessage: async (message) => { mails.push(message); return { messageId: "m" }; } } });
  await sender();
  assert.deepEqual(mails.map((m) => [m.to, m.subject, m.lines]), [["amina@example.test", "A message from NDAHI Connect", ["We miss you!\nWeekly is back on sale."]]]);
  // Invalid requests change nothing.
  for (const bad of [{ ...request, message: "" }, { ...request, message: "x".repeat(501) }, { ...request, customerIds: [] }, { ...request, requestKey: "short" }, { ...request, action: "delete" }])
    assert.equal((await f.bulk("owner", { ...bad, requestKey: bad.requestKey === "short" ? "short" : key(9) })).status, 400, JSON.stringify(bad).slice(0, 60));
});

test("a gift needs fresh proof and is saved in each account until the customer starts it", async (t) => {
  const f = await fixture(t), request = { action: "gift", customerIds: ["c1", "c2", "c3"], planId: "weekly", requestKey: key(2) };
  const unproved = await f.bulk("owner", request);
  assert.deepEqual([unproved.status, unproved.body.code], [400, "VERIFICATION_FAILED"]);
  assert.equal((await f.bulk("owner", { ...request, currentPassword: "000000" })).body.code, "VERIFICATION_FAILED");
  const given = await f.bulk("owner", { ...request, currentPassword: pin });
  assert.equal(given.status, 200);
  assert.deepEqual([given.body.done, given.body.skipped.map((x) => x.reason)], [2, ["suspended"]]);
  let s = await f.store.snapshot();
  const gifts = s.vouchers.filter((v) => v.giftBatchId === given.body.batchId);
  assert.equal(gifts.length, 2);
  assert.ok(gifts.every((v) => v.status === "available" && v.saleType === "gift" && v.saleAmount === 0 && v.code && !v.activatedAt), "saved, not started, no revenue");
  assert.ok(notificationItems(s, { type: "customer", id: "c1" }).some((n) => n.id === `gift:${gifts.find((v) => v.customerId === "c1").id}`));
  assert.equal(s.auditLogs.find((a) => a.action === "customer.bulk_gift").meta.count, 2);
  // The customer starts it with its code, like any voucher.
  await f.store.transaction((state) => {
    const v = state.vouchers.find((v) => v.customerId === "c2" && v.giftBatchId === given.body.batchId);
    const result = redeemVoucher(state, { phone: "670004019", code: v.code }, { clock: () => new Date(), requester: { ip: "127.0.0.1" } });
    assert.ok(!result || result.status === undefined || result.status < 400, JSON.stringify(result));
  });
  s = await f.store.snapshot();
  assert.equal(s.vouchers.find((v) => v.customerId === "c2" && v.giftBatchId === given.body.batchId).status, "active");
});

test("only owners and operators act on many customers", async (t) => {
  const f = await fixture(t);
  for (const role of ["auditor", "reseller"])
    assert.equal((await f.bulk(role, { action: "message", customerIds: ["c1"], message: "Hi", requestKey: key(3) })).status, 403, role);
  assert.equal((await f.bulk("operator", { action: "message", customerIds: ["c1"], message: "Hi", requestKey: key(4) })).status, 200);
});
