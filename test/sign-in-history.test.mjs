import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret, totpSecret, totpCode } from "../lib/security.mjs";
import { notificationItems, deliverActivityPush } from "../lib/notifications.mjs";
import { recordCustomerSignIn, signInCookie, loginMethods } from "../lib/sign-in-history.mjs";
import { createSecurityAlertService } from "../lib/security-alerts.mjs";

async function fixture(t) { const f = await pairingFixture(); t.after(f.close); return f; }
const inbox = "/api/account/notifications?view=all&category=security";
function browserCookie(response) { return response.headers.getSetCookie().find((line) => line.startsWith(signInCookie + "=")).split(";")[0]; }
async function login(f, cookie = "", pin = "2468") {
  const response = await fetch(f.api + "/api/account/login/pin", { method: "POST", headers: { origin: "http://customer.test", "content-type": "application/json", cookie,
    "cf-connecting-ip": "203.0.113.10", "user-agent": "Synthetic Safari <img src=x>" }, body: JSON.stringify({ phone: "670050001", pin }) });
  return { status: response.status, body: await response.json(), headers: response.headers };
}

test("each actual PIN sign-in creates one scoped history item; reloads and heartbeats add none", async (t) => {
  const f = await fixture(t), result = await login(f);
  assert.equal(result.status, 200); assert.match(browserCookie(result), /^ndahi_signin_browser=[A-Za-z0-9_-]{43}$/);
  for (let n = 0; n < 3; n++) { await f.call("/api/account/dashboard"); await f.call("/api/account/security"); await f.call(inbox); }
  const items = (await f.call(inbox)).body.items.filter((n) => n.id.startsWith("sign-in:"));
  assert.equal(items.length, 1); assert.match(items[0].title, /PIN sign-in/); assert.match(items[0].body, /203\.0\.113\.10/);
  assert.match(items[0].body, /does not verify.*physical location/); assert.equal(items[0].url, "/dashboard#sessions"); assert.equal(items[0].linkLabel, "Review sessions");
  assert.equal((await f.call(inbox, undefined, { session: "other" })).body.items.length, 0);
  const s = await f.store.snapshot(); assert.equal(s.securityAlerts.length, 1);
  assert.equal(items.length, 1, "the email notice and sign-in share one centre item");
  assert.doesNotMatch(JSON.stringify((await f.call(inbox)).body), /browserHash|ndahi_signin_browser|tokenHash/);
});

test("the same server-issued browser hint makes routine sign-ins quiet without granting authentication", async (t) => {
  const f = await fixture(t), first = await login(f), recognized = browserCookie(first);
  f.advance(3); assert.equal((await login(f, recognized, "0000")).status, 401);
  assert.equal((await f.call(inbox)).body.items.length, 1, "a recognition hint cannot sign in");
  f.advance(3); assert.equal((await login(f, recognized)).status, 200);
  const items = (await f.call(inbox)).body.items;
  assert.equal(items.length, 2); assert.equal(items.filter((n) => n.pushEligible).length, 1);
  assert.equal((await f.store.snapshot()).securityAlerts.length, 1);
  f.advance(3); await login(f);
  assert.equal((await f.store.snapshot()).securityAlerts.length, 2, "a missing recognition cookie is honestly unrecognized");
});

for (const method of ["authenticator", "recovery"]) test(`retired ${method} inputs cannot create a successful sign-in history item`,async t=>{
 const f=await fixture(t),secret=totpSecret();await f.store.transaction(s=>{s.customers[0].totpSecret=secret;s.customers[0].recoveryCodes=[{id:"code",hash:hashSecret("ABCD-2345","pairing-tests")}];});
 const before=await f.store.snapshot();
 const request=await f.call("/api/account/login/request-authenticator",{phone:"670050001"});assert.equal(request.status,410);
 const input={challengeId:"old",...(method==="recovery"?{recoveryCode:"ABCD-2345"}:{otp:totpCode(secret,+f.now())})};
 assert.equal((await f.call("/api/account/login/verify-authenticator",input)).status,410);
 const after=await f.store.snapshot();assert.equal(after.securityEvents.filter(e=>e.type===loginMethods[method]).length,0);assert.deepEqual(after.customers,before.customers);assert.deepEqual(after.dashboardSessions,before.dashboardSessions);
});

test("passkey, setup and voucher account methods use stable event identities without exposing factor material", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    for (const method of ["passkey", "setup", "voucher"]) recordCustomerSignIn(s, "c1", { headers: { cookie: "", "user-agent": "Synthetic browser" }, clientIp: "203.0.113.10" }, method, f.now(), "pairing-tests");
  });
  const items = (await f.call(inbox)).body.items;
  assert.equal(items.length, 3); assert.equal(new Set(items.map((n) => n.id)).size, 3);
  assert.ok(items.some((n) => /Passkey sign-in/.test(n.title)));
  assert.doesNotMatch(JSON.stringify(items), /browserHash|publicKey|credential|pinHash|token/);
});

test("muted delivery keeps important security history and read/archive never signs a session out", async (t) => {
  const f = await fixture(t); await login(f);
  await f.call("/api/account/notifications", { action: "preferences", pushEnabled: false, emailSecurity: false });
  let items = (await f.call(inbox)).body.items; assert.equal(items.length, 1);
  const count = (await f.store.snapshot()).dashboardSessions.length;
  await f.call(inbox, { action: "read", id: items[0].id }); await f.call(inbox, { action: "archive", id: items[0].id });
  const archived = await f.call("/api/account/notifications?view=archived&category=security", undefined, { session: "secondary" });
  assert.equal(archived.body.items.length, 1); assert.equal((await f.store.snapshot()).dashboardSessions.length, count);
  const delivered = [];
  await createSecurityAlertService({ store: f.store, now: f.now, email: { sendSecurityAlert: async (...args) => delivered.push(args) } }).run();
  await deliverActivityPush({ store: f.store, now: f.now, config: { enabled: true }, send: async (...args) => delivered.push(args) });
  assert.equal(delivered.length, 0);
});

test("failed credential checks and rolled-back session commits emit no successful sign-in or cookie", async (t) => {
  const f = await fixture(t); assert.equal((await login(f, "", "0000")).status, 401); f.advance(3);
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (fn, ...args) => transaction(async (s) => {
    const value = await fn(s);
    if (s.securityEvents.some((e) => e.type === loginMethods.pin)) throw Error("synthetic sign-in rollback");
    return value;
  }, ...args);
  const result = await login(f); assert.notEqual(result.status, 200); assert.equal(result.headers.get("set-cookie"), null);
  assert.equal((await f.call(inbox)).body.items.length, 0); assert.equal((await f.store.snapshot()).securityAlerts.length, 0);
});

test("guest Wi-Fi requests create no account sign-in history or account session", async (t) => {
  const f = await fixture(t), before = (await f.store.snapshot()).dashboardSessions.length;
  assert.equal((await f.request()).status, 201);
  const s = await f.store.snapshot(); assert.equal(s.dashboardSessions.length, before);
  assert.equal(notificationItems(s, { type: "customer", id: "c1" }, f.now()).some((n) => n.id.startsWith("sign-in:")), false);
});

for (const [name, path, input, kind] of [
  ["PIN", "/api/account/security/pin", { currentPin: "2468", newPin: "1357", confirmPin: "1357" }, "pin_changed"],
  ["phone", "/api/account/profile/phone", { pin: "2468", phone: "670050099" }, "phone_changed"],
  ["email", "/api/account/profile/email/confirm", { code: "123456" }, "email_linked"],
]) test(`a verified ${name} change rotates its session without inventing an account-setup sign-in`, async (t) => {
  const f = await fixture(t);
  if (name === "email") await f.store.transaction((s) => {
    const c = s.customers[0], session = s.dashboardSessions.find((a) => a.tokenHash === hashSecret("main", "pairing-tests"));
    c.pendingEmail = { email: "updated@example.test", originalEmail: c.email || "", sessionId: session.id,
      codeHash: hashSecret(input.code, "pairing-tests"), attempts: 0, expiresAt: new Date(+f.now() + 60000).toISOString() };
  });
  const changed = await f.call(path, input);
  assert.equal(changed.status, 200); assert.equal(changed.body.authenticated, true);
  assert.ok(changed.headers.getSetCookie().some((line) => line.startsWith("customer_session=")));
  const s = await f.store.snapshot();
  assert.equal(s.securityEvents.filter((e) => Object.values(loginMethods).includes(e.type)).length, 0);
  assert.deepEqual(s.securityAlerts.map((n) => n.kind), [kind]);
  assert.equal(notificationItems(s, { type: "customer", id: "c1" }, f.now()).some((n) => n.id.startsWith("sign-in:")), false);
});

test("initial PIN creation still records one genuine account-setup sign-in", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => { delete s.customers[0].pinHash; });
  const setup = await f.call("/api/account/setup/pin", { phone: "670050001", code: "NC-AAAA-1111", pin: "2468", confirmPin: "2468" });
  assert.equal(setup.status, 200); assert.equal(setup.body.authenticated, true);
  const s = await f.store.snapshot();
  assert.equal(s.securityEvents.filter((e) => e.type === loginMethods.setup).length, 1);
  const items = notificationItems(s, { type: "customer", id: "c1" }, f.now()).filter((n) => n.id.startsWith("sign-in:"));
  assert.equal(items.length, 1); assert.match(items[0].title, /Account setup sign-in/);
});

test("retained important sign-in notices keep the same identity and read version when audit history is trimmed", async (t) => {
  const f = await fixture(t); await login(f);
  const before = (await f.call(inbox)).body.items[0];
  await f.call(inbox, { action: "read", id: before.id });
  await f.store.transaction((s) => { s.securityEvents = []; });
  const after = (await f.call(inbox)).body.items[0];
  assert.equal(after.id, before.id); assert.equal(after.version, before.version); assert.equal(after.read, true);
});
