import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../customer-app/checkout-store.js", import.meta.url), "utf8"))
  .replaceAll("export const ", "const ").replaceAll("export function ", "function ") +
  "\nglobalThis.store = {checkoutStore, savedCheckout, migrateLegacyCheckout, configureCheckoutStore};";
function fixture({ cookies = true, storage = {} } = {}) {
  let now = 1000000;
  const jar = new Map(), writes = [];
  const document = {};
  Object.defineProperty(document, "cookie", {
    get() { if (!cookies) throw Error("Denied"); return [...jar].map(([k, v]) => k + "=" + v).join("; "); },
    set(value) {
      if (!cookies) throw Error("Denied"); writes.push(value);
      const [pair] = value.split(";"), [name, ...rest] = pair.split("=");
      if (/Max-Age=0(?:;|$)/.test(value)) jar.delete(name); else jar.set(name, rest.join("="));
    },
  });
  const localStorage = { get length() { return Object.keys(storage).length; }, key: (i) => Object.keys(storage)[i],
    getItem: (key) => storage[key], removeItem: (key) => { delete storage[key]; } };
  const context = vm.createContext({ document, location: { protocol: "https:" }, window: { localStorage }, Date: { now: () => now } });
  vm.runInContext(source, context); context.store.configureCheckoutStore(420);
  return { ...context.store, jar, writes, storage, advance: (ms) => { now += ms; }, now: () => now };
}

for (const cookies of [true, false]) test(`checkout storage expires without sliding when cookies are ${cookies ? "available" : "blocked"}`, () => {
  const f = fixture({ cookies }); f.checkoutStore.set("ndahi-checkout", "private-key");
  f.advance(300000); assert.equal(f.checkoutStore.get("ndahi-checkout"), "private-key");
  f.checkoutStore.set("ndahi-checkout", "private-key");
  f.advance(119999); assert.equal(f.checkoutStore.get("ndahi-checkout"), "private-key");
  f.advance(1); assert.equal(f.checkoutStore.get("ndahi-checkout"), null);
  if (cookies) assert.equal(f.jar.size, 0);
});

test("an authoritative shorter deadline also limits memory and cannot be extended by a later response", () => {
  const f = fixture(); f.checkoutStore.set("key", "value");
  // The caller converts API deadline minus serverTime to a local duration.
  f.checkoutStore.set("key", "value", { expiresAt: f.now() + 5000 });
  f.checkoutStore.set("key", "value", { expiresAt: f.now() + 420000 });
  f.advance(5000); assert.equal(f.checkoutStore.get("key"), null);
  assert.match(f.writes[0], /SameSite=Strict; Secure/);
});

test("legacy migration strips contact fields and binds its first API deadline only once", () => {
  const f = fixture({ storage: { "ndahi-interrupted-checkout": JSON.stringify({ paymentId: "p1", input: {
    requestKey: "private-key", planId: "weekly", name: "Private Name", phone: "670080001", email: "private@example.test",
  } }), "ndahi-payment-purchase-weekly": "private-key" } });
  f.migrateLegacyCheckout();
  assert.equal(Object.keys(f.storage).length, 0);
  assert.doesNotMatch(decodeURIComponent(f.jar.get("ndahi-checkout")), /Private Name|670080001|private@example/);
  assert.equal(f.savedCheckout().paymentId, "p1");
  f.advance(10000);
  f.checkoutStore.set("ndahi-checkout", f.checkoutStore.get("ndahi-checkout"), { expiresAt: f.now() + 300000 });
  f.advance(299999); assert.equal(f.savedCheckout().requestKey, "private-key");
  f.advance(1); assert.equal(f.savedCheckout(), null);
});

test("old raw cookies get a bounded migration window that reads do not renew", () => {
  const f = fixture(); f.jar.set("old-key", encodeURIComponent("raw-secret"));
  assert.equal(f.checkoutStore.get("old-key"), "raw-secret");
  f.advance(419999); assert.equal(f.checkoutStore.get("old-key"), "raw-secret");
  f.advance(1); assert.equal(f.checkoutStore.get("old-key"), null);
});
