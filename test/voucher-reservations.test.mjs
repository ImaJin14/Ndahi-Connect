// Vouchers reserved for a phone number (#254, server task 3): staff reserve a
// voucher for a number with no account; that number claims it with the code
// (no SMS), creates a PIN or signs in, and starts it later. Wrong numbers are
// counted and limited, every other code path refuses it, staff can change the
// number or revoke it, and a Mobile Money payment from the number claims it.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { giftView, maskPhone, reservationState } from "../lib/reservations.mjs";
import { voucherQrUrl } from "../lib/voucher-qr.mjs";

const secret = "voucher-reservations-secret";
const env = { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret, SESSION_COOKIE_SECURE: "false",
  CUSTOMER_APP_URL: "https://portal.example.test", ADMIN_APP_URL: "http://admin.test", ALLOWED_ADMIN_ORIGINS: "http://admin.test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock",
  MIKROTIK_MODE: "mock", OMADA_MODE: "mock", BILLING_WORKER_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false", LOG_LEVEL: "silent" };

async function start(t, seed = () => {}) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    for (const role of ["owner", "reseller"]) {
      s.adminUsers.push({ id: `staff-${role}`, username: role, displayName: role, role, active: true, passkeys: [] });
      s.adminSessions.push({ userId: `staff-${role}`, role, tokenHash: hashSecret(`token-${role}`, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00.000Z" });
    }
    seed(s);
  });
  const server = createServer({ store, validateConfig: false, env });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  let ipCount = 0;
  const post = async (path, input, { role, ip, cookie } = {}) => {
    const headers = { "content-type": "application/json", "cf-connecting-ip": ip || `198.51.100.${++ipCount % 250}`,
      ...(role ? { cookie: `admin_session=token-${role}`, origin: "http://admin.test", "x-csrf-token": `csrf-${role}` } : { origin: "https://portal.example.test" }),
      ...(cookie ? { cookie } : {}) };
    const r = await fetch(base + path, { method: "POST", headers, body: JSON.stringify(input) });
    return { status: r.status, body: await r.json().catch(() => ({})), cookie: r.headers.get("set-cookie") };
  };
  const reserve = async (reservedPhone, extra = {}) => post("/api/admin/vouchers/generate", { planId: "weekly", saleType: "gift", reservedPhone, ...extra }, { role: "owner" });
  const voucher = async (id) => (await store.snapshot()).vouchers.find((v) => v.id === id);
  return { store, post, reserve, voucher };
}

test("staff reserve a voucher for a number with no account, and only that number claims it", async (t) => {
  const { store, post, reserve, voucher } = await start(t, (s) => s.customers.push({ id: "c-known", phone: "670001111", name: "Known" }));
  assert.equal((await reserve("670001111")).body.code, "ACCOUNT_EXISTS", "a number with an account gets the voucher on that account instead");
  assert.equal((await post("/api/admin/vouchers/generate", { planId: "weekly", saleType: "sold", reservedPhone: "670009910" }, { role: "reseller" })).status, 403);
  const made = await reserve("+237 670 00 99 10");
  assert.equal(made.status, 201);
  const id = made.body.voucher.id, code = made.body.voucher.code;
  assert.deepEqual([made.body.voucher.status, made.body.voucher.reservation.status, made.body.voucher.reservation.phone, made.body.voucher.reservation.wrongAttempts], ["available", "waiting", "670009910", 0]);
  const v = await voucher(id);
  assert.equal(v.customerId, null);
  assert.equal(Math.round((Date.parse(v.reservation.expiresAt) - Date.parse(v.createdAt)) / 864e5), 90, "unclaimed, it expires after 90 days");
  assert.equal((await store.snapshot()).auditLogs.find((a) => a.action === "voucher.generated").meta.reservedFor, "6•• •• 99 10");
  assert.equal(made.body.voucher.qrConnection, false);
  assert.match(made.body.voucher.qrCode, /^data:image\/png;base64,/);
  assert.equal(voucherQrUrl(v, null, "https://portal.example.test"), `https://portal.example.test/login?claim=${code}`, "the slip's QR opens the claim");

  // Every code path refuses another number, and counts it against the voucher.
  assert.equal((await post("/api/account/claim/check", { phone: "670005555", code })).body.code, "CLAIM_MISMATCH");
  assert.equal((await post("/api/account/access/begin", { phone: "670005555", code })).status, 401);
  assert.equal((await post("/api/vouchers/redeem", { phone: "670005555", code, deviceId: "d1" })).status, 401);
  assert.equal((await voucher(id)).reservation.wrongAttempts, 3);
  assert.equal((await voucher(id)).status, "available", "nothing took it");

  // The right number: the gift, a new account with a PIN, saved not started.
  const check = await post("/api/account/claim/check", { phone: "670009910", code: code.toLowerCase() });
  assert.equal(check.status, 200);
  assert.equal(check.body.mode, "setup");
  assert.deepEqual([check.body.gift.from, check.body.gift.plan.name, check.body.gift.plan.validityHours], [{ type: "ndahi" }, "Weekly", 168]);
  assert.equal((await post("/api/account/claim/complete", { token: check.body.token, name: "Mama Ngum", pin: "1357", confirmPin: "1358" })).status, 400);
  const done = await post("/api/account/claim/complete", { token: check.body.token, name: "Mama Ngum", pin: "1357", confirmPin: "1357" });
  assert.equal(done.status, 200);
  assert.match(done.cookie, /customer_session=/, "the claim signs the new account in");
  const claimed = await voucher(id), customer = (await store.snapshot()).customers.find((c) => c.phone === "670009910");
  assert.deepEqual([claimed.customerId, claimed.status, claimed.reservation.status, claimed.reservation.claimedBy, customer.name, Boolean(customer.pinHash)],
    [customer.id, "available", "claimed", "code", "Mama Ngum", true]);
  assert.equal(done.body.claimed.startBy, claimed.startBy);
  assert.equal(Math.round((Date.parse(claimed.startBy) - Date.parse(claimed.reservation.claimedAt)) / 864e5), 90, "it waits 90 days to be started");
  assert.equal((await post("/api/account/claim/complete", { token: check.body.token, name: "Again", pin: "1357", confirmPin: "1357" })).status, 401, "a claim is used once");
  assert.ok((await store.snapshot()).auditLogs.some((a) => a.action === "voucher.reservation_claimed" && a.meta.voucherId === id));

  // Once claimed, only its account can start it; starting is the redeem call.
  assert.equal((await post("/api/vouchers/redeem", { phone: "670005555", code, deviceId: "d1" })).status, 401);
  const started = await post("/api/vouchers/redeem", { phone: "670009910", code, deviceId: "phone-1", label: "Phone" });
  assert.equal(started.status, 200);
  assert.equal((await voucher(id)).status, "active");
});

test("wrong tries lock the claim for 15 minutes", async (t) => {
  const { store, post, reserve } = await start(t);
  const { code } = (await reserve("670009910")).body.voucher;
  for (let i = 0; i < 5; i++) assert.equal((await post("/api/account/claim/check", { phone: "670007777", code }, { ip: "203.0.113.9" })).status, 401);
  const locked = await post("/api/account/claim/check", { phone: "670009910", code }, { ip: "203.0.113.9" });
  assert.deepEqual([locked.status, locked.body.code], [429, "CLAIM_LOCKED"], "the address is locked, even for the right number");
  assert.equal((await post("/api/account/claim/check", { phone: "670007777", code }, { ip: "203.0.113.10" })).status, 429, "and so is the number, from anywhere");
  assert.ok((await store.snapshot()).auditLogs.some((a) => a.action === "voucher.reservation_claim_locked"));
});

test("an existing account signs in with its PIN to claim", async (t) => {
  const { post, reserve, voucher, store } = await start(t);
  const { id, code } = (await reserve("670009910")).body.voucher;
  // The number signs up some other way after the reservation was made.
  await store.transaction(async (s) => {
    const argon2 = (await import("argon2")).default;
    s.customers.push({ id: "c-later", phone: "670009910", name: "Mama Ngum", pinHash: await argon2.hash("2468", { type: argon2.argon2id }) });
  });
  const check = await post("/api/account/claim/check", { phone: "670009910", code });
  assert.equal(check.body.mode, "login");
  assert.equal((await post("/api/account/claim/complete", { token: check.body.token, pin: "1111" })).status, 401);
  // The usual PIN back-off applies; skip the short wait.
  await store.transaction((s) => { delete s.customers.find((c) => c.id === "c-later").pinNextAttemptAt; });
  assert.equal((await post("/api/account/claim/complete", { token: check.body.token, pin: "2468" })).status, 200);
  assert.deepEqual([(await voucher(id)).customerId, (await voucher(id)).status], ["c-later", "available"]);
});

test("staff change the number or revoke; expired reservations cannot be claimed", async (t) => {
  const { store, post, reserve, voucher } = await start(t);
  const first = (await reserve("670009910")).body.voucher;
  await post("/api/account/claim/check", { phone: "670005555", code: first.code });
  const changed = await post("/api/admin/vouchers/reservation", { voucherId: first.id, phone: "670005730" }, { role: "owner" });
  assert.equal(changed.status, 200);
  assert.deepEqual([changed.body.voucher.reservation.phone, changed.body.voucher.reservation.wrongAttempts], ["670005730", 0]);
  assert.deepEqual((await store.snapshot()).auditLogs.find((a) => a.action === "voucher.reservation_number_changed").meta, { voucherId: first.id, from: "6•• •• 99 10", to: "6•• •• 57 30" });
  assert.equal((await post("/api/account/claim/check", { phone: "670009910", code: first.code })).status, 401, "the old number can no longer claim it");
  assert.equal((await post("/api/account/claim/check", { phone: "670005730", code: first.code })).status, 200);
  assert.equal((await post("/api/admin/vouchers/reservation", { voucherId: first.id, phone: "670001234" }, { role: "reseller" })).status, 403);

  const second = (await reserve("670009911")).body.voucher;
  assert.equal((await post("/api/admin/vouchers/revoke", { voucherId: second.id }, { role: "owner" })).status, 200);
  assert.equal(reservationState(await voucher(second.id), new Date()), "revoked");
  assert.equal((await post("/api/account/claim/check", { phone: "670009911", code: second.code })).status, 401);

  const third = (await reserve("670009912")).body.voucher;
  await store.transaction((s) => { s.vouchers.find((v) => v.id === third.id).reservation.expiresAt = new Date(Date.now() - 1000).toISOString(); });
  assert.equal((await post("/api/account/claim/check", { phone: "670009912", code: third.code })).status, 401);
  assert.equal((await post("/api/vouchers/redeem", { phone: "670009912", code: third.code, deviceId: "d" })).status, 401, "nor redeemed");
  assert.equal((await post("/api/admin/vouchers/reservation", { voucherId: third.id, phone: "670001234" }, { role: "owner" })).status, 409);
});

test("a Mobile Money payment from the reserved number claims it for that account", async (t) => {
  const { post, reserve, voucher } = await start(t);
  const { id } = (await reserve("670009910")).body.voucher;
  const bought = await post("/api/purchase", { phone: "670009910", name: "Mama Ngum", planId: "daily" });
  assert.equal(bought.status, 201, JSON.stringify(bought.body));
  assert.equal((await post(`/api/payments/${bought.body.payment.id}/confirm`, {})).status, 200);
  const v = await voucher(id);
  assert.deepEqual([v.status, v.reservation.status, v.reservation.claimedBy, Boolean(v.customerId)], ["available", "claimed", "payment", true], "claimed and saved, not started");
});

test("a friend's gift names its giver and carries their note", () => {
  const s = { customers: [{ id: "c-amina", name: "Amina Nfor" }] };
  const v = { id: "v1", quotaBytes: 5e9, deviceLimit: 3, reservation: { by: { type: "customer", id: "c-amina" }, note: "For your calls with the family ❤", expiresAt: "2027-02-11T00:00:00Z" } };
  assert.deepEqual(giftView(s, v, { id: "weekly", name: "Weekly", validityHours: 168, deviceLimit: 1 }),
    { voucherId: "v1", plan: { id: "weekly", name: "Weekly", quotaBytes: 5e9, validityHours: 168, deviceLimit: 3 }, from: { type: "friend", name: "Amina N." }, note: "For your calls with the family ❤", claimBy: "2027-02-11T00:00:00Z" });
  assert.equal(maskPhone("237670009910"), "6•• •• 99 10");
});
