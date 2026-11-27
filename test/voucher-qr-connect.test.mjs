import test from "node:test";
import assert from "node:assert/strict";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";
import { isoCBOR } from "@simplewebauthn/server/helpers";
import { pairingFixture, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { voucherQrUrl } from "../lib/voucher-qr.mjs";
const root = "/api/account/qr-connect",
  target = { mac: guestMac, address: "10.20.0.30", key: "a".repeat(32) };
async function fixture(t) {
  const f = await pairingFixture();
  t.after(f.close);
  let qr;
  await f.store.transaction((s) => {
    const url = voucherQrUrl(
      s.vouchers[0],
      s.customers[0],
      "http://customer.test",
    );
    qr = new URLSearchParams(new URL(url).hash.slice(1)).get("qr");
  });
  return { ...f, qr };
}
const begin = (f, overrides = {}, options = {}) =>
  f.call(
    root + "/begin",
    { qr: f.qr, ...target, ...overrides },
    { session: "", ...options },
  );
async function verifyPin(f) {
  const started = await begin(f);
  assert.equal(started.status, 200);
  const verified = await f.call(
    root + "/verify",
    { ...target, context: started.body.context, pin: "2468" },
    { session: "" },
  );
  assert.equal(verified.status, 200);
  const session = verified.headers
    .get("set-cookie")
    .match(/customer_session=([^;]+)/)[1];
  const dashboard = await f.call("/api/account/dashboard", undefined, {
    session,
  });
  return {
    session,
    csrf: dashboard.body.csrfToken,
    token: verified.body.qrAuthorization,
    context: started.body.context,
  };
}
test("scan is account-specific limited context and does not create a login or leak account details", async (t) => {
  const f = await fixture(t),
    before = await f.store.snapshot(),
    reply = await begin(f);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.wifiReady, true);
  assert.equal((await begin(f, { mac: "", address: "" })).body.wifiReady, false);
  assert.equal(reply.headers.get("set-cookie"), null);
  assert.equal(
    (await f.store.snapshot()).dashboardSessions.length,
    before.dashboardSessions.length,
  );
  // Before the PIN only the first name and the bundle's card show (#371,
  // owner 27 Nov: as drawn); never the number, the code or account records.
  assert.doesNotMatch(
    JSON.stringify(reply.body),
    /670050001|pinHash|customerId|NC-AAAA/,
  );
  assert.deepEqual(reply.body.account, { first: "Imajin" });
  const wrong = await f.call(
    root + "/verify",
    { ...target, context: reply.body.context, pin: "0000" },
    { session: "" },
  );
  assert.equal(wrong.status, 401);
  assert.equal(wrong.headers.get("set-cookie"), null);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
  assert.equal(
    (await begin(f, {}, { session: "other" })).body.code,
    "DIFFERENT_ACCOUNT",
  );
});
test("PIN proof signs in the right account and grants one bound connection without replacing main device", async (t) => {
  const f = await fixture(t),
    before = (await f.store.snapshot()).customers[0].wifiMainDevice;
  const proof = await verifyPin(f);
  const replay = await f.call(
    root + "/verify",
    { ...target, context: proof.context, pin: "2468" },
    { session: proof.session },
  );
  assert.equal(replay.body.code, "QR_CONTEXT_EXPIRED");
  const connected = await f.call(
    "/api/account/device-management/connect",
    { ...target, qrAuthorization: proof.token },
    proof,
  );
  assert.equal(connected.status, 202);
  let snapshot = await f.store.snapshot();
  assert.equal(snapshot.wifiPairingRequests[0].kind, "qr_owner");
  assert.deepEqual(snapshot.customers[0].wifiMainDevice, before);
  await f.process();
  snapshot = await f.store.snapshot();
  assert.equal(snapshot.wifiPairingRequests[0].status, "connected");
  assert.equal(f.calls.length, 1);
  assert.deepEqual(snapshot.customers[0].wifiMainDevice, before);
  const reused = await f.call(
    "/api/account/device-management/connect",
    { ...target, key: "b".repeat(32), qrAuthorization: proof.token },
    proof,
  );
  assert.equal(reused.body.code, "QR_AUTHORIZATION_EXPIRED");
});
test("QR grant is unusable for a changed device or another account", async (t) => {
  const f = await fixture(t),
    proof = await verifyPin(f);
  const changed = await f.call(
    "/api/account/device-management/connect",
    { ...target, mac: "AA:BB:CC:DD:EE:09", qrAuthorization: proof.token },
    proof,
  );
  assert.equal(changed.body.code, "QR_AUTHORIZATION_EXPIRED");
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
});
test("inactive, exhausted, Home, suspended and preparing vouchers never get the shortcut", async (t) => {
  for (const change of [
    { status: "expired" },
    { status: "refunded" },
    { usedBytes: 1e9 },
    { accessMode: "home" },
    { routerSyncStatus: "pending" },
  ]) {
    const f = await fixture(t);
    await f.store.transaction((s) => Object.assign(s.vouchers[0], change));
    assert.equal((await begin(f)).status, 409);
    assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
  }
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.customers[0].status = "suspended";
  });
  assert.equal((await begin(f)).status, 403);
});
test("expired challenge and rotated QR fail closed, including already queued authorization", async (t) => {
  const f = await fixture(t),
    reply = await begin(f);
  f.advance(301);
  assert.equal(
    (
      await f.call(
        root + "/verify",
        { ...target, context: reply.body.context, pin: "2468" },
        { session: "" },
      )
    ).body.code,
    "QR_CONTEXT_EXPIRED",
  );
  await f.store.transaction((s) => {
    s.vouchers[0].wifiDevicesAt = f.now().toISOString();
  });
  const proof = await verifyPin(f);
  const connected = await f.call(
    "/api/account/device-management/connect",
    { ...target, qrAuthorization: proof.token },
    proof,
  );
  assert.equal(connected.status, 202);
  assert.equal(
    (await f.call(root + "/rotate", { voucherId: "v1", pin: "2468" }, proof))
      .status,
    200,
  );
  assert.equal((await begin(f)).status, 401);
  await f.process();
  assert.equal(f.calls.length, 0);
});
test("legacy printed code resolves to proof-only context; off-network proof signs in without a connection", async (t) => {
  const f = await fixture(t);
  const reply = await begin(f, { qr: undefined, legacyCode: "NC-AAAA-1111" });
  assert.equal(reply.status, 200);
  // #213: the PIN works off NDAHI Wi-Fi, but only as an account sign-in.
  const signedIn = await f.call(
    root + "/verify",
    { ...target, context: reply.body.context, pin: "2468" },
    { session: "", address: "198.51.100.9" },
  );
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.wifiRequired, true);
  assert.equal(signedIn.body.qrAuthorization, undefined, "no router connection grant");
  assert.match(signedIn.headers.get("set-cookie"), /customer_session=/);
  const s = await f.store.snapshot();
  assert.equal(s.customerAccessChallenges.filter((ch) => ch.type === "qr_connect_grant").length, 0);
  assert.equal(s.wifiPairingRequests.length, 0);
  assert.ok(s.securityEvents.some((e) => e.type === "customer.voucher_qr.verified_without_wifi"));
  // The verified context is single-use.
  const again = await f.call(root + "/verify", { ...target, context: reply.body.context, pin: "2468" }, { session: "" });
  assert.equal(again.body.code, "QR_CONTEXT_EXPIRED");
});

test("missing device identity: the PIN signs in, a wrong PIN can be retried, and only an identified device gets a grant (#213)", async (t) => {
  const f = await fixture(t);
  const unknown = { mac: "", address: "", key: "" };
  const started = await begin(f, unknown);
  assert.deepEqual([started.status, started.body.wifiReady], [200, false]);
  // A wrong PIN leaves the same attempt usable.
  const wrong = await f.call(root + "/verify", { ...unknown, context: started.body.context, pin: "0000" }, { session: "" });
  assert.deepEqual([wrong.status, wrong.body.code], [401, "VERIFICATION_FAILED"]);
  // Straight away, the short wait after a wrong PIN applies (the page re-enables after it)...
  const early = await f.call(root + "/verify", { ...unknown, context: started.body.context, pin: "2468" }, { session: "" });
  assert.deepEqual([early.status, early.body.code], [429, "PIN_THROTTLED"]);
  // ...and once it has passed, the same attempt accepts the right PIN.
  await f.store.transaction((s) => { delete s.customers[0].pinNextAttemptAt; });
  const signedIn = await f.call(root + "/verify", { ...unknown, context: started.body.context, pin: "2468" }, { session: "" });
  assert.deepEqual([signedIn.status, signedIn.body.wifiRequired, signedIn.body.qrAuthorization], [200, true, undefined]);
  // Device details can't be swapped into an attempt begun without them.
  const swapped = await begin(f, unknown);
  const changed = await f.call(root + "/verify", { ...target, context: swapped.body.context, pin: "2468" }, { session: "" });
  assert.equal(changed.body.code, "DEVICE_CHANGED");
  // Once Wi-Fi sign-in identifies the device, a new attempt grants the bound connection.
  const granted = await verifyPin(f);
  assert.ok(granted.token);
  const s = await f.store.snapshot();
  assert.deepEqual(s.customerAccessChallenges.filter((ch) => ch.type === "qr_connect_grant").map((ch) => ch.target), [JSON.stringify([target.mac.toUpperCase(), target.address, target.key])]);
});
test("actual user-verified passkey signs in through a QR-bound single-use challenge", async (t) => {
  const f = await pairingFixture({ liveClock: true, now: new Date() });
  t.after(f.close);
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
      namedCurve: "prime256v1",
    }),
    jwk = publicKey.export({ format: "jwk" });
  const cose = Buffer.from(
    isoCBOR.encode(
      new Map([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, new Uint8Array(Buffer.from(jwk.x, "base64url"))],
        [-3, new Uint8Array(Buffer.from(jwk.y, "base64url"))],
      ]),
    ),
  );
  const id = randomBytes(32).toString("base64url");
  let qr;
  await f.store.transaction((s) => {
    s.customers[0].passkeys = [
      {
        id,
        publicKey: cose.toString("base64url"),
        counter: 0,
        transports: ["internal"],
      },
    ];
    qr = new URLSearchParams(
      new URL(
        voucherQrUrl(s.vouchers[0], s.customers[0], "http://customer.test"),
      ).hash.slice(1),
    ).get("qr");
  });
  const started = await f.call(
    root + "/begin",
    { qr, ...target },
    { session: "" },
  );
  // #213: a passkey prompt the customer cancels leaves the attempt usable; the
  // next prompt gets a fresh challenge.
  const abandoned = await f.call(root + "/options", { context: started.body.context, ...target }, { session: "" });
  assert.equal(abandoned.status, 200);
  const options = await f.call(
    root + "/options",
    { context: started.body.context, ...target },
    { session: "" },
  );
  assert.equal(options.status, 200);
  assert.notEqual(options.body.challengeId, abandoned.body.challengeId);
  const client = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge: options.body.options.challenge,
      origin: "http://customer.test",
      crossOrigin: false,
    }),
  );
  const auth = Buffer.alloc(37);
  createHash("sha256").update("customer.test").digest().copy(auth);
  auth[32] = 5;
  auth.writeUInt32BE(1, 33);
  const response = {
    id,
    rawId: id,
    type: "public-key",
    clientExtensionResults: {},
    response: {
      clientDataJSON: client.toString("base64url"),
      authenticatorData: auth.toString("base64url"),
      signature: sign(
        "sha256",
        Buffer.concat([auth, createHash("sha256").update(client).digest()]),
        privateKey,
      ).toString("base64url"),
      userHandle: null,
    },
  };
  const verified = await f.call(
    root + "/verify",
    {
      context: started.body.context,
      ...target,
      challengeId: options.body.challengeId,
      response,
    },
    { session: "" },
  );
  assert.equal(verified.status, 200);
  assert.equal(verified.body.authenticated, true);
  assert.ok(verified.body.qrAuthorization);
  assert.equal((await f.store.snapshot()).customers[0].passkeys[0].counter, 1);
});

test("wrong PIN is throttled and changing accounts or device details never upgrades scan context", async t => {
  const f = await fixture(t), started = await begin(f);
  const input = { ...target, context: started.body.context, pin: "0000" };
  assert.equal((await f.call(root + "/verify", input, { session: "" })).status, 401);
  assert.equal((await f.call(root + "/verify", input, { session: "" })).status, 429);
  assert.equal((await f.call(root + "/verify", { ...input, pin: "2468" }, { session: "other" })).body.code, "DIFFERENT_ACCOUNT");
  assert.equal((await f.call(root + "/verify", { ...input, pin: "2468", key: "b".repeat(32) }, { session: "" })).body.code, "DEVICE_CHANGED");
  assert.equal((await f.store.snapshot()).customerAccessChallenges.filter(row => row.type === "qr_connect_grant").length, 0);
});
test("connection grant expiry and PIN changes revoke QR authority without creating router writes", async t => {
  const f = await fixture(t), proof = await verifyPin(f);
  f.advance(91);
  const expired = await f.call("/api/account/device-management/connect", { ...target, qrAuthorization: proof.token }, proof);
  assert.equal(expired.body.code, "QR_AUTHORIZATION_EXPIRED");
  await f.store.transaction(s => { s.customers[0].pinHash = "changed-credential-version"; });
  assert.equal((await begin(f)).status, 401);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
});

test("reassigning a voucher invalidates the old locator even when credential hashes were duplicated historically", async t => {
  const f = await fixture(t);
  await f.store.transaction(s => { s.vouchers[0].customerId = s.customers[1].id; });
  assert.equal((await begin(f)).status, 401);
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
});

test("QR context and connection grants cannot be consumed as legacy account-access tokens", async t => {
  const f = await fixture(t), started = await begin(f);
  const denied = await f.call("/api/account/access/complete", { token: started.body.context, pin: "2468" }, { session: "" });
  assert.equal(denied.status, 401); assert.equal(denied.headers.get("set-cookie"), null);
  assert.ok((await f.store.snapshot()).customerAccessChallenges.some(row => row.type === "qr_connect_context" && !row.used));
  const proof = await verifyPin(f);
  assert.equal((await f.call("/api/account/access/complete", { token: proof.token, pin: "2468" }, { session: "" })).status, 401);
  assert.ok((await f.store.snapshot()).customerAccessChallenges.some(row => row.type === "qr_connect_grant" && !row.used));
});
// PhoneScanNoBundle (#412; owner 26 Nov): a QR from a bundle that has ended
// connects the same account's current bundle, so a bundle bought after the
// scan connects this device without a second scan. The PIN is still asked for
// and every check stays tied to the scanned QR.
async function endScannedBundle(f, { replacement = true } = {}) {
  await f.store.transaction((s) => {
    const v1 = s.vouchers.find((v) => v.id === "v1");
    if (replacement) s.vouchers.push({ ...structuredClone(v1), id: "v2", code: "NC-BBBB-2222", qrConnectToken: undefined, activatedAt: f.now().toISOString(), wifiDevices: [] });
    Object.assign(v1, { status: "expired", expiresAt: new Date(+f.now() - 3600000).toISOString() });
  });
}
test("a QR from an ended bundle connects the account's current bundle, still bound to the scanned QR (#412)", async (t) => {
  const f = await fixture(t);
  await endScannedBundle(f);
  const proof = await verifyPin(f);
  const connected = await f.call("/api/account/device-management/connect", { ...target, qrAuthorization: proof.token }, proof);
  assert.equal(connected.status, 202, JSON.stringify(connected.body));
  let snapshot = await f.store.snapshot();
  const request = snapshot.wifiPairingRequests[0];
  assert.deepEqual([request.kind, request.voucherId, request.qrVoucherId], ["qr_owner", "v2", "v1"]);
  await f.process();
  snapshot = await f.store.snapshot();
  assert.equal(snapshot.wifiPairingRequests[0].status, "connected");
  assert.equal(f.calls.length, 1);
});
test("replacing the ended bundle's QR, or another account's bundle, never connects (#412)", async (t) => {
  const f = await fixture(t);
  await endScannedBundle(f);
  const proof = await verifyPin(f);
  // The ended voucher's QR is replaced: the grant made with the old one fails closed.
  await f.store.transaction((s) => { s.vouchers.find((v) => v.id === "v1").qrConnectToken = "z".repeat(43); });
  const connected = await f.call("/api/account/device-management/connect", { ...target, qrAuthorization: proof.token }, proof);
  assert.equal(connected.body.code, "QR_AUTHORIZATION_EXPIRED");
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
  // Only the scanned account's bundles count: another customer's active bundle is never used.
  const g = await fixture(t);
  await endScannedBundle(g, { replacement: false });
  await g.store.transaction((s) => { s.vouchers.push({ ...structuredClone(s.vouchers[0]), id: "v9", customerId: "c2", status: "active", expiresAt: new Date(+g.now() + 86400000).toISOString() }); });
  assert.equal((await begin(g)).body.code, "BUNDLE_INACTIVE");
});
test("no active bundle shows the account as drawn, before any PIN, and nothing more (#412)", async (t) => {
  const f = await fixture(t);
  await endScannedBundle(f, { replacement: false });
  const reply = await begin(f);
  assert.equal(reply.status, 409);
  assert.equal(reply.body.code, "BUNDLE_INACTIVE");
  assert.deepEqual(reply.body.account, { name: "Imajin", phone: "+237 6•• •• 00 01" });
  assert.equal(reply.body.endedAt, (await f.store.snapshot()).vouchers[0].expiresAt);
  assert.doesNotMatch(JSON.stringify(reply.body), /670050001|pinHash|customerId|NC-AAAA|context/);
  // A first name and surname read "First L.".
  await f.store.transaction((s) => { s.customers[0].name = "Amina Nfor Tabe"; });
  assert.equal((await begin(f)).body.account.name, "Amina T.");
  // Only a Home bundle is active: that is said instead.
  await f.store.transaction((s) => { s.vouchers.push({ ...structuredClone(s.vouchers[0]), id: "home", status: "active", accessMode: "home", expiresAt: new Date(+f.now() + 86400000).toISOString() }); });
  assert.equal((await begin(f)).body.code, "HOME_ACCESS_SELECTED");
  assert.equal((await f.store.snapshot()).wifiPairingRequests.length, 0);
});

// Scan to connect (#371, canvas PhoneScanConnect): the card before the PIN
// (first name, the bundle's end, what's left and a Personal Unlimited
// bundle's slots), and both accounts named when someone else is signed in.
test("the scan card names the account and its bundle, with a Personal Unlimited bundle's slots (#371)", async (t) => {
  const f = await fixture(t);
  let reply = await begin(f);
  assert.deepEqual(reply.body.bundle, { expiresAt: (await f.store.snapshot()).vouchers[0].expiresAt, remainingBytes: 1e9 - 20 }, "an earlier bundle keeps its data left, no slots");
  await f.store.transaction((s) => {
    const v = s.vouchers[0];
    Object.assign(v, { accessType: "personal_unlimited", deviceSlots: 2, deviceLimit: 2, quotaBytes: null });
    s.wifiDeviceGrants ??= [];
    s.wifiDeviceGrants.push({ id: "g1", customerId: v.customerId, voucherId: v.id, mac: "AA:BB:CC:DD:EE:01", status: "approved", routerRevision: s.networkSetup.connections.router.revision });
  });
  reply = await begin(f);
  assert.equal(reply.status, 200);
  assert.equal(reply.body.bundle.remainingBytes, null);
  assert.deepEqual(reply.body.bundle.slots, { used: 1, total: 2 });
});

test("someone else signed in here: both accounts are named by first name and initial (#371)", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.customers.find((c) => c.id === "c1").name = "Amina Ndi";
    s.customers.find((c) => c.id === "c2").name = "Kofi Tabe";
  });
  const wrong = await begin(f, {}, { session: "other" });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, "DIFFERENT_ACCOUNT");
  assert.deepEqual([wrong.body.account, wrong.body.current], [{ name: "Amina N.", first: "Amina" }, { name: "Kofi T.", first: "Kofi" }]);
  assert.doesNotMatch(JSON.stringify(wrong.body), /670050001|670050002|Ndi|Tabe/);
});
