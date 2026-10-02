import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import client from "@prometheus-io/client";
import { createHandler, createStore } from "../server.mjs";
import { createServiceMetrics, createServiceMonitor, queueStats, monitoredCollections } from "../lib/service-metrics.mjs";
import { authOutcome } from "../lib/performance.mjs";
import { createLogger } from "../lib/logger.mjs";

const at = (seconds) => new Date(Date.parse("2026-10-02T12:00:00Z") - seconds * 1000).toISOString();
const now = Date.parse("2026-10-02T12:00:00Z");
const value = async (registry, name, labels = {}) => {
  const metric = (await registry.getMetricsAsJSON()).find((m) => m.name === name);
  return metric?.values.find((v) => Object.entries(labels).every(([k, l]) => v.labels[k] === l))?.value;
};

test("queue statistics count pending work, its oldest age, dead letters and payments needing review", () => {
  const stats = queueStats({
    payments: [
      { status: "pending", createdAt: at(600) },
      { status: "pending", createdAt: at(60) },
      { status: "paid", confirmedAt: at(30), createdAt: at(7200) },
      { status: "pending", fulfillmentStatus: "needs_review", createdAt: at(10) },
      { status: "paid", confirmedAt: at(5), refund: { status: "requested" } },
      { status: "refund-pending", refund: { status: "pending" } },
      { status: "pending", creationState: "uncertain", verificationError: "x", createdAt: at(20) },
    ],
    providerEvents: [
      { status: "retry", at: at(3600), replayedAt: at(120) },
      { status: "dead_letter", at: at(50) },
      { status: "processed", at: at(9000) },
    ],
    routerCommands: [
      { status: "queued", at: at(86400), queuedAt: at(300) },
      { status: "processing", at: at(45) },
      { status: "dead_letter", at: at(10) },
      { status: "dead_letter", at: at(10) },
    ],
    securityAlerts: [{ status: "pending", at: at(900) }, { status: "failed", at: at(9) }, { status: "sent", at: at(1) }],
  }, now);
  assert.deepEqual(stats.queues, {
    payments: { pending: 4, oldestSeconds: 600, deadLetters: 0 },
    payment_webhooks: { pending: 1, oldestSeconds: 120, deadLetters: 1 },
    network_commands: { pending: 2, oldestSeconds: 300, deadLetters: 2 },
    security_alerts: { pending: 1, oldestSeconds: 900, deadLetters: 1 },
  });
  assert.deepEqual(stats.attention, { needs_review: 1, uncertain: 1, verification_error: 1, refund_requested: 1, refund_pending: 1 });
  assert.deepEqual(queueStats({}, now).queues.payments, { pending: 0, oldestSeconds: 0, deadLetters: 0 });
});

test("instrumented adapters record dependency outcomes without changing behaviour", async () => {
  const registry = new client.Registry(), metrics = createServiceMetrics({ registry, enabled: true });
  class Provider {
    #secret = "kept";
    configured() { return this.#secret === "kept"; }
    async createPayment(p) { return { providerReference: `ref-${p.id}` }; }
    async verifyPayment() { throw Error("Provider unavailable"); }
    async handleWebhook() { throw Error("bad signature"); }
  }
  const adapter = metrics.instrument(new Provider(), "payment", "mesomb");
  assert.equal(adapter.configured(), true, "private fields still work through the wrapper");
  assert.deepEqual(await adapter.createPayment({ id: 7 }), { providerReference: "ref-7" });
  await assert.rejects(adapter.verifyPayment(), /Provider unavailable/);
  await assert.rejects(adapter.handleWebhook(), /bad signature/);
  assert.ok(adapter instanceof Provider);
  const labels = { dependency: "payment", provider: "mesomb" };
  assert.equal(await value(registry, "ndahi_dependency_calls_total", { ...labels, operation: "createPayment", outcome: "success" }), 1);
  assert.equal(await value(registry, "ndahi_dependency_calls_total", { ...labels, operation: "verifyPayment", outcome: "failure" }), 1);
  assert.equal(await value(registry, "ndahi_dependency_calls_total", { operation: "handleWebhook" }), undefined, "caller errors are not provider failures");

  const disabled = createServiceMetrics({ registry: new client.Registry() }), raw = new Provider();
  assert.equal(disabled.instrument(raw, "payment", "mesomb"), raw);
});

test("the monitor refreshes gauges from a partial snapshot, reports failures and probes Omada periodically", async () => {
  const registry = new client.Registry(), metrics = createServiceMetrics({ registry, enabled: true });
  const store = createStore({ persistent: false });
  await store.transaction((s) => { s.routerCommands.push({ id: "router:mark_inactive:global", kind: "router_command", status: "queued", at: at(90) }); });
  const reads = [], lines = [];
  let probes = 0, fail = false;
  const monitor = createServiceMonitor({
    store: { snapshot: async (options) => { reads.push(options); if (fail) throw Object.assign(Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }); return store.snapshot(); } },
    metrics, omada: metrics.instrument({ async status() { probes++; return { connected: true }; } }, "omada"),
    omadaLive: true, omadaEvery: 2, bootstrapMode: true, now: () => now,
    logger: createLogger({ service: "api", write: (_, line) => lines.push(JSON.parse(line)) }),
  });
  await Promise.all([monitor.run(), monitor.run()]);
  assert.equal(reads.length, 1, "overlapping runs share one sample");
  assert.deepEqual(reads[0], { only: monitoredCollections });
  assert.equal(await value(registry, "ndahi_queue_pending", { queue: "network_commands" }), 1);
  assert.equal(await value(registry, "ndahi_queue_oldest_pending_seconds", { queue: "network_commands" }), 90);
  assert.equal(await value(registry, "ndahi_queue_dead_letters", { queue: "payment_webhooks" }), 0);
  assert.equal(await value(registry, "ndahi_bootstrap_mode"), 1);
  assert.equal(await value(registry, "ndahi_monitor_last_sample_timestamp_seconds"), now / 1000);
  fail = true;
  await monitor.run();
  await monitor.run();
  assert.equal(await value(registry, "ndahi_monitor_sample_failures_total"), 2);
  assert.deepEqual(lines.map(({ event, code }) => ({ event, code })), [
    { event: "monitoring.sample_failed", code: "ECONNREFUSED" }, { event: "monitoring.sample_failed", code: "ECONNREFUSED" },
  ]);
  assert.equal(probes, 2, "Omada is probed on the first and every second run");
  assert.equal(await value(registry, "ndahi_dependency_calls_total", { dependency: "omada", operation: "status", outcome: "success" }), 2);
});

test("login responses are grouped into success, rejected, throttled, invalid and error", () => {
  assert.deepEqual([200, 202, 400, 401, 403, 404, 423, 429, 500, 503].map(authOutcome),
    ["success", "success", "invalid", "rejected", "rejected", "invalid", "throttled", "throttled", "error", "error"]);
});

test("the metrics endpoint exposes dependency, authentication, database and queue health", async (t) => {
  const token = "m".repeat(40), store = createStore({ persistent: false });
  const handler = createHandler({
    store,
    env: {
      NODE_ENV: "test", PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
      SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
      PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", ADMIN_PIN: "9999",
      PERFORMANCE_METRICS_ENABLED: "true", METRICS_BEARER_TOKEN: token, LOG_LEVEL: "error",
    },
    payments: { mesomb: { async createPayment() { throw Error("Payment provider request failed (503)"); } } },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then((response) => response.status);

  assert.equal(await post("/api/purchase", { phone: "670010009", name: "Metric Customer", email: "metric@example.test", planId: "weekly", network: "mtn", requestKey: "metric-1" }), 201);
  assert.equal(await post("/api/admin/login", { username: "owner", password: "wrong-password" }), 401);
  await (await fetch(`${base}/api/health`)).arrayBuffer();
  await handler.serviceMonitor.run();

  assert.equal((await fetch(`${base}/api/metrics`)).status, 401);
  const text = await (await fetch(`${base}/api/metrics`, { headers: { authorization: `Bearer ${token}` } })).text();
  for (const series of [
    'ndahi_dependency_calls_total{dependency="payment",provider="mesomb",operation="createPayment",outcome="failure"} 1',
    'ndahi_auth_responses_total{actor="admin",outcome="rejected"} 1',
    "ndahi_database_up 1",
    'ndahi_queue_pending{queue="payments"} 1',
    'ndahi_payments_attention{reason="uncertain"} 1',
    "ndahi_bootstrap_mode 0",
  ]) assert.ok(text.includes(series), `missing ${series}`);
  assert.ok(!/670010009|metric@example|Metric Customer/.test(text), "metrics carry no customer data");
});
