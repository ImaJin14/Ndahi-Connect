import { createServices } from "./lib/api/services.mjs";
import { NOT_HANDLED } from "./lib/api/routing.mjs";
import { createMiddleware } from "./lib/api/middleware.mjs";
import { createPerformanceRoutes } from "./lib/api/performance.mjs";
import { createPublicRoutes } from "./lib/api/public.mjs";
import { createPaymentRoutes } from "./lib/api/payments.mjs";
import { createVoucherRoutes } from "./lib/api/vouchers.mjs";
import { createCustomerAuthRoutes } from "./lib/api/customer-auth.mjs";
import { createAccountRoutes } from "./lib/api/account.mjs";
import { createAdminAuthRoutes } from "./lib/api/admin-auth.mjs";
import { createAdminRoutes } from "./lib/api/admin.mjs";
import { json, resolveClientIp, routeLabel } from "./lib/api/http.mjs";
import { reconciliationConfig, createPaymentReconciler } from "./lib/payment-reconciliation.mjs";
import {
  routerReconciliationConfig,
  createRouterReconciler,
} from "./lib/router-reconciliation.mjs";
import http from "node:http";
import { databaseDiagnostic } from "./lib/database-diagnostics.mjs";
import { randomUUID } from "node:crypto";
import { createLogger, errorFields } from "./lib/logger.mjs";
import { withCorrelation } from "./lib/correlation.mjs";
import { fileURLToPath } from "node:url";
import { normalize } from "node:path";
import { assertProductionConfig } from "./lib/config.mjs";
export {
  plans,
  blank,
  ensureState,
  createStore,
  authEdgeScopes,
  customerCsrfPaths,
} from "./lib/api/state.mjs";
export { resolveClientIp } from "./lib/api/http.mjs";
export function createHandler(opts = {}) {
  const context = createServices(opts);
  const {
    env,
    billing,
    securityAlerts,
    webhookProcessor,
    store,
    pays,
    clock,
    networkSetup,
    routerProcessor,
    positiveInteger,
    router,
    logger,
  } = context;
  const routes = [
    createMiddleware(context),
    createPerformanceRoutes(context),
    createPublicRoutes(context),
    createPaymentRoutes(context),
    createVoucherRoutes(context),
    createCustomerAuthRoutes(context),
    createAccountRoutes(context),
    createAdminAuthRoutes(context),
    createAdminRoutes(context),
  ];
  async function api(req, res, url) {
    for (const route of routes) if ((await route(req, res, url)) !== NOT_HANDLED) return;
    return json(res, 404, { error: "Not found." });
  }

  // Routine probes would drown out request logs; failures are still logged.
  const quietRoutes = new Set(["/api/health", "/api/metrics"]);
  // Each request starts a new customer operation; work it triggers inherits its IDs.
  const handler = (req, res) => {
    req.requestId = randomUUID();
    res.setHeader("x-request-id", req.requestId);
    return withCorrelation({ requestId: req.requestId, correlationId: req.requestId }, () => handle(req, res));
  };
  const handle = async (req, res) => {
    const started = performance.now();
    let requestPath = "";
    try {
      req.clientIp = resolveClientIp(req, env);
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      requestPath = url.pathname;
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      return json(res, 404, {
        error: "The API server does not serve application pages.",
      });
    } catch (e) {
      if (!["Request too large", "Invalid JSON"].includes(e.message)) {
        logger.error("http.unhandled_error", { route: routeLabel(requestPath), ...errorFields(e) });
      }
      if (!res.headersSent) {
        json(res, e.message === "Request too large" ? 413 : 400, {
          error: e.message,
        });
      } else res.end();
    } finally {
      const durationMs = performance.now() - started,
        status = res.statusCode || 200;
      context.performanceMetrics.observe(requestPath, status, durationMs / 1000);
      if (status >= 400 || !quietRoutes.has(requestPath)) {
        logger[status >= 500 ? "error" : "info"]("http.request", {
          method: req.method,
          route: routeLabel(requestPath),
          status,
          durationMs: Math.round(durationMs * 10) / 10,
        });
      }
    }
  };
  handler.billing = billing;
  handler.logger = logger;
  handler.billingEnabled = env.BILLING_WORKER_ENABLED !== "false";
  handler.securityAlerts = securityAlerts;
  handler.securityAlertsEnabled = env.SECURITY_ALERTS_ENABLED !== "false";
  handler.webhookProcessor = webhookProcessor;
  handler.webhookReplayEnabled = env.PAYMENT_WEBHOOK_REPLAY_ENABLED !== "false";
  handler.reconciliationConfig = reconciliationConfig(env);
  handler.reconcilePayments = createPaymentReconciler({
    store,
    payments: pays,
    now: clock,
    ...handler.reconciliationConfig,
  });
  handler.networkSetup = networkSetup;
  handler.networkSetupEnabled = Boolean(env.NETWORK_CONFIG_KEY);
  handler.routerProcessor = routerProcessor;
  handler.routerQueueEnabled = env.NETWORK_QUEUE_ENABLED !== "false";
  handler.routerQueueIntervalMs = positiveInteger(env.NETWORK_QUEUE_INTERVAL_SECONDS, 15) * 1000;
  handler.routerReconciliationConfig = routerReconciliationConfig(env);
  handler.reconcileRouter = createRouterReconciler({ store, router, now: clock });
  return handler;
}

export const createServer = (opts) => {
  const handler = createHandler(opts),
    server = http.createServer(handler);
  let timer,
    webhookTimer,
    routerTimer,
    routerReconciliationTimer,
    billingTimer,
    securityAlertsTimer,
    networkSetupTimer;
  const runBilling = () =>
    handler.billing.run().catch((error) => {
      handler.logger.error("billing.worker_failed", databaseDiagnostic(error));
    });
  const runSecurityAlerts = () =>
    handler.securityAlerts.run().catch((error) => {
      handler.logger.error("security_alerts.worker_failed", databaseDiagnostic(error));
    });
  const runWebhooks = () =>
    handler.webhookProcessor.run().catch((error) => {
      handler.logger.error("payment.webhook_worker_failed", databaseDiagnostic(error));
    });
  const run = () =>
    handler.reconcilePayments().catch((error) => {
      handler.logger.error("payment.reconciliation_failed", databaseDiagnostic(error));
    });
  const runRouterQueue = () =>
    handler.routerProcessor.run().catch((error) => {
      handler.logger.error("network.command_worker_failed", databaseDiagnostic(error));
    });
  const runRouterReconciliation = () =>
    handler.reconcileRouter().catch((error) => {
      handler.logger.error("network.reconciliation_failed", databaseDiagnostic(error));
    });
  const resumeNetworkSetup = () =>
    handler.networkSetup.handle("status", {}, "system").catch(() => {
      handler.logger.error("network.setup_worker_failed");
    });
  server.on("listening", () => {
    if (handler.networkSetupEnabled) {
      void resumeNetworkSetup();
      networkSetupTimer = setInterval(resumeNetworkSetup, 30000);
      networkSetupTimer.unref();
    }
    if (handler.billingEnabled) {
      billingTimer = setInterval(runBilling, 30000);
      billingTimer.unref();
    }
    if (handler.securityAlertsEnabled) {
      securityAlertsTimer = setInterval(runSecurityAlerts, 30000);
      securityAlertsTimer.unref();
    }
    if (handler.webhookReplayEnabled) {
      void runWebhooks();
      webhookTimer = setInterval(runWebhooks, 30000);
      webhookTimer.unref();
    }
    if (handler.routerQueueEnabled) {
      void runRouterQueue();
      routerTimer = setInterval(runRouterQueue, handler.routerQueueIntervalMs);
      routerTimer.unref();
    }
    if (handler.routerReconciliationConfig.enabled) {
      void runRouterReconciliation();
      routerReconciliationTimer = setInterval(
        runRouterReconciliation,
        handler.routerReconciliationConfig.intervalMs,
      );
      routerReconciliationTimer.unref();
    }
    if (!handler.reconciliationConfig.enabled) return;
    void run();
    timer = setInterval(run, handler.reconciliationConfig.intervalMs);
    timer.unref();
  });
  server.on("close", () => {
    clearInterval(networkSetupTimer);
    clearInterval(billingTimer);
    clearInterval(timer);
    clearInterval(webhookTimer);
    clearInterval(routerTimer);
    clearInterval(routerReconciliationTimer);
    clearInterval(securityAlertsTimer);
  });
  return server;
};
const main = process.argv[1] && fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  if (process.env.BOOTSTRAP_MODE !== "true") assertProductionConfig(process.env);
  const port = Number(process.env.PORT || process.env.API_PORT || 8082);
  const host = process.env.HOST || "0.0.0.0";
  createServer().listen(port, host, () =>
    createLogger({ service: "api", level: process.env.LOG_LEVEL }).info("api.listening", {
      host,
      port,
      node: process.version,
      commit: process.env.RENDER_GIT_COMMIT || "local",
      healthPath: "/api/health",
    }),
  );
}
