import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand, scheduleRouterCommandReplay } from "../lib/router-queue.mjs";
import { notificationItems, deliverActivityPush } from "../lib/notifications.mjs";
import { recordOperationalFailure, updateOperationalIncident } from "../lib/operational-incidents.mjs";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";

async function fixture() {
  const store = createStore({ persistent: false }); let at = new Date("2030-01-01T12:00:00Z"), fail = true;
  await store.transaction((s) => { s.customers.push({ id: "c", pushSubscriptions: [] }); s.vouchers.push({ id: "v", customerId: "c", status: "active", quotaBytes: 1e9, usedBytes: 0 }); });
  const now = () => at, processor = createRouterCommandProcessor({ store, now, maxAttempts: 2, router: { readUsage: async () => { if (fail) throw Error("Router timeout with SECRET PIN voucher code"); return []; } } });
  const enqueue = () => store.transaction((s) => enqueueRouterCommand(s, { action: "sync_usage" }, now));
  return { store, now, processor, enqueue, advance(ms) { at = new Date(+at + ms); }, recover() { fail = false; }, fail() { fail = true; } };
}
const actor = { type: "admin", id: "owner", role: "owner" };

test("retries group one incident with first/latest/count while polling does not create another unread version", async () => {
  const f = await fixture(); await f.enqueue(); await f.processor.process();
  let s = await f.store.snapshot(), incident = s.operationalIncidents[0], item = notificationItems(s, actor, f.now())[0];
  assert.equal(incident.count, 1); assert.equal(item.actionRequired, false); assert.doesNotMatch(JSON.stringify(item), /SECRET|PIN|voucher code/);
  const version = item.version;
  f.advance(30001); await f.processor.process();
  s = await f.store.snapshot(); assert.equal(s.operationalIncidents.length, 1); assert.equal(s.operationalIncidents[0].count, 2);
  assert.equal(s.operationalIncidents[0].firstAt, incident.firstAt); assert.notEqual(s.operationalIncidents[0].lastAt, incident.lastAt);
  item = notificationItems(s, actor, f.now())[0]; assert.equal(item.actionRequired, true); assert.notEqual(item.version, version, "dead-letter escalation is a new state");
  const escalated = item.version; f.advance(60000);
  assert.equal(notificationItems(s, actor, f.now())[0].version, escalated);
  await f.enqueue(); await f.processor.process();
  item = notificationItems(await f.store.snapshot(), actor, f.now())[0];
  assert.equal(item.actionRequired, true, "automatic requeue does not silently acknowledge an escalated incident");
  assert.equal(item.version, escalated, "another automatic attempt does not emit a fresh push version");
});

test("manual replay shows recovering and confirmed completion resolves, then a new failure opens a separate incident", async () => {
  const f = await fixture(); await f.enqueue(); await f.processor.process(); f.advance(30001); await f.processor.process();
  const id = (await f.store.snapshot()).operationalIncidents[0].id;
  await f.store.transaction((s) => { assert.equal(scheduleRouterCommandReplay(s, "router:sync_usage:global", f.now).status, 202); });
  assert.equal((await f.store.snapshot()).operationalIncidents[0].status, "recovering");
  f.recover(); await f.processor.process();
  let s = await f.store.snapshot(); assert.equal(s.operationalIncidents[0].status, "resolved"); assert.equal(s.operationalIncidents[0].resolution, "confirmed");
  f.fail(); f.advance(1000); await f.enqueue(); await f.processor.process();
  s = await f.store.snapshot(); assert.equal(s.operationalIncidents.length, 2); assert.notEqual(s.operationalIncidents[1].id, id);
  assert.equal(s.operationalIncidents[0].completedCommands[0].status, "processed", "closed history is frozen when a command ID is reused");
});

test("one successful command does not hide another failed command in the same group", async () => {
  const f = await fixture();
  await f.store.transaction((s) => {
    for (const id of ["a", "b"]) { const c = { id, action: "sync_voucher", targetId: "v", status: "dead_letter", totalAttempts: 1, lastAttemptAt: f.now().toISOString(), lastError: "timeout" }; s.routerCommands.push(c); recordOperationalFailure(s, c, f.now); }
    assert.equal(s.operationalIncidents.length, 1);
    s.routerCommands[0].status = "processed"; updateOperationalIncident(s, s.routerCommands[0], f.now);
  });
  const incident = (await f.store.snapshot()).operationalIncidents[0]; assert.equal(incident.count, 2); assert.equal(incident.status, "open"); assert.equal(incident.actionRequired, true);
});

test("failure classification changes preserve both unresolved problems until actual success", async () => {
  const f = await fixture();
  await f.store.transaction((s) => {
    const c = { id: "a", action: "sync_voucher", targetId: "v", status: "retry", totalAttempts: 1, lastAttemptAt: f.now().toISOString(), lastError: "timeout" }; s.routerCommands.push(c); recordOperationalFailure(s, c, f.now);
    c.totalAttempts++; c.lastError = "permission denied"; recordOperationalFailure(s, c, f.now);
    assert.equal(s.operationalIncidents.length, 2);
    c.status = "processed"; updateOperationalIncident(s, c, f.now);
  });
  assert.equal((await f.store.snapshot()).operationalIncidents.every((n) => n.status === "resolved"), true);
});

test("concurrent workers and duplicate failure recording count only actual attempts", async () => {
  const f = await fixture(); await f.enqueue();
  await Promise.all([f.processor.process(), f.processor.process()]);
  await f.store.transaction((s) => { recordOperationalFailure(s, s.routerCommands[0], f.now); recordOperationalFailure(s, s.routerCommands[0], f.now); });
  assert.equal((await f.store.snapshot()).operationalIncidents[0].count, 1);
});

test("customer incident impact is scoped, staff roles are respected and raw errors never enter summaries", async () => {
  const f = await fixture();
  await f.store.transaction((s) => {
    s.customers.push({ id: "other" });
    const c = { id: "private", action: "sync_voucher", targetId: "v", status: "dead_letter", lastError: "PIN secret NC-AAAA-1111 654321", lastAttemptAt: f.now().toISOString() }; s.routerCommands.push(c); recordOperationalFailure(s, c, f.now);
  });
  const s = await f.store.snapshot();
  assert.equal(notificationItems(s, { type: "customer", id: "c" }, f.now()).length, 1);
  assert.equal(notificationItems(s, { type: "customer", id: "other" }, f.now()).length, 0);
  assert.equal(notificationItems(s, { type: "admin", id: "auditor", role: "auditor" }, f.now()).length, 0);
  assert.doesNotMatch(JSON.stringify(notificationItems(s, actor, f.now())), /PIN|NC-AAAA|654321/);
});

test("business/incident rollback emits no history and a successful routine poll creates no incident", async () => {
  const f = await fixture();
  await assert.rejects(f.store.transaction((s) => { const c = { id: "rollback", action: "sync_usage", targetId: "global", status: "retry" }; s.routerCommands.push(c); recordOperationalFailure(s, c, f.now); throw Error("rollback"); }));
  assert.equal((await f.store.snapshot()).operationalIncidents.length, 0);
  f.recover(); await f.enqueue(); await f.processor.process(); assert.equal((await f.store.snapshot()).operationalIncidents.length, 0);
});

test("occurrence count changes alone do not repeat pushes or reset read state", async () => {
  const f = await fixture();
  await f.store.transaction((s) => { s.adminUsers.push({ id: "owner", role: "owner", active: true }); s.notificationStates.push({ id: "preferences:admin:owner", actor: "admin:owner", pushEnabled: true, pushSince: new Date(+f.now() - 1).toISOString(), subscriptions: [{ endpoint: "https://fcm.googleapis.com/fake", keys: { auth: "test", p256dh: "test" } }] }); });
  await f.enqueue(); await f.processor.process();
  const sent = [], config = { enabled: true, subject: "mailto:fixture@example.test", publicKey: "test", privateKey: "test" }, send = async (...args) => sent.push(args);
  await deliverActivityPush({ store: f.store, now: f.now, config, send });
  await f.store.transaction((s) => { const c = s.routerCommands[0]; c.totalAttempts++; c.lastAttemptAt = f.now().toISOString(); recordOperationalFailure(s, c, f.now); });
  await deliverActivityPush({ store: f.store, now: f.now, config, send });
  assert.equal(sent.length, 1); assert.doesNotMatch(JSON.stringify(sent), /SECRET|voucher code/);
});

test("incident detail access is owner/operator-only and returns scoped safe command history", async (t) => {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: "http://customer.test" } }); t.after(f.close);
  await f.store.transaction((s) => {
    for (const role of ["owner", "operator", "auditor", "reseller"]) { s.adminUsers.push({ id: role, role, active: true }); s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, "pairing-tests"), csrfToken: "csrf", expiresAt: new Date(+f.now() + 3600000).toISOString() }); }
    const c = { id: "a", kind: "router_command", action: "sync_voucher", targetId: "v1", status: "dead_letter", lastError: "credential-secret", lastAttemptAt: f.now().toISOString() }; s.routerCommands.push(c); recordOperationalFailure(s, c, f.now);
  });
  const id = (await f.store.snapshot()).operationalIncidents[0].id;
  for (const role of ["owner", "operator", "auditor", "reseller"]) {
    const r = await fetch(f.api + "/api/admin/network/incidents/" + id, { headers: { origin: "http://customer.test", cookie: "admin_session=" + role } });
    const body = await r.json(); assert.equal(r.status, ["owner", "operator"].includes(role) ? 200 : 403);
    assert.doesNotMatch(JSON.stringify(body), /credential-secret|NC-AAAA|customerIds|failures/);
    if (r.ok) { assert.equal(body.commands.length, 1); assert.equal(body.commands[0].canReplay, true); }
  }
});
