import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";
import { notificationItems } from "../lib/notifications.mjs";
import { notificationTarget } from "../shared-app/notification-target.js";
import { setPairingReference, pairingReference, pairingReviewPath } from "../lib/pairing-reference.mjs";
const root = ownerRoot + "/request", key = "a".repeat(32);
async function fixture(t, options) { const f = await pairingFixture(options); t.after(f.close); return f; }
const input = overrides => ({ key, mac: guestMac, address: "10.20.0.30", includeQr: true, ...overrides });
const start = (f, overrides, options) => f.call(root, input(overrides), { session: "secondary", controller: "", ...options });
const confirm = (f, request, extra = {}, options) => f.call(ownerRoot + "/approve", { id: request.id, confirmMatch: true, comparisonCode: request.comparisonCode, ...extra }, options);
const status = (f, request, overrides = {}) => f.call(publicRoot + "/status", { id: request.id, key, ...overrides }, { session: "", controller: "" });

test("signed-in secondary requests derive the account/bundle without repeated details, recovery proof or new sessions", async t => {
  const f = await fixture(t), r = await start(f, { phone: "670050002", code: "NC-OTHER-ACCOUNT" });
  assert.equal(r.status, 201); assert.equal(r.body.request.protocol, 3); assert.equal(r.body.request.status, "awaiting_confirmation");
  assert.match(r.body.request.comparisonCode, /^\d{6}$/); assert.equal(r.body.approvalCode, undefined);
  assert.equal(r.body.request.reviewUrl, "http://customer.test" + pairingReviewPath(r.body.request.id));
  assert.match(r.body.request.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal(new URL(r.body.request.reviewUrl).searchParams.size, 1);
  assert.doesNotMatch(r.body.request.reviewUrl, /key=|phone=|voucher|pin=|controller/);
  assert.equal(r.headers.has("set-cookie"), false);
  const s = await f.store.snapshot(); assert.equal(s.dashboardSessions.length, 3);
  assert.equal(s.wifiPairingRequests[0].customerId, "c1"); assert.equal(s.wifiPairingRequests[0].voucherId, "v1");
  assert.equal(s.routerCommands.some(c => c.action === "connect_wifi_device"), false); assert.equal(f.calls.length, 0);
  assert.doesNotMatch(JSON.stringify(r.body), /referenceNonce|referenceHash|keyHash|pinHash|controllerHash|NC-AAAA/);
});

test("production authenticated starts enforce session, CSRF, coverage and canonical suspension", async t => {
  const f = await fixture(t);
  assert.equal((await start(f, {}, { session: "" })).status, 401);
  assert.equal((await start(f, {}, { csrf: "bad" })).status, 403);
  assert.equal((await start(f, {}, { address: "198.51.100.9" })).status, 403);
  const foreign = await fetch(f.api + root, { method: "POST", headers: { origin: "https://evil.test", "content-type": "application/json" }, body: JSON.stringify(input()) });
  assert.equal(foreign.status, 403);
  await f.store.transaction(s => { s.customers[0].suspended = true; });
  assert.equal((await start(f)).status, 403); assert.equal((await f.request({ protocol: 3 })).status, 401);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
});

test("signed-in request starts share the existing pairing edge budget", async t => {
  const f = await fixture(t, { env: { AUTH_EDGE_PAIRING_MAX: "1" } });
  assert.equal((await start(f)).status, 201);
  assert.equal((await start(f, { key: "b".repeat(32) })).status, 429);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 1);
});

test("restricted captive requests show the same reference without creating an account session or exposing requester credentials", async t => {
  const f = await fixture(t), r = await f.request({ protocol: 3, includeQr: true });
  assert.equal(r.status, 201); assert.equal(r.body.request.status, "awaiting_confirmation"); assert.equal(r.headers.has("set-cookie"), false);
  const main = await f.call(ownerRoot + "?request=" + r.body.request.id);
  assert.equal(main.status, 200); assert.equal(main.body.requests[0].comparisonCode, r.body.request.comparisonCode);
  assert.equal(main.body.requests[0].approvalCode, undefined); assert.equal(main.body.requests[0].qrDataUrl, undefined);
  assert.equal((await f.call(ownerRoot, undefined, { session: "", controller: "" })).status, 401);
  assert.equal((await f.call(ownerRoot + "?request=" + r.body.request.id, undefined, { session: "other", controller: "" })).status, 404);
  assert.equal((await status(f, r.body.request, { key: "b".repeat(32) })).status, 404);
  assert.equal((await f.call("/api/account/dashboard", undefined, { session: "", controller: "" })).status, 401);
});

test("opening a QR locator or seeing the reference never approves; only the current main controller can explicitly confirm", async t => {
  const f = await fixture(t), r = (await start(f)).body.request;
  await f.call(ownerRoot + "?request=" + r.id);
  assert.equal((await f.call(ownerRoot + "/approve", { id: r.id })).status, 400);
  assert.equal((await confirm(f, r, { confirmMatch: false })).status, 400);
  assert.equal((await confirm(f, r, { confirmMatch: "true" })).status, 400);
  assert.equal((await confirm(f, r, { comparisonCode: r.comparisonCode === "000000" ? "111111" : "000000" })).status, 400);
  assert.equal((await confirm(f, r, {}, { session: "secondary", controller: "" })).status, 403);
  assert.equal((await confirm(f, r, {}, { session: "other", controller: "" })).status, 403);
  assert.equal((await confirm(f, r, {}, { csrf: "bad" })).status, 403);
  assert.equal((await f.store.snapshot()).routerCommands.filter(c => c.action === "connect_wifi_device").length, 0);
  assert.equal(f.calls.length, 0);
});

test("matching references cannot redeem legacy endpoints; explicit main confirmation queues exactly once and waits for the router", async t => {
  const f = await fixture(t), r = (await start(f)).body.request;
  const redeem = () => f.call(publicRoot + "/redeem", { id: r.id, key, approvalCode: r.comparisonCode }, { session: "", controller: "" });
  assert.equal((await redeem()).status, 409);
  const approved = await confirm(f, r); assert.equal(approved.status, 202); assert.equal(approved.body.request.status, "connecting"); assert.equal(f.calls.length, 0);
  assert.equal((await redeem()).status, 409);
  assert.equal((await confirm(f, r)).status, 200);
  assert.equal((await f.store.snapshot()).routerCommands.filter(c => c.action === "connect_wifi_device").length, 1);
  await f.process(); const ready = await status(f, r);
  assert.equal(ready.body.request.status, "connected"); assert.equal(ready.body.request.completionReady, true);
  assert.equal(ready.body.request.comparisonCode, undefined); assert.equal(ready.body.request.reviewUrl, undefined);
  await f.process(); assert.equal(f.calls.length, 1);
});

test("lost start replies and status reloads reuse one request, with QR rendering only when requested", async t => {
  const f = await fixture(t), a = await start(f), b = await start(f);
  assert.equal(b.status, 200); assert.equal(b.body.request.id, a.body.request.id);
  assert.equal(b.body.request.comparisonCode, a.body.request.comparisonCode);
  let r = await status(f, a.body.request); assert.equal(r.body.request.qrDataUrl, undefined);
  f.advance(2); r = await status(f, a.body.request, { includeQr: true });
  assert.match(r.body.request.qrDataUrl, /^data:image\/png;base64,/);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 1);
});

for (const terminal of ["expired", "declined", "cancelled"]) test(terminal + " matching requests cannot be confirmed or replayed", async t => {
  const f = await fixture(t), r = (await start(f)).body.request;
  if (terminal === "expired") f.advance(300);
  else if (terminal === "declined") await f.call(ownerRoot + "/decline", { id: r.id });
  else await f.call(publicRoot + "/cancel", { id: r.id, key });
  const state = await status(f, r); assert.equal(state.body.request.status, terminal);
  assert.equal(state.body.request.comparisonCode, undefined);
  assert.equal((await confirm(f, r)).status, 409);
  assert.equal((await start(f)).body.code, "PAIRING_RESTART_REQUIRED"); assert.equal(f.calls.length, 0);
});

test("simultaneous matching approvals cannot consume the last device slot twice", async t => {
  const f = await fixture(t), a = (await start(f)).body.request,
    b = (await start(f, { key: "b".repeat(32), mac: "AA:BB:CC:DD:EE:04", address: "10.20.0.40" })).body.request;
  const replies = await Promise.all([confirm(f, a), confirm(f, b)]);
  assert.deepEqual(replies.map(r => r.status).sort(), [202, 409]);
  assert.equal((await f.store.snapshot()).routerCommands.filter(c => c.action === "connect_wifi_device").length, 1);
});

test("stale reads preserve the pending reference and controller until a fresh observation permits admission", async t => {
  const f = await fixture(t), r = (await start(f)).body.request, prior = (await f.store.snapshot()).customers[0].wifiMainDevice;
  f.advance(121); const result = await confirm(f, r);
  assert.equal(result.status, 409); assert.equal(result.body.code, "DEVICE_REFRESH_REQUIRED");
  const s = await f.store.snapshot(); assert.equal(s.wifiPairingRequests[0].status, "awaiting_confirmation");
  assert.equal(s.wifiPairingRequests[0].approvedBy, undefined); assert.deepEqual(s.customers[0].wifiMainDevice, prior);
});

test("a failed commit cannot report approval success or leave an admitted command", async t => {
  const f = await fixture(t), r = (await start(f)).body.request, transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (fn, options) => transaction(async s => { const result = await fn(s); if (s.wifiPairingRequests.some(p => p.status === "connecting")) throw Error("Synthetic matching approval rollback"); return result; }, options);
  assert.ok((await confirm(f, r)).status >= 400);
  let s = await f.store.snapshot(); assert.equal(s.wifiPairingRequests[0].status, "awaiting_confirmation"); assert.equal(s.routerCommands.filter(c => c.action === "connect_wifi_device").length, 0);
  f.store.transaction = transaction; assert.equal((await confirm(f, r)).status, 202);
});

test("replacing the controller invalidates an earlier matching request, while initial main setup permits a waiting request", async t => {
  const f = await fixture(t), r = (await start(f)).body.request;
  await f.store.transaction(s => { s.customers[0].wifiMainDevice.controllerHash = hashSecret("replacement", "pairing-tests"); });
  assert.equal((await confirm(f, r, {}, { controller: "replacement" })).status, 409);
  const g = await fixture(t); let main;
  await g.store.transaction(s => { main = s.customers[0].wifiMainDevice; delete s.customers[0].wifiMainDevice; });
  const waiting = (await start(g)).body.request; assert.equal(waiting.mainRequired, true); assert.equal((await confirm(g, waiting)).status, 403);
  await g.store.transaction(s => { s.customers[0].wifiMainDevice = main; });
  assert.equal((await confirm(g, waiting)).status, 202);
});

test("queued matching authorization is rechecked against main, router, suspension and bundle validity", async t => {
  for (const change of [s => { s.customers[0].wifiMainDevice.controllerHash = "other"; }, s => { s.customers[0].suspended = true; }, s => { s.vouchers[0].usedBytes = 1e9; }, s => { s.networkSetup.connections.router.revision = "changed"; }]) {
    const f = await fixture(t), r = (await start(f)).body.request;
    assert.equal((await confirm(f, r)).status, 202); await f.store.transaction(change); await f.process();
    assert.equal(f.calls.length, 0); assert.equal((await status(f, r)).body.request.status, "failed");
  }
});

test("approved devices reconnect with the current session without a fresh matching confirmation", async t => {
  const f = await fixture(t), r = (await start(f)).body.request; await confirm(f, r); await f.process();
  await f.store.transaction(s => { s.vouchers[0].wifiDevices = s.vouchers[0].wifiDevices.filter(d => d.mac !== guestMac); });
  const again = await start(f, { key: "b".repeat(32) }); assert.equal(again.status, 202); assert.equal(again.body.request.status, "connecting");
  assert.equal(again.body.request.comparisonCode, undefined);
});

test("matching reference survives supported secret rotation without ever becoming an approval credential", () => {
  const p = { id: "11111111-2222-4333-8444-555555555555", protocol: 3, status: "awaiting_confirmation" };
  setPairingReference(p, "fixture-nonce", "old-secret");
  assert.equal(pairingReference(p, "new-secret", "old-secret"), pairingReference(p, "old-secret"));
  assert.equal(pairingReference(p, "new-secret"), null); p.status = "pending"; assert.equal(pairingReference(p, "old-secret"), null);
});

test("notification/QR navigation targets the exact pending request and never contains a credential", async t => {
  const f = await fixture(t), r = (await start(f)).body.request, s = await f.store.snapshot();
  const notice = notificationItems(s, { type: "customer", id: "c1" }, f.now()).find(n => n.requestId === r.id);
  assert.equal(notice.url, pairingReviewPath(r.id)); assert.equal(notificationTarget(notice.url), notice.url);
  assert.equal(notice.actionRequired, true); assert.doesNotMatch(JSON.stringify(notice), new RegExp(r.comparisonCode));
  for (const url of [notice.url + "&key=secret", notice.url + "#approval=123456", "https://evil.test" + notice.url, "/pair-review.html?request=bad"]) assert.equal(notificationTarget(url), null);
});

test("a committed start whose reply was lost can be resumed by its requesting bearer without re-entering details", async t => {
  const f = await fixture(t), r = (await start(f)).body.request;
  const resumed = await f.call(publicRoot + "/status", { key, includeQr: true }, { session: "", controller: "" });
  assert.equal(resumed.status, 200); assert.equal(resumed.body.request.id, r.id);
  assert.equal(resumed.body.request.comparisonCode, r.comparisonCode);
  assert.equal(resumed.headers.has("set-cookie"), false);
});

test("pausing new approvals cancels unconfirmed matching references without restoring public access", async t => {
  const f = await fixture(t), r = (await start(f)).body.request;
  await f.store.transaction(s => { s.networkSetup.assistedConnections.enabled = false; });
  const ended = await status(f, r); assert.equal(ended.body.request.status, "cancelled");
  assert.equal(ended.body.request.comparisonCode, undefined);
  assert.equal((await confirm(f, r)).status, 409); assert.equal(f.calls.length, 0);
});
