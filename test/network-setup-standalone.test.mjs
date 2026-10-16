import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../server.mjs";
import { createNetworkSetup, SimulatedRouter } from "../lib/network-setup.mjs";

const env = {
  NODE_ENV: "test",
  OMADA_MODE: "standalone",
  NETWORK_CONFIG_KEY: "a".repeat(64),
  NETWORK_ALLOWED_ORIGINS: "https://router.test,https://omada.test",
  NETWORK_PROVISIONING_ENABLED: "true",
};

test("standalone access points disable every Omada controller operation", async () => {
  const store = createStore({ persistent: false });
  const service = createNetworkSetup({ store, env, routerFactory: () => new SimulatedRouter() });
  const call = (action, input = {}) => service.handle(action, input, "owner");

  assert.equal((await call("status")).omadaStandalone, true);
  await assert.rejects(call("connection", { kind: "omada" }), /standalone/);
  await assert.rejects(call("discover", { kind: "omada" }), /standalone/);
  await assert.rejects(call("preview", { kind: "omada", config: {} }), /standalone/);
  await call("connection", { kind: "router", mode: "simulation" });
  assert.equal((await call("controller-status")).connected, false);
  assert.equal((await store.snapshot()).networkSetup?.connections?.omada, undefined);
  assert.ok((await call("discover", { kind: "router" })).discovery.identity);
});
