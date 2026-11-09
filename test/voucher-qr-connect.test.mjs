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
  assert.equal(reply.headers.get("set-cookie"), null);
  assert.equal(
    (await f.store.snapshot()).dashboardSessions.length,
    before.dashboardSessions.length,
  );
  assert.doesNotMatch(
    JSON.stringify(reply.body),
    /670050001|Imajin|pinHash|customerId|NC-AAAA/,
  );
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
test("legacy printed code still resolves to proof-only connection context and off-network proof is denied", async (t) => {
  const f = await fixture(t);
  const reply = await begin(f, { qr: undefined, legacyCode: "NC-AAAA-1111" });
  assert.equal(reply.status, 200);
  const denied = await f.call(
    root + "/verify",
    { ...target, context: reply.body.context, pin: "2468" },
    { session: "", address: "198.51.100.9" },
  );
  assert.equal(denied.body.code, "WIFI_REQUIRED");
  assert.equal(denied.headers.get("set-cookie"), null);
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
  const options = await f.call(
    root + "/options",
    { context: started.body.context, ...target },
    { session: "" },
  );
  assert.equal(options.status, 200);
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
