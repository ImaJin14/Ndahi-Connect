import client from "@prometheus-io/client";
import { silentLogger, errorFields } from "./logger.mjs";

// Service health metrics for dashboards and alerts (OBS-004). They share the
// /api/metrics registry with the PERF-001 latency metrics.

// Adapter methods that reach an external dependency. Webhook signature checks are
// excluded because a rejected signature reflects the caller, not the provider.
export const dependencyMethods = {
  payment: ["createPayment", "verifyPayment", "refundPayment", "verifyRefund"],
  email: ["sendVoucher", "sendReceipt", "sendSecurityAlert", "sendPinReset"],
  router: ["syncVoucher", "disconnectVoucher", "disconnectDevice", "markInactive", "readUsage", "readState"],
  omada: ["status"],
};
// The monitor reads only these collections, skipping large customer and voucher tables.
export const monitoredCollections = ["payments", "providerEvents", "routerCommands", "securityAlerts"];
const queues = ["payments", "payment_webhooks", "network_commands", "security_alerts"];
const attentionReasons = ["needs_review", "uncertain", "verification_error", "refund_requested", "refund_pending"];

const metric = (registry, Type, config) =>
  registry.getSingleMetric(config.name) || new Type({ ...config, registers: [registry] });
const age = (now, ...stamps) => {
  const started = Math.max(...stamps.map((value) => Date.parse(value)).filter(Number.isFinite));
  return Number.isFinite(started) ? Math.max(0, (now - started) / 1000) : 0;
};

// Pending work, its oldest age, and items that stopped retrying, per queue.
export function queueStats(state, now = Date.now()) {
  const stats = Object.fromEntries(queues.map((queue) => [queue, { pending: 0, oldestSeconds: 0, deadLetters: 0 }]));
  const add = (queue, seconds) => {
    stats[queue].pending++;
    stats[queue].oldestSeconds = Math.max(stats[queue].oldestSeconds, seconds);
  };
  const attention = Object.fromEntries(attentionReasons.map((reason) => [reason, 0]));
  for (const p of state.payments || []) {
    if (["pending", "processing"].includes(p.status) && !p.confirmedAt) add("payments", age(now, p.createdAt));
    if (p.fulfillmentStatus === "needs_review") attention.needs_review++;
    if (p.creationState === "uncertain") attention.uncertain++;
    if (p.verificationError && !p.confirmedAt) attention.verification_error++;
    if (p.refund?.status === "requested") attention.refund_requested++;
    if (p.refund?.status === "pending") attention.refund_pending++;
  }
  for (const [queue, items] of [["payment_webhooks", state.providerEvents], ["network_commands", state.routerCommands]]) {
    for (const item of items || []) {
      if (["queued", "retry", "processing"].includes(item.status)) add(queue, age(now, item.at, item.queuedAt, item.replayedAt));
      if (item.status === "dead_letter") stats[queue].deadLetters++;
    }
  }
  for (const alert of state.securityAlerts || []) {
    if (alert.status === "pending") add("security_alerts", age(now, alert.at));
    if (alert.status === "failed") stats.security_alerts.deadLetters++;
  }
  return { queues: stats, attention };
}

export function createServiceMetrics({ registry, enabled = false }) {
  const calls = metric(registry, client.Counter, {
    name: "ndahi_dependency_calls_total",
    help: "Completed calls to payment, email, router and Omada adapters",
    labelNames: ["dependency", "provider", "operation", "outcome"],
  });
  const databaseUp = metric(registry, client.Gauge, { name: "ndahi_database_up", help: "1 when the last readiness probe reached PostgreSQL" });
  const pending = metric(registry, client.Gauge, { name: "ndahi_queue_pending", help: "Items waiting to be processed", labelNames: ["queue"] });
  const oldest = metric(registry, client.Gauge, { name: "ndahi_queue_oldest_pending_seconds", help: "Age of the oldest waiting item", labelNames: ["queue"] });
  const deadLetters = metric(registry, client.Gauge, { name: "ndahi_queue_dead_letters", help: "Items that stopped retrying and need an operator", labelNames: ["queue"] });
  const attention = metric(registry, client.Gauge, { name: "ndahi_payments_attention", help: "Payments that need review or are awaiting a provider", labelNames: ["reason"] });
  const bootstrap = metric(registry, client.Gauge, { name: "ndahi_bootstrap_mode", help: "1 while the API is in capability-based bootstrap setup" });
  const sampled = metric(registry, client.Gauge, { name: "ndahi_monitor_last_sample_timestamp_seconds", help: "When queue and payment gauges were last refreshed" });
  const sampleFailures = metric(registry, client.Counter, { name: "ndahi_monitor_sample_failures_total", help: "Failed attempts to refresh queue and payment gauges" });
  // Service-level indicators (OBS-005); bucket boundaries include each objective's threshold.
  const fulfillment = metric(registry, client.Histogram, {
    name: "ndahi_payment_fulfillment_seconds",
    help: "Time from checkout to voucher issue for payments the provider confirmed",
    buckets: [60, 120, 300, 600, 1800, 3600, 21600],
  });
  const fulfillmentFailures = metric(registry, client.Counter, {
    name: "ndahi_payment_fulfillment_failures_total",
    help: "Provider-confirmed payments that could not issue a voucher without review",
    labelNames: ["reason"],
  });
  const delivery = metric(registry, client.Histogram, {
    name: "ndahi_network_command_delivery_seconds",
    help: "Time from queuing a router command to the router applying it",
    labelNames: ["action"],
    buckets: [15, 30, 60, 120, 300, 900, 3600],
  });
  const undelivered = metric(registry, client.Counter, {
    name: "ndahi_network_commands_dead_lettered_total",
    help: "Router commands that stopped retrying",
    labelNames: ["action"],
  });
  if (!enabled) {
    const off = () => {};
    return { enabled, call: off, database: off, sample: off, sampleFailed: off, instrument: (adapter) => adapter,
      fulfilled: off, fulfillmentFailed: off, commandDelivered: off, commandDeadLettered: off };
  }
  const call = (dependency, provider, operation, outcome) => calls.inc({ dependency, provider, operation, outcome });
  return {
    enabled,
    call,
    database: (ok) => databaseUp.set(ok ? 1 : 0),
    sample(state, { now = Date.now(), bootstrapMode = false } = {}) {
      const stats = queueStats(state, now);
      for (const [queue, value] of Object.entries(stats.queues)) {
        pending.set({ queue }, value.pending);
        oldest.set({ queue }, value.oldestSeconds);
        if (queue !== "payments") deadLetters.set({ queue }, value.deadLetters);
      }
      for (const [reason, count] of Object.entries(stats.attention)) attention.set({ reason }, count);
      bootstrap.set(bootstrapMode ? 1 : 0);
      sampled.set(now / 1000);
    },
    sampleFailed: () => sampleFailures.inc(),
    fulfilled: (seconds) => fulfillment.observe(Math.max(0, seconds)),
    fulfillmentFailed: (reason) => fulfillmentFailures.inc({ reason }),
    commandDelivered: (action, seconds) => delivery.observe({ action }, Math.max(0, seconds)),
    commandDeadLettered: (action) => undelivered.inc({ action }),
    // Wraps an adapter so each dependency call records its outcome; other members pass through.
    instrument(adapter, dependency, provider = dependency) {
      if (!adapter) return adapter;
      const methods = new Set(dependencyMethods[dependency]);
      return new Proxy(adapter, {
        get(target, property) {
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          if (!methods.has(property)) return value.bind(target);
          return async (...args) => {
            try {
              const result = await value.apply(target, args);
              call(dependency, provider, property, "success");
              return result;
            } catch (error) {
              call(dependency, provider, property, "failure");
              throw error;
            }
          };
        },
      });
    },
  };
}

// Refreshes queue and payment gauges, and probes Omada every few samples when it is live.
export function createServiceMonitor({ store, metrics, omada, omadaLive = false, bootstrapMode = false,
  now = Date.now, logger = silentLogger, omadaEvery = 5, timeoutMs = 10000 }) {
  let runs = 0, running;
  const bounded = (task) => {
    let timer;
    return Promise.race([task(), new Promise((_, reject) => { timer = setTimeout(() => reject(Error("Monitor timed out")), timeoutMs); })])
      .finally(() => clearTimeout(timer));
  };
  async function sampleOnce() {
    try {
      metrics.sample(await bounded(() => store.snapshot({ only: monitoredCollections })), { now: now(), bootstrapMode });
    } catch (error) {
      metrics.sampleFailed();
      logger.error("monitoring.sample_failed", errorFields(error));
    }
    // The instrumented adapter records the probe's outcome.
    if (omadaLive && runs++ % omadaEvery === 0) await bounded(() => omada.status()).catch(() => {});
  }
  return {
    run() {
      running ??= sampleOnce().finally(() => { running = undefined; });
      return running;
    },
  };
}
