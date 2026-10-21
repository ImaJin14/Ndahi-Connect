import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";

test("administrator passkey challenge responses wait for storage commit and cannot report rolled-back success", async (t) => {
  const f = await pairingFixture({ env: { ADMIN_APP_URL: "http://customer.test" } }); t.after(f.close);
  await f.store.transaction((s) => s.adminUsers.push({ id: "owner", username: "owner", role: "owner", active: true, passkeys: [{ id: "fixture-credential" }] }));
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = (fn, ...args) => transaction(async (s) => {
    const result = await fn(s);
    if (s.adminPasskeyChallenges.length) throw Error("Synthetic challenge commit failure");
    return result;
  }, ...args);
  const response = await fetch(f.api + "/api/admin/passkey/options", { method: "POST", headers: { origin: "http://customer.test", "content-type": "application/json" }, body: JSON.stringify({ username: "owner" }) });
  const body = await response.json(); assert.notEqual(response.status, 200); assert.equal(body.challengeId, undefined);
  assert.equal((await f.store.snapshot()).adminPasskeyChallenges.length, 0); assert.equal(response.headers.get("set-cookie"), null);
});
