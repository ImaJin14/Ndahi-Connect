import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { approveDevice } from "../lib/wifi-approval.mjs";
import { invalidateAppDevice } from "../lib/wifi-app-associations.mjs";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { blank } from "../lib/api/state.mjs";

const root = "/api/account/device-management/current";
async function fixture(t, options) {
  const f = await pairingFixture(options); t.after(f.close);
  await f.store.transaction((s) => {
    approveDevice(s, "c1", { mac: guestMac }, f.now(), "test");
    s.vouchers[0].wifiDevices.push({ mac: guestMac, address: "10.20.0.30", sessionId: "*guest", startedAt: f.now().toISOString() });
  });
  const jar = new Map([["customer_session", "main"]]);
  let csrf = "csrf";
  async function call(path = root, input) {
    const response = await fetch(f.api + path, { method: input === undefined ? "GET" : "POST", headers: {
      origin: "http://customer.test", "content-type": "application/json", "x-csrf-token": csrf,
      "cf-connecting-ip": "203.0.113.10", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; "),
    }, ...(input === undefined ? {} : { body: JSON.stringify(input) }) });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(";"), index = pair.indexOf("=");
      jar.set(pair.slice(0, index), pair.slice(index + 1));
    }
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  async function login() {
    const customer = (await f.store.snapshot()).customers[0];
    const result = await call("/api/account/login/pin", { phone: customer.phone, pin: String(2468) });
    assert.equal(result.status, 200);
    csrf = (await f.store.snapshot()).dashboardSessions.at(-1).csrfToken;
  }
  return { ...f, call, jar, login, identify: (input = {}) => call(root + "/identify", input) };
}

test("actual fresh PIN login restores a hashed app candidate and requires a fresh router check", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.identify({ mac: guestMac, address: "10.20.0.30" })).body.state, "connected");
  const token = f.jar.get("ndahi_wifi_app");
  assert.ok(token);
  const before = await f.store.snapshot();
  assert.equal(JSON.stringify(before.wifiAppAssociations).includes(token), false);
  await f.login();
  const restored = await f.call();
  assert.equal(restored.body.state, "unknown");
  assert.equal(restored.body.identificationRequired, true);
  assert.equal((await f.identify()).body.state, "connected");
  assert.equal(f.calls.length, 0);
  assert.equal((await f.store.snapshot()).wifiAppAssociations.length, 1);
  assert.match(restored.headers.get("set-cookie"), /HttpOnly; SameSite=Lax; Max-Age=31536000/);
});

test("a new installed context requires explicit account-scoped MAC identification, never a sole-device guess", async (t) => {
  const f = await fixture(t);
  const initial = await f.call();
  assert.equal(initial.body.state, "unknown");
  assert.equal(initial.body.identificationRequired, undefined);
  assert.ok(initial.body.identificationOptions.some((d) => d.mac === guestMac));
  assert.equal((await f.identify({ mac: "00:00:00:00:00:99", address: "10.20.0.99", confirmMac: true })).status, 409);
  assert.equal((await f.identify({ mac: guestMac, address: "10.20.0.30", confirmMac: true })).body.state, "connected");
});

test("restoration survives logout-style session removal and follows unique confirmed DHCP changes", async (t) => {
  const f = await fixture(t);
  await f.identify({ mac: guestMac, address: "10.20.0.30" });
  await f.store.transaction((s) => { s.dashboardSessions = []; s.vouchers[0].wifiDevices.at(-1).address = "10.20.0.40"; });
  await f.login();
  assert.equal((await f.call()).body.identificationRequired, true);
  const verified = await f.identify();
  assert.equal(verified.body.state, "connected");
  assert.equal(verified.body.candidate.address, "10.20.0.40");
});

test("explicit re-identification resets only this app candidate, retaining the saved Wi-Fi approval", async (t) => {
  const f = await fixture(t);
  await f.identify({ mac: guestMac, address: "10.20.0.30" });
  const reset = await f.call(root + "/reset", {});
  assert.equal(reset.body.state, "unknown");
  assert.ok(reset.body.identificationOptions.length);
  assert.equal((await f.store.snapshot()).wifiDeviceGrants[0].status, "approved");
  assert.equal((await f.identify()).body.state, "unknown");
});

test("cross-account, revoked and changed-router handles cannot restore the original candidate", async (t) => {
  for (const change of [
    (s) => { s.dashboardSessions.find((a) => a.id === "main").customerId = "c2"; },
    (s) => { invalidateAppDevice(s, "c1", guestMac, new Date()); },
    (s) => { s.networkSetup.connections.router.revision = "router-2"; },
  ]) {
    const f = await fixture(t);
    await f.identify({ mac: guestMac, address: "10.20.0.30" });
    await f.store.transaction((s) => { for (const a of s.dashboardSessions) delete a.currentWifi; change(s); });
    const status = await f.call();
    assert.notEqual(status.body.state, "connected");
    assert.equal(status.body.identificationRequired, undefined);
  }
});

test("router failure after a new sign-in preserves the candidate for a bounded retry, without Connected", async (t) => {
  let online = true;
  const f = await fixture(t, { router: { async readGuestDevice(input) {
    if (!online) throw Error("offline");
    return { ...input, loginAddress: input.address, hostId: "*host", server: "ndahi-hotspot" };
  } } });
  await f.identify({ mac: guestMac, address: "10.20.0.30" }); await f.login(); await f.call();
  online = false; f.advance(6);
  assert.notEqual((await f.identify()).body.state, "connected");
  assert.equal((await f.call()).body.identificationRequired, true);
  assert.equal((await f.store.snapshot()).wifiAppAssociations[0].candidate.mac, guestMac);
  online = true; f.advance(6);
  assert.equal((await f.identify()).body.state, "connected");
});

test("PostgreSQL association survives store restart and persists revocation invalidation", { skip: !process.env.TEST_DATABASE_URL && "TEST_DATABASE_URL is not set" }, async (t) => {
  const schema = `ndahi_app_identity_${process.pid}`, admin = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  await admin.connect();
  await admin.query(`CREATE SCHEMA ${schema}`);
  const pool = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL, options: `-c search_path=${schema}` });
  t.after(async () => { await pool.end(); await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });
  const directory = new URL("../migrations/", import.meta.url);
  for (const file of (await readdir(directory)).filter((name) => /^\d+_.+\.sql$/.test(name)).sort()) await pool.query(await readFile(new URL(file, directory), "utf8"));
  const f = await fixture(t);
  await f.identify({ mac: guestMac, address: "10.20.0.30" });
  const store = createPostgresStore({ pool, initialState: blank });
  await store.transaction(async (s) => Object.assign(s, await f.store.snapshot()));
  const restarted = createPostgresStore({ pool, initialState: blank });
  assert.equal((await restarted.snapshot()).wifiAppAssociations[0].candidate.mac, guestMac);
  await restarted.transaction((s) => invalidateAppDevice(s, "c1", guestMac, f.now()));
  assert.equal((await store.snapshot()).wifiAppAssociations[0].candidate, undefined);
  assert.equal((await store.snapshot()).dashboardSessions.find((a) => a.id === "main").currentWifi, undefined);
});
