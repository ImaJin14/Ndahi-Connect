import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../lib/api/state.mjs";
import { createHomeService } from "../lib/home-service.mjs";
import { homeOperationalSummary } from "../lib/home-observability.mjs";

test("100 synthetic households refresh in bounded fair batches with no duplicate queued observations", async () => {
  const now = new Date("2030-01-01T12:00:00Z"), store = createStore({ persistent: false });
  await store.transaction(s => {
    s.networkSetup = { runtimeRouterEnabled: true, connections: { router: { mode: "live", revision: "r1" } } };
    for (let i = 0; i < 100; i++) {
      const customerId = `load-c${i}`, id = `load-v${i}`, link = `load-h${i}`, generation = `load-g${i}`;
      s.customers.push({ id: customerId, phone: String(670050000 + i), homeConnectionId: link });
      s.homeConnections.push({ id: link, customerId, generation, status: "linked", routerRevision: "r1" });
      s.vouchers.push({ id, customerId, status: "active", accessMode: "home", homeStatus: "connected", usedBytes: 0,
        quotaBytes: 1000, expiresAt: new Date(+now + 86400000).toISOString(), homeGeneration: generation,
        homeConnectionId: link, homeAccounting: { base: 0, raw: 0, epoch: generation } });
    }
  });
  const seen = [];
  const service = createHomeService({ store, env: { NDAHI_HOME_ENABLED: "true", NODE_ENV: "test" }, now: () => now,
    router: { async readHome(v) { seen.push(v.id); return { bytes: 1, epoch: v.homeGeneration, generation: v.homeGeneration, connected: true }; } } });
  for (let batch = 0; batch < 4; batch++) assert.equal((await service.run()).processed, 25);
  const state = await store.snapshot(), summary = homeOperationalSummary(state, now);
  assert.equal(new Set(seen).size, 100); assert.equal(seen.length, 100);
  assert.equal(summary.usage.fresh, 100); assert.equal(summary.usage.stale, 0);
  assert.equal(summary.queue.pending, 0);
  assert.equal(state.homeOperations.length, 100);
  assert.equal(state.homeUsageObservations.filter(o => o.type === "usage.high_water").length, 100);
  assert.equal((await service.run()).processed, 0);
  assert.equal((await store.snapshot()).homeOperations.length, 100);
});
