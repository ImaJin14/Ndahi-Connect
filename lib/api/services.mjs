import argon2 from "argon2";
import { createPerformanceMetrics } from "../performance.mjs";
import { assertProductionConfig, enabledPaymentProviders } from "../config.mjs";
import { createPostgresStore } from "../postgres-store.mjs";
import {
  blank,
  createStore,
  ensureState,
  clean,
  sec,
  findPlan,
  log,
  view,
  purchasablePlan,
  dailyEligibleAt,
  uniqueActivationCode,
  GB,
  phone,
} from "./state.mjs";
import { paymentAdapters } from "../payments.mjs";
import { savedRouterAdapter } from "../network-runtime.mjs";
import { routerAdapter } from "../routeros.mjs";
import { omadaAdapter } from "../omada.mjs";
import { emailAdapter } from "../email.mjs";
import { secureToken, hashSecret, safeEqual } from "../security.mjs";
import { queueSecurityAlert, createSecurityAlertService } from "../security-alerts.mjs";
import { cookies, ip, json, cookie, deferResponse } from "./http.mjs";
import { randomUUID } from "node:crypto";
import { ensureReceipt, createBillingService } from "../billing.mjs";
import { enqueueRouterCommand, createRouterCommandProcessor } from "../router-queue.mjs";
import { createWebhookProcessor } from "../payment-webhooks.mjs";
import { databaseDiagnostic } from "../database-diagnostics.mjs";
import { createNetworkSetup } from "../network-setup.mjs";
import { OmadaProvisioner } from "../network-omada.mjs";
import { createLogger, errorFields } from "../logger.mjs";
import { withCorrelation } from "../correlation.mjs";
export function createServices(opts = {}) {
  const env = { ...process.env, ...opts.env },
    bootstrapMode = env.BOOTSTRAP_MODE === "true";
  if (opts.validateConfig !== false && !bootstrapMode) assertProductionConfig(env);
  const logger = opts.logger || createLogger({ service: "api", level: env.LOG_LEVEL });
  const store =
      opts.store ||
      (env.DATABASE_URL
        ? createPostgresStore({
            connectionString: env.DATABASE_URL,
            initialState: blank,
            ssl: env.DATABASE_SSL !== "false",
          })
        : createStore()),
    pays = opts.payments || paymentAdapters(env),
    paymentProviders = enabledPaymentProviders(env).filter(
      (provider) =>
        provider === "mock" ||
        typeof pays[provider]?.configured !== "function" ||
        pays[provider].configured(),
    ),
    router = opts.router || savedRouterAdapter({ store, env, fallback: routerAdapter(env) }),
    omada = opts.omada || omadaAdapter(env),
    email = opts.email || emailAdapter(env),
    clock = opts.now || (() => new Date()),
    customerSecret =
      env.CUSTOMER_SESSION_SECRET || env.SECRET_PEPPER || "development-customer-secret",
    previousCustomerSecret = env.CUSTOMER_SESSION_SECRET_PREVIOUS || "",
    adminSecret = env.ADMIN_SESSION_SECRET || env.SECRET_PEPPER || "development-admin-secret",
    previousAdminSecret = env.ADMIN_SESSION_SECRET_PREVIOUS || "",
    pepper = env.SECRET_PEPPER || "development-only-pepper",
    previousPepper = env.SECRET_PEPPER_PREVIOUS || "",
    adminBootstrapCredential =
      env.ADMIN_BOOTSTRAP_PASSWORD ||
      env.ADMIN_PIN ||
      (env.NODE_ENV === "production" ? secureToken() : "2468"),
    generic = "Unable to verify those credentials. Check the details and try again.",
    customerOrigin = env.CUSTOMER_APP_URL || "http://localhost:8080",
    adminOrigins = new Set(
      String(env.ALLOWED_ADMIN_ORIGINS || env.ADMIN_APP_URL || "http://localhost:8081")
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
    secureCookies = env.SESSION_COOKIE_SECURE
      ? env.SESSION_COOKIE_SECURE !== "false"
      : env.NODE_ENV === "production",
    adminOrigin = env.ADMIN_APP_URL || "http://localhost:8081",
    rpID = env.WEBAUTHN_RP_ID || new URL(adminOrigin).hostname,
    rpName = env.WEBAUTHN_RP_NAME || "NDAHI Connect Admin",
    customerRpID = env.CUSTOMER_WEBAUTHN_RP_ID || new URL(customerOrigin).hostname,
    customerRpName = env.CUSTOMER_WEBAUTHN_RP_NAME || "NDAHI Connect";
  // The bootstrap owner password is kept only as an Argon2id hash, created on first use.
  let bootstrapHash;
  const verifyBootstrapCredential = async (value) => {
    bootstrapHash ??= argon2.hash(adminBootstrapCredential, { type: argon2.argon2id });
    return argon2.verify(await bootstrapHash, String(value || ""));
  };
  const positiveInteger = (value, fallback) => {
      const parsed = Number.parseInt(value, 10);
      return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
    },
    edgeWindowMs = positiveInteger(env.AUTH_EDGE_WINDOW_SECONDS, 900) * 1000,
    edgeLimits = {
      "customer-auth": positiveInteger(env.AUTH_EDGE_CUSTOMER_MAX, 300),
      "pin-reset": positiveInteger(env.AUTH_EDGE_RESET_MAX, 20),
      "admin-auth": positiveInteger(env.AUTH_EDGE_ADMIN_MAX, 30),
    };
  // Pass `scope` (customer keys) to run concurrently with other customers'
  // transactions; such callbacks may be retried, so any response they write must
  // go through `res`, which is buffered until the transaction commits.
  const mutate = (fn, { res, scope, scopeFrom } = {}) => {
      const deferred = res && deferResponse(res);
      const run = store.transaction(async (s) => {
        deferred?.reset();
        ensureState(s);
        clean(s, clock());
        return fn(s);
      }, scope === undefined ? undefined : { scope, scopeFrom });
      return deferred
        ? run.then((value) => { deferred.flush(); return value; }, (error) => { deferred.discard(); throw error; })
        : run;
    },
    customerScope = (value) => [`customer:${phone(value)}`],
    // Resolve the signed-in customer's scope from their session cookie.
    sessionScope = (req) => ({
      scopeFrom: ["dashboardSessions", "customers"],
      scope: (s) => {
        const session = auth(req, s, "dashboardSessions"),
          customer = session && s.customers.find((x) => x.id === session.customerId);
        return customer ? customerScope(customer.phone) : [];
      },
    }),
    pinThrottle = (customer) => {
      if (!customer) return null;
      const now = clock(),
        lockedUntil = customer.pinLockedUntil && new Date(customer.pinLockedUntil),
        nextAttemptAt = customer.pinNextAttemptAt && new Date(customer.pinNextAttemptAt);
      if (lockedUntil && lockedUntil > now) {
        return {
          locked: true,
          retryAfterSeconds: Math.max(1, Math.ceil((lockedUntil - now) / 1000)),
        };
      }
      if (lockedUntil) {
        customer.pinFailedAttempts = 0;
        delete customer.pinLockedUntil;
        delete customer.pinNextAttemptAt;
      }
      if (nextAttemptAt && nextAttemptAt > now) {
        return {
          locked: false,
          retryAfterSeconds: Math.max(1, Math.ceil((nextAttemptAt - now) / 1000)),
        };
      }
      return null;
    },
    recordPinFailure = (s, customer, req, ph) => {
      if (!customer) {
        sec(s, "customer.pin.failed", req, { phone: ph });
        return { attemptsRemaining: 0 };
      }
      customer.pinFailedAttempts = Number(customer.pinFailedAttempts || 0) + 1;
      const attemptsRemaining = Math.max(0, 5 - customer.pinFailedAttempts);
      if (!attemptsRemaining) {
        const lockSeconds = positiveInteger(env.PIN_LOCK_SECONDS, 900);
        customer.pinLockedUntil = new Date(clock().getTime() + lockSeconds * 1000).toISOString();
        delete customer.pinNextAttemptAt;
        sec(s, "customer.pin.locked", req, {
          customerId: customer.id,
          severity: "high",
          lockedUntil: customer.pinLockedUntil,
        });
        queueSecurityAlert(
          s,
          {
            customerId: customer.id,
            kind: "pin_locked",
            subject: "Your NDAHI Connect PIN sign-in was temporarily locked",
            lines: [
              "Several incorrect PIN attempts locked PIN sign-in to your account for a short time.",
              "You can still sign in with a passkey or your authenticator app.",
            ],
          },
          clock(),
        );
        return { attemptsRemaining, locked: true, retryAfterSeconds: lockSeconds };
      }
      const delaySeconds = Math.min(
        positiveInteger(env.PIN_MAX_DELAY_SECONDS, 60),
        2 ** (customer.pinFailedAttempts - 1),
      );
      customer.pinNextAttemptAt = new Date(clock().getTime() + delaySeconds * 1000).toISOString();
      sec(s, "customer.pin.failed", req, {
        phone: ph,
        customerId: customer.id,
        attemptsRemaining,
        delaySeconds,
      });
      return { attemptsRemaining, locked: false, retryAfterSeconds: delaySeconds };
    },
    clearPinFailures = (customer) => {
      customer.pinFailedAttempts = 0;
      delete customer.pinNextAttemptAt;
      delete customer.pinLockedUntil;
    },
    matchesRotatingHash = (value, storedHash, currentSecret, previousSecret) =>
      safeEqual(storedHash, hashSecret(value, currentSecret)) ||
      (Boolean(previousSecret) && safeEqual(storedHash, hashSecret(value, previousSecret))),
    auth = (req, s, type) => {
      const customer = type === "dashboardSessions",
        name = customer ? "customer_session" : "admin_session",
        secret = customer ? customerSecret : adminSecret,
        previousSecret = customer ? previousCustomerSecret : previousAdminSecret,
        token = cookies(req)[name];
      if (!token) return;
      return s[type].find(
        (x) =>
          matchesRotatingHash(token, x.tokenHash, secret, previousSecret) &&
          new Date(x.expiresAt) > clock(),
      );
    },
    userAgentOf = (req) => String(req.headers?.["user-agent"] || "").slice(0, 200),
    issueCustomerSession = (s, customerId, res, req) => {
      const token = secureToken(),
        csrfToken = secureToken(),
        seconds = Number(env.CUSTOMER_SESSION_SECONDS || 1800),
        now = clock().toISOString(),
        expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
      s.dashboardSessions.push({
        id: randomUUID(),
        tokenHash: hashSecret(token, customerSecret),
        customerId,
        role: "customer",
        csrfToken,
        expiresAt,
        createdAt: now,
        lastSeenAt: now,
        ip: req ? ip(req) : undefined,
        userAgent: req ? userAgentOf(req) : undefined,
      });
      return json(
        res,
        200,
        { authenticated: true, expiresAt },
        {
          "set-cookie": cookie("customer_session", token, seconds, secureCookies),
        },
      );
    },
    refreshCustomerSession = (req, res, session) => {
      const token = cookies(req).customer_session;
      if (!token || !session) return;
      const seconds = Number(env.CUSTOMER_SESSION_SECONDS || 1800);
      session.tokenHash = hashSecret(token, customerSecret);
      session.expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
      session.lastSeenAt = clock().toISOString();
      res.setHeader("set-cookie", cookie("customer_session", token, seconds, secureCookies));
    };
  async function deliverVoucherEmail(s, voucher, force = false) {
    const customer = s.customers.find((item) => item.id === voucher.customerId),
      payment = s.payments.find((item) => item.id === voucher.paymentId),
      plan = payment?.planSnapshot || findPlan(s, voucher.planId);
    if (voucher.emailStatus === "sent") return true;
    if (!customer?.email || !payment || !plan || !email.configured()) {
      voucher.emailStatus = "pending";
      voucher.emailLastError = !customer?.email
        ? "Customer email is missing."
        : "Email provider is not configured.";
      return false;
    }
    if (!force && voucher.emailNextAttemptAt && new Date(voucher.emailNextAttemptAt) > clock())
      return false;
    voucher.emailAttempts = Number(voucher.emailAttempts || 0) + 1;
    voucher.emailLastAttemptAt = clock().toISOString();
    const outcome = { kind: "voucher", voucherId: voucher.id, paymentId: payment.id, attempts: voucher.emailAttempts };
    try {
      const result = await withCorrelation({ correlationId: payment.correlationId }, async () => {
        const sent = await email.sendVoucher({ customer, payment, plan, voucher });
        logger.info("email.sent", outcome);
        return sent;
      });
      voucher.emailStatus = "sent";
      voucher.emailSentAt = clock().toISOString();
      voucher.emailMessageId = result.messageId;
      delete voucher.emailLastError;
      delete voucher.emailNextAttemptAt;
      log(s, "voucher.email_sent", { voucherId: voucher.id });
      return true;
    } catch (error) {
      withCorrelation({ correlationId: payment.correlationId }, () =>
        logger.warn("email.failed", { ...outcome, ...errorFields(error) }));
      voucher.emailStatus = "failed";
      voucher.emailLastError = String(error.message || "Email delivery failed.").slice(0, 240);
      voucher.emailNextAttemptAt = new Date(
        clock().getTime() + Math.min(30, 2 ** voucher.emailAttempts) * 60000,
      ).toISOString();
      log(s, "voucher.email_failed", { voucherId: voucher.id, attempt: voucher.emailAttempts });
      return false;
    }
  }
  const settlementResult = (status, body) => ({ status, body });
  // Fulfillment, its router command and voucher email belong to the purchase operation,
  // whether settled by a webhook, a background recheck, or the mock confirmation.
  const settlePayment = (s, p, ref) =>
    withCorrelation({ correlationId: p?.correlationId }, () => settleWithinOperation(s, p, ref));
  async function settleWithinOperation(s, p, ref) {
    if (!p) return settlementResult(404, { error: "Payment not found." });
    if (["refunded", "refund-pending"].includes(p.status)) {
      return settlementResult(409, { error: "Refunded payments cannot be fulfilled again." });
    }
    const old = s.vouchers.find((v) => v.paymentId === p.id);
    if (old) {
      if (old.emailStatus !== "sent" && Number(old.emailAttempts || 0) < 5)
        await deliverVoucherEmail(s, old);
      return settlementResult(200, {
        idempotent: true,
        payment: { id: p.id, status: p.status },
        voucher: view(old, s),
        access: { code: old.code },
      });
    }
    if (ref && s.payments.some((x) => x.id !== p.id && x.providerReference === ref)) {
      return settlementResult(409, {
        error: "Duplicate provider transaction reference.",
      });
    }
    p.status = "paid";
    p.confirmedAt ||= clock().toISOString();
    if (ref) p.providerReference = ref;
    ensureReceipt(p, findPlan(s, p.planId));
    const c = s.customers.find((x) => x.id === p.customerId),
      plan = p.planSnapshot || purchasablePlan(s, p.planId);
    if (!c || !plan) {
      p.fulfillmentStatus = "needs_review";
      p.failureReason = "Payment received; package activation needs support review.";
      return settlementResult(409, { error: p.failureReason });
    }
    const activeVoucher = s.vouchers.find((v) => v.customerId === c.id && v.status === "active");
    if (
      activeVoucher &&
      activeVoucher.id !== p.replaceVoucherId &&
      activeVoucher.id !== p.upgradeFromVoucherId
    ) {
      p.fulfillmentStatus = "needs_review";
      return settlementResult(409, {
        error: "Your current bundle still has quota. Bundles cannot be stacked.",
      });
    }
    if (plan.id === "daily") {
      const eligibleAt = dailyEligibleAt(s, c.id, p.id);
      if (eligibleAt && eligibleAt > clock()) {
        p.fulfillmentStatus = "needs_review";
        p.failureReason = `Daily is available again on ${eligibleAt.toISOString()}.`;
        return settlementResult(409, {
          error: p.failureReason,
          nextEligibleAt: eligibleAt.toISOString(),
        });
      }
    }
    if (activeVoucher) {
      activeVoucher.status = p.action === "renew" ? "renewed" : "switched";
      activeVoucher.replacedAt = clock().toISOString();
      activeVoucher.replacedByPaymentId = p.id;
      enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: activeVoucher.id }, clock);
      activeVoucher.routerSyncStatus = "pending";
      log(s, "voucher.replaced", {
        voucherId: activeVoucher.id,
        paymentId: p.id,
        newPlanId: plan.id,
      });
    }
    p.status = "paid";
    p.fulfillmentStatus = "fulfilled";
    p.confirmedAt ||= clock().toISOString();
    if (ref) p.providerReference = ref;
    const t = clock().getTime(),
      v = {
        id: randomUUID(),
        paymentId: p.id,
        customerId: c.id,
        planId: plan.id,
        code: uniqueActivationCode(s),
        status: "active",
        activatedAt: new Date(t).toISOString(),
        expiresAt: new Date(t + plan.validityHours * 36e5).toISOString(),
        quotaBytes: plan.quotaGb === null ? null : plan.quotaGb * GB,
        usedBytes: 0,
        deviceLimit: plan.deviceLimit,
        emailStatus: "pending",
        emailAttempts: 0,
      };
    s.vouchers.unshift(v);
    log(s, "voucher.activated", { voucherId: v.id, plan: plan.name });
    logger.info("payment.settled", { paymentId: p.id, voucherId: v.id, provider: p.provider });
    enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, clock);
    v.routerSyncStatus = "pending";
    await deliverVoucherEmail(s, v, true);
    return settlementResult(200, {
      payment: { id: p.id, status: p.status },
      voucher: view(v, s),
      access: {
        ssid: "NDAHI Connect",
        code: v.code,
        message: "Activation code created. Keep it private and enter it on the portal.",
      },
    });
  }
  async function complete(s, p, ref, res) {
    const response = await settlePayment(s, p, ref);
    return json(res, response.status, response.body);
  }
  const billing = createBillingService({
    store,
    payments: pays,
    email,
    now: clock,
    planFor: findPlan,
    logger,
    settle: (s, p, ref) => {
      clean(s, clock());
      return settlePayment(s, p, ref);
    },
  });
  const securityAlerts = createSecurityAlertService({ store, email, now: clock, logger });
  const webhookProcessor = createWebhookProcessor({
    store,
    payments: pays,
    now: clock,
    logger,
    settle: (s, p, ref) => {
      clean(s, clock());
      return settlePayment(s, p, ref);
    },
  });
  let healthProbe;
  const checkHealth = () => {
    // Coalesce concurrent probes, and never put readiness on the write queue.
    if (!healthProbe)
      healthProbe = Promise.resolve()
        .then(() => (store.healthCheck ? store.healthCheck() : store.snapshot()))
        .finally(() => {
          healthProbe = undefined;
        });
    return healthProbe;
  };
  let lastHealthFailure;
  const boundedHealthCheck = async () => {
    let timer;
    try {
      await Promise.race([
        checkHealth(),
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(Object.assign(Error("Health check timed out"), { code: "HEALTH_TIMEOUT" })),
            4000,
          );
        }),
      ]);
      lastHealthFailure = undefined;
    } catch (error) {
      // Emit only known diagnostic codes, never connection strings or SQL errors.
      const diagnostic = databaseDiagnostic(error),
        code = diagnostic.code;
      if (lastHealthFailure !== code) logger.error("api.readiness_failed", diagnostic);
      lastHealthFailure = code;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  const routerProcessor = createRouterCommandProcessor({
    store,
    router,
    now: clock,
    maxAttempts: positiveInteger(env.NETWORK_QUEUE_MAX_ATTEMPTS, 8),
    alertWebhookUrl: env.NETWORK_ALERT_WEBHOOK_URL || undefined,
    logger,
  });
  const performanceMetrics = opts.performanceMetrics || createPerformanceMetrics({
    enabled: env.PERFORMANCE_METRICS_ENABLED === "true",
    token: env.METRICS_BEARER_TOKEN || "",
  });
  const networkSetup = createNetworkSetup({
    store,
    env,
    now: clock,
    routerFactory: opts.networkRouterFactory,
    omadaFactory: (connection) =>
      opts.networkOmadaFactory?.(connection) ||
      new OmadaProvisioner(connection, {
        profile: env.OMADA_PROVISIONING_PROFILE
          ? JSON.parse(env.OMADA_PROVISIONING_PROFILE)
          : undefined,
      }),
  });

  return {
    verifyBootstrapCredential,
    adminOrigin,
    adminOrigins,
    adminSecret,
    auth,
    billing,
    bootstrapMode,
    boundedHealthCheck,
    clearPinFailures,
    clock,
    complete,
    customerOrigin,
    customerRpID,
    customerRpName,
    customerScope,
    customerSecret,
    deliverVoucherEmail,
    edgeLimits,
    edgeWindowMs,
    email,
    env,
    generic,
    issueCustomerSession,
    logger,
    matchesRotatingHash,
    mutate,
    networkSetup,
    omada,
    paymentProviders,
    pays,
    pepper,
    performanceMetrics,
    pinThrottle,
    positiveInteger,
    previousAdminSecret,
    previousCustomerSecret,
    previousPepper,
    recordPinFailure,
    refreshCustomerSession,
    router,
    routerProcessor,
    rpID,
    rpName,
    secureCookies,
    sessionScope,
    securityAlerts,
    store,
    webhookProcessor,
  };
}
