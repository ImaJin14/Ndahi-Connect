import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHandler, createStore } from "../server.mjs";
import { enqueuePaymentWebhook } from "../lib/payment-webhooks.mjs";
import { createRouterCommandProcessor, enqueueRouterCommand, scheduleRouterCommandReplay } from "../lib/router-queue.mjs";
import { createPerformanceMetrics } from "../lib/performance.mjs";
import { sloReport, sloStatus } from "../scripts/slo-report.mjs";

// Histogram samples report their _bucket/_count name per value rather than per metric.
const value = async (registry, name, labels = {}) => {
  for (const metric of await registry.getMetricsAsJSON()) {
    for (const sample of metric.values) {
      if ((sample.metricName || metric.name) === name && Object.entries(labels).every(([k, l]) => String(sample.labels[k]) === l)) return sample.value;
    }
  }
};

async function paymentFixture(t) {
  let time = Date.parse("2026-10-02T12:00:00Z");
  const store = createStore({ persistent: false });
  const handler = createHandler({
    store, now: () => new Date(time),
    env: {
      NODE_ENV: "test", PAYMENT_MODE: "mesomb", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
      SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
      PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", ADMIN_PIN: "9999",
      PERFORMANCE_METRICS_ENABLED: "true", METRICS_BEARER_TOKEN: "m".repeat(40), LOG_LEVEL: "error",
    },
    payments: { mesomb: {
      async createPayment(p) { return { providerReference: `ref-${p.id}` }; },
      async verifyPayment(p) { return { status: "paid", providerReference: `ref-${p.id}`, transactionReference: p.id, amount: p.amount, currency: p.currency }; },
    } },
  });
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const purchase = async (phone, requestKey) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/purchase`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ phone, name: "SLO Customer", email: "slo@example.test", planId: "weekly", network: "mtn", requestKey }),
    });
    assert.equal(response.status, 201);
    return (await response.json()).payment.id;
  };
  const settle = async (paymentId, eventId) => {
    const event = await enqueuePaymentWebhook(store, "mesomb", { paymentId, transactionId: `ref-${paymentId}`, eventId }, "{}", () => new Date(time));
    return handler.webhookProcessor.process(event.id);
  };
  return { store, handler, purchase, settle, advance: (seconds) => { time += seconds * 1000; } };
}

test("payment fulfillment time runs from checkout, and a review failure counts once", async (t) => {
  const f = await paymentFixture(t);
  const registry = f.handler.metricsRegistry;
  const paid = await f.purchase("670020001", "slo-paid");
  f.advance(150);
  await f.settle(paid, "event-paid");
  assert.equal(await value(registry, "ndahi_payment_fulfillment_seconds_count"), 1);
  assert.equal(await value(registry, "ndahi_payment_fulfillment_seconds_bucket", { le: "120" }), 0);
  assert.equal(await value(registry, "ndahi_payment_fulfillment_seconds_bucket", { le: "300" }), 1);

  // A paid order whose customer record is missing cannot be fulfilled; a retried webhook must not recount it.
  const orphan = await f.purchase("670020002", "slo-review");
  await f.store.transaction((s) => { s.customers = s.customers.filter((c) => c.phone !== "670020002"); });
  await f.settle(orphan, "event-review-1");
  await f.settle(orphan, "event-review-2");
  assert.equal((await f.store.snapshot()).payments.find((p) => p.id === orphan).fulfillmentStatus, "needs_review");
  assert.equal(await value(registry, "ndahi_payment_fulfillment_failures_total", { reason: "missing_plan" }), 1);
  assert.equal(await value(registry, "ndahi_payment_fulfillment_seconds_count"), 1);
});

test("router command delivery time runs from the latest queuing; replays and dead letters are counted apart", async () => {
  let time = Date.parse("2026-10-02T12:00:00Z");
  const now = () => new Date(time), seen = [], store = createStore({ persistent: false });
  const metrics = { commandDelivered: (action, seconds) => seen.push(["delivered", action, seconds]), commandDeadLettered: (action) => seen.push(["dead", action]) };
  let fail = false;
  const processor = createRouterCommandProcessor({ store, now, metrics, maxAttempts: 1,
    router: { async disconnectDevice() { if (fail) throw Error("Router request failed (503)"); return {}; } } });
  await store.transaction((s) => { enqueueRouterCommand(s, { action: "disconnect_device", targetId: "device-1" }, now); });
  time += 40_000;
  await processor.run();
  // Requeued later: delivery is measured from the requeue, not the original queuing.
  time += 3_600_000;
  await store.transaction((s) => { enqueueRouterCommand(s, { action: "disconnect_device", targetId: "device-1" }, now); });
  time += 20_000;
  fail = true;
  await processor.run();
  // An operator replay of the dead letter succeeds, but the failure was already counted.
  await store.transaction((s) => { scheduleRouterCommandReplay(s, "router:disconnect_device:device-1", now); });
  fail = false;
  await processor.run();
  assert.deepEqual(seen, [["delivered", "disconnect_device", 40], ["dead", "disconnect_device"]]);
});

test("API request outcomes exclude health and metrics probes", async () => {
  const metrics = createPerformanceMetrics({ enabled: true, token: "m".repeat(40) });
  for (const [path, status] of [["/api/plans", 200], ["/api/health", 503], ["/api/metrics", 200], ["/api/purchase", 500], ["/api/account/login/pin", 401]]) {
    metrics.observe(path, status, 0.1);
  }
  assert.equal(await value(metrics.registry, "ndahi_api_requests_total", { outcome: "success" }), 1);
  assert.equal(await value(metrics.registry, "ndahi_api_requests_total", { outcome: "server_error" }), 1);
  assert.equal(await value(metrics.registry, "ndahi_api_requests_total", { outcome: "client_error" }), 1);
});

test("the SLO report summarizes attainment, budget and status for the monthly review", async () => {
  const requests = [];
  const results = {
    "ndahi:slo_objective:ratio": [
      [{ slo: "availability", responder: "platform-on-call" }, "0.995"],
      [{ slo: "payment_completion", responder: "payments-owner" }, "0.99"],
      [{ slo: "voucher_provisioning", responder: "network-operations" }, "0.99"],
    ],
    "ndahi:slo_error_ratio:rate30d": [
      [{ slo: "availability", instance: "https://portal.ndahiconnect.net/login" }, "0.001"],
      [{ slo: "availability", instance: "https://api.ndahiconnect.net/api/health" }, "0.02"],
      [{ slo: "payment_completion" }, "0.008"],
      [{ slo: "voucher_provisioning" }, "NaN"],
    ],
    "ndahi:slo_error_budget_remaining:ratio30d": [
      [{ slo: "availability", instance: "https://portal.ndahiconnect.net/login", responder: "platform-on-call" }, "0.8"],
      [{ slo: "availability", instance: "https://api.ndahiconnect.net/api/health", responder: "platform-on-call" }, "-3"],
      [{ slo: "payment_completion", responder: "payments-owner" }, "0.2"],
    ],
    "ndahi:slo_events:increase30d": [
      [{ slo: "availability", instance: "https://portal.ndahiconnect.net/login" }, "43200"],
      [{ slo: "availability", instance: "https://api.ndahiconnect.net/api/health" }, "43200"],
      [{ slo: "payment_completion" }, "1250.4"],
    ],
  };
  const request = async (url, init) => {
    requests.push({ url: String(url), headers: init.headers });
    const result = results[url.searchParams.get("query")].map(([metric, v]) => ({ metric, value: [0, v] }));
    return Response.json({ status: "success", data: { resultType: "vector", result } });
  };
  const report = await sloReport({ prometheusUrl: "https://prometheus.ndahi.test/", token: "secret-token", request, now: new Date("2026-11-01T09:00:00Z") });
  assert.equal(report, [
    "30-day service levels ending 2026-11-01 09:00 UTC",
    "",
    "| Objective | Target | Achieved | Budget left | Events | Status | Owner |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| availability (https://api.ndahiconnect.net/api/health) | 99.5% | 98.00% | -300% | 43200 | missed | platform-on-call |",
    "| availability (https://portal.ndahiconnect.net/login) | 99.5% | 99.90% | 80% | 43200 | met | platform-on-call |",
    "| payment_completion | 99.0% | 99.20% | 20% | 1250 | at risk | payments-owner |",
    "| voucher_provisioning | 99.0% | — | — | 0 | no data | network-operations |",
  ].join("\n"));
  assert.equal(requests.length, 4);
  assert.ok(requests.every((r) => r.url.startsWith("https://prometheus.ndahi.test/api/v1/query?") && r.headers.authorization === "Bearer secret-token"));
  assert.ok(!report.includes("secret-token"));
  await assert.rejects(sloReport({ prometheusUrl: "http://prometheus.ndahi.test", request }), /HTTPS/);
  await assert.rejects(sloReport({ prometheusUrl: "http://localhost:9090", request: async () => Response.json({ status: "error" }, { status: 400 }) }), /query failed \(400\)/);
  assert.equal(sloStatus({ errorRatio: 0, budget: 1, events: 0 }), "no data");
});


test("SLO reports do not mark incomplete recording-rule data as met", () => {
  assert.equal(sloStatus({ errorRatio: 0, events: 10 }), "no data");
  assert.equal(sloStatus({ errorRatio: 0, budget: NaN, events: 10 }), "no data");
});
