import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import { validHotspotName, hotspotNameView } from "../lib/hotspot-name.mjs";

// The hotspot's name on the Wi-Fi page (PhoneHotspot, #404; owner 26 Nov):
// the owner sets it in Network setup, in English and French; the public status
// gives it to the Wi-Fi page; blank shows no name.
const secret = "hotspot-name-test";
async function fixture(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    for (const role of ["owner", "operator"]) {
      s.adminUsers.push({ id: role, role, username: role, active: true });
      s.adminSessions.push({ id: role, userId: role, role, tokenHash: hashSecret(role, secret), csrfToken: `csrf-${role}`, expiresAt: "2099-01-01T00:00:00Z" });
    }
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, CUSTOMER_SESSION_SECRET: secret, SECRET_PEPPER: secret,
    PAYMENT_MODE: "mock", NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const save = async (name, role = "owner") => {
    const r = await fetch(`${base}/api/admin/network/hotspot-name`, { method: "POST", headers: { "content-type": "application/json", cookie: `admin_session=${role}`, "x-csrf-token": `csrf-${role}` }, body: JSON.stringify({ name }) });
    return { status: r.status, body: await r.json() };
  };
  const status = async () => (await fetch(`${base}/api/status`)).json();
  return { store, save, status };
}

test("the owner names the hotspot in both languages, and the public status gives it to the Wi-Fi page", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.status()).hotspotName, undefined, "no name until the owner sets one");
  const saved = await f.save({ en: "  NDAHI   Bamenda ", fr: "NDAHI Bamenda" });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.hotspotName, { en: "NDAHI Bamenda", fr: "NDAHI Bamenda" });
  assert.deepEqual((await f.status()).hotspotName, { en: "NDAHI Bamenda", fr: "NDAHI Bamenda" });
  const s = await f.store.snapshot();
  assert.equal(s.auditLogs.at(-1).action, "network.hotspot_name_updated");
  // French falls back to English; both blank removes it.
  await f.save({ en: "NDAHI Market", fr: "" });
  assert.deepEqual((await f.status()).hotspotName, { en: "NDAHI Market", fr: "NDAHI Market" });
  await f.save({ en: "", fr: "" });
  assert.equal((await f.status()).hotspotName, undefined);
});

test("only the owner names the hotspot, within 40 characters and without markup", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.save({ en: "NDAHI", fr: "NDAHI" }, "operator")).status, 403);
  assert.equal((await f.save({ en: "x".repeat(41), fr: "" })).status, 400);
  assert.equal((await f.save({ en: "<b>NDAHI</b>", fr: "" })).status, 400);
  assert.equal((await f.save("NDAHI")).status, 400);
  assert.deepEqual(validHotspotName({ en: "A", fr: "B" }), { value: { en: "A", fr: "B" } });
  assert.equal(hotspotNameView({}), null);
});
