import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture, publicRoot, ownerRoot, guestMac } from "./helpers/wifi-pairing-fixture.mjs";
import { wifiCompletionUrl } from "../customer-app/wifi-completion.js";

test("captive completion uses only the configured HTTPS router and a fixed public destination", () => {
  const target = new URL(wifiCompletionUrl("https://connect.test/login", "https://portal.test"));
  assert.equal(target.origin, "https://connect.test");
  assert.equal(target.pathname, "/login");
  assert.deepEqual([...target.searchParams], [["dst", "https://portal.test/wifi-connected.html"], ["popup", "false"]]);
  assert.equal(target.hash, "");
  for (const value of [undefined, "", "javascript:alert(1)", "http://connect.test/login", "https://connect.test/status", "https://user:secret@connect.test/login", "https://connect.test/login?dst=https://evil.test", "https://connect.test/login#secret"]) {
    assert.equal(wifiCompletionUrl(value, "https://portal.test"), null);
  }
});

async function connected(t) {
  const f = await pairingFixture(); t.after(f.close);
  const r = await f.request();
  const input = { id: r.body.request.id, key: r.requestKey };
  const approved = await f.call(ownerRoot + "/approve", { id: input.id });
  const redeem = await f.call(publicRoot + "/redeem", { ...input, approvalCode: approved.body.approvalCode }, { session: "", controller: "" });
  assert.equal(redeem.body.request.status, "connecting");
  assert.notEqual(redeem.body.request.completionReady, true);
  await f.process();
  return { ...f, input, status: () => f.call(publicRoot + "/status", input, { session: "", controller: "" }) };
}

test("only a recent, still-authorized router confirmation permits captive completion", async (t) => {
  const f = await connected(t), reply = await f.status();
  assert.equal(reply.body.request.completionReady, true);
  assert.equal(reply.headers.has("set-cookie"), false);
  assert.equal((await f.call("/api/account/dashboard", undefined, { session: "", controller: "" })).status, 401);
  assert.doesNotMatch(JSON.stringify(reply.body), /keyHash|codeHash|sessionId|670050001|NC-AAAA/);
  f.advance(121);
  assert.equal((await f.status()).body.request.completionReady, false, "old operation success is not a current connection");
});

for (const [name, change] of [
  ["router restart/session loss", (s) => { s.vouchers[0].wifiDevices = []; }],
  ["router revision change", (s) => { s.networkSetup.connections.router.revision = "router-2"; }],
  ["revoked grant", (s) => { s.wifiDeviceGrants.find((g) => g.mac === guestMac).status = "revoked"; }],
  ["suspended account", (s) => { s.customers[0].status = "suspended"; }],
  ["exhausted quota", (s) => { s.vouchers[0].usedBytes = s.vouchers[0].quotaBytes; }],
  ["changed client address", (s) => { s.vouchers[0].wifiDevices.find((d) => d.mac === guestMac).address = "10.20.0.99"; }],
  ["pending disconnect", (s) => { s.routerCommands.push({ action: "disconnect_wifi_device", status: "queued", device: { voucherId: "v1", mac: guestMac } }); }],
]) test(`historical Connected cannot finish captive sign-in after ${name}`, async (t) => {
  const f = await connected(t);
  await f.store.transaction(change);
  assert.equal((await f.status()).body.request.completionReady, false);
});
