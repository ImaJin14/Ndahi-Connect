import { performance } from "node:perf_hooks";
import { createServer, createStore } from "../server.mjs";
const store = createStore({ persistent: false }),
  server = createServer({
    store,
    env: { PAYMENT_MODE: "mock", SECRET_PEPPER: "load-test" },
  });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`, latencies = [];
let failures = 0;
async function post(path, data) {
  const start = performance.now(),
    r = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  latencies.push(performance.now() - start);
  const j = await r.json();
  if (!r.ok) failures++;
  return { r, j };
}
const users = Array.from(
  { length: 300 },
  (_, i) => ({ phone: String(680000000 + i), deviceId: `load-device-${i}` }),
);
const bought = await Promise.all(
  users.map((u) =>
    post("/api/purchase", {
      phone: u.phone,
      name: `Student ${u.phone}`,
      planId: "weekly",
    })
  ),
);
const paid = await Promise.all(
  bought.map((x) => post(`/api/payments/${x.j.payment.id}/confirm`, {})),
);
const redeemed = await Promise.all(
  users.map((u, i) =>
    post("/api/vouchers/redeem", { ...u, code: paid[i].j.access.code })
  ),
);
latencies.sort((a, b) => a - b);
const s = await store.snapshot(),
  result = {
    successfulActivations: paid.filter((x) => x.r.ok).length,
    successfulRedemptions: redeemed.filter((x) => x.r.ok).length,
    failedRequests: failures,
    medianLatencyMs: +latencies[Math.floor(latencies.length * .5)].toFixed(2),
    p95LatencyMs: +latencies[Math.floor(latencies.length * .95)].toFixed(2),
    activeSessions: s.sessions.filter((x) => x.status === "online").length,
    dataIntegrity: {
      customers: s.customers.length,
      payments: s.payments.length,
      vouchers: s.vouchers.length,
      uniqueCodes: new Set(s.vouchers.map((x) => x.code)).size,
    },
    persistenceRaceConditions:
      s.customers.length === 300 && s.vouchers.length === 300 &&
        s.sessions.length === 300
        ? "none detected"
        : "detected",
  };
console.log(JSON.stringify(result, null, 2));
await new Promise((r) => server.close(r));
if (failures || result.persistenceRaceConditions !== "none detected") {
  process.exitCode = 1;
}
