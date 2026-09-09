import http from "node:http";
import { isIP } from "node:net";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, extname, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import { fileURLToPath } from "node:url";
import {
  activationCode,
  hashSecret,
  normalizeActivationCode,
  safeEqual,
  secureToken,
  totpSecret,
  totpUri,
  verifyTotp,
} from "./lib/security.mjs";
import { paymentAdapters } from "./lib/payments.mjs";
import { emailAdapter } from "./lib/email.mjs";
import { routerAdapter } from "./lib/routeros.mjs";
import { omadaAdapter } from "./lib/omada.mjs";
import { createPostgresStore } from "./lib/postgres-store.mjs";
import { assertProductionConfig, enabledPaymentProviders } from "./lib/config.mjs";
const PUB = join(process.cwd(), "public"), GB = 1e9;
const legacyPlans = [
  ["plus", "Connect Plus", 3000, 15, 720, 1],
  ["connect20", "Connect 20", 4000, 20, 720, 2],
].map(([id, name, price, quotaGb, validityHours, deviceLimit]) => ({
  id, name, price, quotaGb, validityHours, deviceLimit, discontinued: true,
}));
export const plans = [
  ["daily", "Daily", 100, 1, 24, 1],
  ["weekly", "Weekly", 500, 5, 168, 1],
  ["monthly", "Monthly", 2000, 10, 720, 1],
  ["connect30", "Connect 30", 5500, 30, 720, 2],
  ["family", "Connect Family", 10000, 50, 720, 3],
  ["connect75", "Connect 75", 12500, 75, 720, 3],
  ["max", "Connect Max", 15000, 100, 720, 4],
  ["unlimited", "Unlimited Home", 30000, null, 720, 6],
].map(([id, name, price, quotaGb, validityHours, deviceLimit]) => ({
  id,
  name,
  price,
  quotaGb,
  validityHours,
  deviceLimit,
  ...(id === "unlimited" ? { fairUse: true } : {}),
}));
export const blank = () => ({
    customers: [],
    payments: [],
    vouchers: [],
    sessions: [],
    dashboardSessions: [],
    adminSessions: [],
    adminUsers: [],
    adminPasskeyChallenges: [],
    customerPasskeyChallenges: [],
    customerMfaChallenges: [],
    customerAccessChallenges: [],
    pinResetChallenges: [],
    adminLoginChallenges: [],
    otpChallenges: [],
    adminMfaChallenges: [],
    securityEvents: [],
    auditLogs: [],
    bundles: [],
    bundleOverrides: {},
    events: [],
    providerEvents: [],
    rateLimitEvents: [],
    adminProfile: { mfaEnabled: false },
    zone: { id: "student-zone-1", status: "online", notes: "" },
  }),
  ensureState = (state) => {
    for (const [key, value] of Object.entries(blank())) {
      if (Array.isArray(value) && !Array.isArray(state[key])) state[key] = [];
    }
    state.bundleOverrides ??= {};
    state.adminProfile ??= { mfaEnabled: false };
    state.zone ??= { id: "student-zone-1", status: "online", notes: "" };
    return state;
  },
  phone = (v) =>
    String(v || "").replace(/[\s()-]/g, "").replace(/^\+?237(?=6)/, ""),
  phoneOk = (v) => /^6\d{8}$/.test(phone(v));
export function resolveClientIp(req, env = process.env) {
  const peer = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (env.TRUST_PROXY !== "render") return peer;
  const forwarded = String(req.headers?.["cf-connecting-ip"] || "").trim();
  return isIP(forwarded) ? forwarded.replace(/^::ffff:/, "") : peer;
}
const ip = (req) => req.clientIp ||
  String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
const log = (s, type, meta = {}) => {
    s.events.unshift({
      id: randomUUID(),
      type,
      meta,
      at: new Date().toISOString(),
    });
    s.events = s.events.slice(0, 500);
  },
  sec = (s, type, req, meta = {}) => {
    s.securityEvents.unshift({
      id: randomUUID(),
      type,
      ip: ip(req),
      meta,
      at: new Date().toISOString(),
    });
    s.securityEvents = s.securityEvents.slice(0, 500);
  };
const audit = (s, action, req, meta = {}) => {
    s.auditLogs.unshift({
      id: randomUUID(),
      action,
      actor: req.adminActor || "system",
      ip: ip(req),
      meta,
      at: new Date().toISOString(),
    });
    s.auditLogs = s.auditLogs.slice(0, 1000);
  },
  cookies = (req) =>
    Object.fromEntries(
      String(req.headers.cookie || "").split(";").map((x) => x.trim()).filter(
        Boolean,
      ).map((x) => {
        const i = x.indexOf("=");
        return [
          decodeURIComponent(x.slice(0, i)),
          decodeURIComponent(x.slice(i + 1)),
        ];
      }),
    ),
  cookie = (name, value, maxAge, secure = true) =>
    `${name}=${encodeURIComponent(value)}; Path=${
      name === "admin_session" ? "/api/admin" : "/api/account"
    }; HttpOnly; SameSite=${name === "admin_session" ? "Strict" : "Lax"}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
const catalogue = (s) => [...plans, ...s.bundles.filter((plan) => plan.discontinued !== true)];
const findPlan = (s, id) => [...plans, ...legacyPlans, ...s.bundles].find((plan) => plan.id === id);
const purchasablePlan = (s, id) => catalogue(s).find((plan) => plan.id === id);
const dailyEligibleAt = (s, customerId) => {
  const last = s.payments.filter((payment) =>
    payment.customerId === customerId && payment.planId === "daily" &&
    payment.status === "paid"
  ).sort((a, b) => +new Date(b.confirmedAt || b.createdAt) - +new Date(a.confirmedAt || a.createdAt))[0];
  return last
    ? new Date(+new Date(last.confirmedAt || last.createdAt) + 7 * 24 * 36e5)
    : null;
};
const uniqueActivationCode = (s) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = activationCode();
    if (!s.vouchers.some((voucher) => voucher.code === code)) return code;
  }
  throw new Error("Unable to allocate a unique activation code");
};
export function createStore(
  { file = join(process.cwd(), "data", "db.json"), persistent = true } = {},
) {
  let state, q = Promise.resolve();
  async function load() {
    if (state) return state;
    state = blank();
    if (persistent) {
      try {
        state = { ...state, ...JSON.parse(await readFile(file, "utf8")) };
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
    for (const [k, v] of Object.entries(blank())) {
      if (Array.isArray(v) && !Array.isArray(state[k])) state[k] = [];
    }
    state.bundleOverrides ??= {};
    for (const plan of plans) {
      if (state.bundleOverrides[plan.id]) {
        Object.assign(plan, state.bundleOverrides[plan.id]);
      }
    }
    return state;
  }
  async function persist(nextState) {
    if (!persistent) return;
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(nextState, null, 2), { mode: 0o600 });
    await rename(tmp, file);
  }
  return {
    load,
    transaction(fn) {
      const out = q.then(async () => {
        const working = structuredClone(await load());
        const value = await fn(working);
        await persist(working);
        state = working;
        return value;
      });
      q = out.catch(() => {});
      return out;
    },
    snapshot: async () => structuredClone(await load()),
  };
}
function clean(s, now, router) {
  const cutoff = now - 600000;
  for (const x of s.sessions) {
    if (x.status === "online" && +new Date(x.lastSeenAt) < cutoff) {
      x.status = "inactive";
      x.disconnectedAt = now.toISOString();
      router.markInactive(x).catch(() => {});
    }
  }
  for (const v of s.vouchers) {
    if (v.status === "active" && new Date(v.expiresAt) <= now) {
      v.status = "expired";
      router.disconnectVoucher(v.id).catch(() => {});
    }
    if (
      v.status === "active" && v.quotaBytes !== null &&
      v.usedBytes >= v.quotaBytes
    ) {
      v.status = "exhausted";
      v.exhaustedAt ??= now.toISOString();
      router.disconnectVoucher(v.id).catch(() => {});
    }
  }
  s.dashboardSessions = s.dashboardSessions.filter((x) =>
    new Date(x.expiresAt) > now
  );
  s.customerAccessChallenges = s.customerAccessChallenges.filter((x) =>
    !x.used && new Date(x.expiresAt) > now
  );
  s.rateLimitEvents = s.rateLimitEvents.filter((x) =>
    new Date(x.at) > new Date(now.getTime() - 24 * 60 * 60_000)
  );
  s.adminSessions = s.adminSessions.filter((x) => new Date(x.expiresAt) > now);
}
function view(v, s, includeCode = false) {
  const sessions = s.sessions.filter((x) =>
      x.voucherId === v.id && x.status === "online"
    ),
    remainingBytes = v.quotaBytes === null
      ? null
      : Math.max(0, v.quotaBytes - v.usedBytes);
  return {
    ...v,
    code: includeCode ? v.code : undefined,
    plan: findPlan(s, v.planId),
    sessions,
    activeDevices: sessions.length,
    remainingBytes,
    usagePercentage: v.quotaBytes === null
      ? null
      : Math.min(100, v.usedBytes / v.quotaBytes * 100),
    eligibleForReactivation: ["expired", "exhausted"].includes(v.status),
  };
}
function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=()",
    "x-frame-options": "DENY",
    ...headers,
  });
  res.end(JSON.stringify(data));
}
async function body(req, raw = false) {
  let x = "";
  for await (const p of req) {
    x += p;
    if (x.length > 1e6) throw Error("Request too large");
  }
  if (raw) return x;
  try {
    return JSON.parse(x || "{}");
  } catch {
    throw Error("Invalid JSON");
  }
}
const bearer = (req) =>
  String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
export const authEdgeScopes = Object.freeze({
  "/api/vouchers/redeem": "customer-auth",
  "/api/account/access/begin": "customer-auth",
  "/api/account/access/complete": "customer-auth",
  "/api/account/setup/pin": "customer-auth",
  "/api/account/login/pin": "customer-auth",
  "/api/account/login/request-authenticator": "customer-auth",
  "/api/account/login/verify-authenticator": "customer-auth",
  "/api/account/passkey/options": "customer-auth",
  "/api/account/passkey/verify": "customer-auth",
  "/api/account/pin-reset/request": "pin-reset",
  "/api/account/pin-reset/confirm": "pin-reset",
  "/api/admin/login": "admin-auth",
  "/api/admin/login/mfa": "admin-auth",
  "/api/admin/passkey/options": "admin-auth",
  "/api/admin/passkey/verify": "admin-auth",
});
export const customerCsrfPaths = Object.freeze({
  "/api/account/plan/purchase": true,
  "/api/account/logout": true,
  "/api/account/security/mfa/enroll": true,
  "/api/account/security/mfa/confirm": true,
  "/api/account/passkeys/options": true,
  "/api/account/passkeys/verify": true,
  "/api/account/devices/disconnect": true,
});
export function createHandler(opts = {}) {
  const env = { ...process.env, ...opts.env },
    bootstrapMode = env.BOOTSTRAP_MODE === "true";
  if (opts.validateConfig !== false && !bootstrapMode) assertProductionConfig(env);
  const store = opts.store ||
      (env.DATABASE_URL
        ? createPostgresStore({
          connectionString: env.DATABASE_URL,
          initialState: blank,
          ssl: env.DATABASE_SSL !== "false",
        })
        : createStore()),
    pays = opts.payments || paymentAdapters(env),
    paymentProviders = enabledPaymentProviders(env).filter((provider) =>
      provider === "mock" || typeof pays[provider]?.configured !== "function" ||
      pays[provider].configured()
    ),
    router = opts.router || routerAdapter(env),
    omada = opts.omada || omadaAdapter(env),
    email = opts.email || emailAdapter(env),
    clock = opts.now || (() => new Date()),
    customerSecret = env.CUSTOMER_SESSION_SECRET || env.SECRET_PEPPER ||
      "development-customer-secret",
    previousCustomerSecret = env.CUSTOMER_SESSION_SECRET_PREVIOUS || "",
    adminSecret = env.ADMIN_SESSION_SECRET || env.SECRET_PEPPER ||
      "development-admin-secret",
    previousAdminSecret = env.ADMIN_SESSION_SECRET_PREVIOUS || "",
    pepper = env.SECRET_PEPPER || "development-only-pepper",
    previousPepper = env.SECRET_PEPPER_PREVIOUS || "",
    adminBootstrapCredential = env.ADMIN_BOOTSTRAP_PASSWORD || env.ADMIN_PIN ||
      (env.NODE_ENV === "production" ? secureToken() : "2468"),
    adminHash = hashSecret(adminBootstrapCredential, adminSecret),
    generic =
      "Unable to verify those credentials. Check the details and try again.",
    customerOrigin = env.CUSTOMER_APP_URL || "http://localhost:8080",
    adminOrigins = new Set(
      String(
        env.ALLOWED_ADMIN_ORIGINS || env.ADMIN_APP_URL ||
          "http://localhost:8081",
      ).split(",").map((x) => x.trim()).filter(Boolean),
    ),
    secureCookies = env.SESSION_COOKIE_SECURE
      ? env.SESSION_COOKIE_SECURE !== "false"
      : env.NODE_ENV === "production",
    adminOrigin = env.ADMIN_APP_URL || "http://localhost:8081",
    rpID = env.WEBAUTHN_RP_ID || new URL(adminOrigin).hostname,
    rpName = env.WEBAUTHN_RP_NAME || "NDAHI Connect Admin",
    customerRpID = env.CUSTOMER_WEBAUTHN_RP_ID ||
      new URL(customerOrigin).hostname,
    customerRpName = env.CUSTOMER_WEBAUTHN_RP_NAME || "NDAHI Connect";
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
  const mutate = (fn) =>
      store.transaction(async (s) => {
        ensureState(s);
        clean(s, clock(), router);
        return fn(s);
      }),
    pinThrottle = (customer) => {
      if (!customer) return null;
      const now = clock(), lockedUntil = customer.pinLockedUntil &&
          new Date(customer.pinLockedUntil),
        nextAttemptAt = customer.pinNextAttemptAt &&
          new Date(customer.pinNextAttemptAt);
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
        customer.pinLockedUntil = new Date(
          clock().getTime() + lockSeconds * 1000,
        ).toISOString();
        delete customer.pinNextAttemptAt;
        sec(s, "customer.pin.locked", req, {
          customerId: customer.id, severity: "high",
          lockedUntil: customer.pinLockedUntil,
        });
        return { attemptsRemaining, locked: true, retryAfterSeconds: lockSeconds };
      }
      const delaySeconds = Math.min(
        positiveInteger(env.PIN_MAX_DELAY_SECONDS, 60),
        2 ** (customer.pinFailedAttempts - 1),
      );
      customer.pinNextAttemptAt = new Date(
        clock().getTime() + delaySeconds * 1000,
      ).toISOString();
      sec(s, "customer.pin.failed", req, {
        phone: ph, customerId: customer.id, attemptsRemaining, delaySeconds,
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
      Boolean(previousSecret) &&
        safeEqual(storedHash, hashSecret(value, previousSecret)),
    auth = (req, s, type) => {
      const customer = type === "dashboardSessions",
        name = customer ? "customer_session" : "admin_session",
        secret = customer ? customerSecret : adminSecret,
        previousSecret = customer ? previousCustomerSecret : previousAdminSecret,
        token = cookies(req)[name];
      if (!token) return;
      return s[type].find((x) =>
        matchesRotatingHash(token, x.tokenHash, secret, previousSecret) &&
        new Date(x.expiresAt) > clock()
      );
    },
    issueCustomerSession = (s, customerId, res) => {
      const token = secureToken(),
        csrfToken = secureToken(),
        seconds = Number(env.CUSTOMER_SESSION_SECONDS || 1800),
        expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
      s.dashboardSessions.push({
        tokenHash: hashSecret(token, customerSecret), customerId,
        role: "customer", csrfToken, expiresAt,
      });
      return json(res, 200, { authenticated: true, expiresAt }, {
        "set-cookie": cookie("customer_session", token, seconds, secureCookies),
      });
    },
    refreshCustomerSession = (req, res, session) => {
      const token = cookies(req).customer_session;
      if (!token || !session) return;
      const seconds = Number(env.CUSTOMER_SESSION_SECONDS || 1800);
      session.tokenHash = hashSecret(token, customerSecret);
      session.expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
      res.setHeader("set-cookie", cookie("customer_session", token, seconds, secureCookies));
    };
  async function deliverVoucherEmail(s, voucher, force = false) {
    const customer = s.customers.find((item) => item.id === voucher.customerId),
      payment = s.payments.find((item) => item.id === voucher.paymentId),
      plan = findPlan(s, voucher.planId);
    if (voucher.emailStatus === "sent") return true;
    if (!customer?.email || !payment || !plan || !email.configured()) {
      voucher.emailStatus = "pending";
      voucher.emailLastError = !customer?.email
        ? "Customer email is missing."
        : "Email provider is not configured.";
      return false;
    }
    if (!force && voucher.emailNextAttemptAt && new Date(voucher.emailNextAttemptAt) > clock()) return false;
    voucher.emailAttempts = Number(voucher.emailAttempts || 0) + 1;
    voucher.emailLastAttemptAt = clock().toISOString();
    try {
      const result = await email.sendVoucher({ customer, payment, plan, voucher });
      voucher.emailStatus = "sent";
      voucher.emailSentAt = clock().toISOString();
      voucher.emailMessageId = result.messageId;
      delete voucher.emailLastError;
      delete voucher.emailNextAttemptAt;
      log(s, "voucher.email_sent", { voucherId: voucher.id });
      return true;
    } catch (error) {
      voucher.emailStatus = "failed";
      voucher.emailLastError = String(error.message || "Email delivery failed.").slice(0, 240);
      voucher.emailNextAttemptAt = new Date(clock().getTime() + Math.min(30, 2 ** voucher.emailAttempts) * 60000).toISOString();
      log(s, "voucher.email_failed", { voucherId: voucher.id, attempt: voucher.emailAttempts });
      return false;
    }
  }
  async function complete(s, p, ref, res) {
    if (!p) return json(res, 404, { error: "Payment not found." });
    const old = s.vouchers.find((v) => v.paymentId === p.id);
    if (p.status === "paid" && old) {
      if (old.emailStatus !== "sent" && Number(old.emailAttempts || 0) < 5) await deliverVoucherEmail(s, old);
      return json(res, 200, {
        idempotent: true,
        payment: { id: p.id, status: p.status },
        voucher: view(old, s),
        access: { code: old.code },
      });
    }
    if (
      ref &&
      s.payments.some((x) => x.id !== p.id && x.providerReference === ref)
    ) {
      return json(res, 409, {
        error: "Duplicate provider transaction reference.",
      });
    }
    const c = s.customers.find((x) => x.id === p.customerId),
      plan = purchasablePlan(s, p.planId);
    if (!c || !plan) {
      p.status = "failed";
      p.failureReason = "This package is no longer available.";
      return json(res, 409, { error: p.failureReason });
    }
    const activeVoucher = s.vouchers.find((v) =>
      v.customerId === c.id && v.status === "active"
    );
    if (activeVoucher && activeVoucher.id !== p.replaceVoucherId &&
      activeVoucher.id !== p.upgradeFromVoucherId) {
      return json(res, 409, {
        error:
          "Your current bundle still has quota. Bundles cannot be stacked.",
      });
    }
    if (plan.id === "daily") {
      const eligibleAt = dailyEligibleAt(s, c.id);
      if (eligibleAt && eligibleAt > clock()) {
        p.status = "failed";
        p.failureReason = `Daily is available again on ${eligibleAt.toISOString()}.`;
        return json(res, 409, {
          error: p.failureReason, nextEligibleAt: eligibleAt.toISOString(),
        });
      }
    }
    if (activeVoucher) {
      activeVoucher.status = p.action === "renew" ? "renewed" : "switched";
      activeVoucher.replacedAt = clock().toISOString();
      activeVoucher.replacedByPaymentId = p.id;
      try {
        await router.disconnectVoucher(activeVoucher.id);
        activeVoucher.routerSyncStatus = "disconnected";
      } catch (error) {
        activeVoucher.routerSyncStatus = "pending";
        activeVoucher.routerError = String(error.message || error).slice(0, 240);
      }
      log(s, "voucher.replaced", {
        voucherId: activeVoucher.id,
        paymentId: p.id,
        newPlanId: plan.id,
      });
    }
    p.status = "paid";
    p.confirmedAt = clock().toISOString();
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
    try {
      await router.syncVoucher(v);
      v.routerSyncStatus = "synchronized";
    } catch (e) {
      v.routerSyncStatus = "pending";
      v.routerError = e.message;
    }
    await deliverVoucherEmail(s, v, true);
    return json(res, 200, {
      payment: { id: p.id, status: p.status },
      voucher: view(v, s),
      access: {
        ssid: "NDAHI Connect",
        code: v.code,
        message:
          "Activation code created. Keep it private and enter it on the portal.",
      },
    });
  }
  async function api(req, res, url) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains; preload");
    res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader("referrer-policy", "no-referrer");
    res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=()");
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("x-content-type-options", "nosniff");
    const origin = req.headers.origin,
      isAdmin = url.pathname.startsWith("/api/admin/");
    if (origin) {
      const allowed = isAdmin
        ? adminOrigins.has(origin)
        : origin === customerOrigin || adminOrigins.has(origin);
      if (!allowed) return json(res, 403, { error: "Origin is not allowed." });
      res.setHeader("access-control-allow-origin", origin);
      res.setHeader("access-control-allow-credentials", "true");
      res.setHeader("vary", "Origin");
      if (req.method === "OPTIONS") {
        res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
        res.setHeader("access-control-allow-headers", "content-type, x-csrf-token");
        res.writeHead(204);
        return res.end();
      }
    }
    const serverToServer = [
      "/api/webhooks/flutterwave", "/api/webhooks/mesomb", "/api/csp-report",
    ]
      .includes(url.pathname);
    if (env.NODE_ENV === "production" && req.method === "POST" &&
      !serverToServer && !origin) {
      return json(res, 403, { error: "A trusted request origin is required." });
    }
    if (req.method === "POST" && url.pathname === "/api/csp-report") {
      const raw = await body(req, true);
      try {
        const parsed = JSON.parse(raw || "{}"),
          report = parsed["csp-report"] || parsed[0]?.body || parsed.body || {};
        await mutate((s) => log(s, "security.csp_violation", {
          document: String(report["document-uri"] || report.documentURL || "").slice(0, 300),
          directive: String(report["violated-directive"] || report.effectiveDirective || "").slice(0, 100),
          blocked: String(report["blocked-uri"] || report.blockedURL || "").slice(0, 300),
        }));
      } catch {
        // Malformed reports are intentionally discarded without affecting clients.
      }
      res.writeHead(204);
      return res.end();
    }
    if (env.NODE_ENV === "production" && req.method === "POST" &&
      customerCsrfPaths[url.pathname]) {
      const state = ensureState(await store.snapshot()),
        session = auth(req, state, "dashboardSessions");
      if (!session) return json(res, 401, { error: "Customer session expired." });
      if (!safeEqual(req.headers["x-csrf-token"] || "", session.csrfToken || "")) {
        return json(res, 403, {
          error: "Security token expired. Refresh the page and try again.",
        });
      }
    }
    const edgeScope = req.method === "POST" && authEdgeScopes[url.pathname];
    if (edgeScope) {
      const limited = await mutate((s) => {
        const cutoff = new Date(clock().getTime() - edgeWindowMs),
          recent = s.rateLimitEvents.filter((event) =>
            event.scope === edgeScope && event.ip === ip(req) &&
            new Date(event.at) > cutoff
          );
        if (recent.length >= edgeLimits[edgeScope]) {
          sec(s, "auth.edge.throttled", req, { scope: edgeScope });
          return true;
        }
        s.rateLimitEvents.push({
          id: randomUUID(), scope: edgeScope, ip: ip(req),
          at: clock().toISOString(),
        });
        return false;
      });
      if (limited) {
        return json(res, 429, {
          error: "Too many authentication requests. Try again later.",
        }, { "retry-after": String(Math.ceil(edgeWindowMs / 1000)) });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/plans") {
      return mutate((s) => json(res, 200, {
        plans: catalogue(s),
        paymentProvider: paymentProviders[0] || null,
      }));
    }
    if (bootstrapMode && !url.pathname.startsWith("/api/admin/")) {
      if (req.method === "GET" && url.pathname === "/api/health") {
        try {
          await store.snapshot();
          return json(res, 200, {
            status: "bootstrap",
            database: "ready",
            operational: false,
            capabilities: {
              plans: true,
              payments: paymentProviders.length > 0,
              emailDelivery: email.configured(),
              customerAccounts: true,
              administration: true,
              networkProvisioning: Boolean(
                env.MIKROTIK_API_URL && env.MIKROTIK_USER &&
                  env.MIKROTIK_PASSWORD
              ),
            },
            message: "Deployment is running with capability-based setup controls.",
          });
        } catch (error) {
          return json(res, 503, { status: "unhealthy", database: "unavailable" });
        }
      }
      if (req.method === "GET" && url.pathname === "/api/status") {
        return json(res, 200, { service: "bootstrap", operational: false });
      }
    }
    if (req.method === "GET" && url.pathname === "/api/status") {
      return json(res, 200, {
        service: "online",
        zone: "student-zone-1",
        coverage: "four buildings / approximately 300m radius",
        paymentMode: env.PAYMENT_MODE || "mock",
        paymentProviders,
        mikrotikMode: env.MIKROTIK_MODE || "mock",
        omadaMode: env.OMADA_MODE || "not-configured",
      });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return mutate((s) => json(res, 200, {
        status: "ready",
        database: env.DATABASE_URL ? "postgresql" : "local",
        checkedAt: clock().toISOString(),
        stateVersion: Array.isArray(s.auditLogs) ? "readable" : "invalid",
      }));
    }
    if (req.method === "POST" && ["/api/purchase", "/api/account/plan/purchase"].includes(url.pathname)) {
      const i = await body(req);
      const accountPurchase = url.pathname.startsWith("/api/account/");
      if (!accountPurchase && (!phoneOk(i.phone) || (env.PAYMENT_MODE !== "mock" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(i.email || ""))))) {
        return json(res, 400, {
          error: "Enter a valid Cameroon phone number and email address.",
        });
      }
      const provider = env.PAYMENT_MODE === "mock"
        ? "mock"
        : env.PAYMENT_MODE === "mesomb" ? "mesomb" : "flutterwave";
      if (!paymentProviders.includes(provider)) {
        return json(res, 503, {
          error: `${provider === "mesomb" ? "MeSomb" : "Flutterwave"} payments are not configured on the API service.`,
          code: "PAYMENT_PROVIDER_NOT_CONFIGURED",
          operational: false,
        });
      }
      return mutate(async (s) => {
        const accountSession = accountPurchase && auth(req, s, "dashboardSessions"),
          plan = purchasablePlan(s, i.planId);
        if (accountPurchase && !accountSession) {
          return json(res, 401, { error: "Customer session expired." });
        }
        if (accountSession) refreshCustomerSession(req, res, accountSession);
        if (!plan) {
          return json(res, 400, {
            error: "This package is unavailable or discontinued.",
          });
        }
        let c = accountSession
          ? s.customers.find((x) => x.id === accountSession.customerId)
          : s.customers.find((x) => x.phone === phone(i.phone));
        if (!c) {
          c = {
            id: randomUUID(),
            phone: phone(i.phone),
            name: String(i.name || "Customer").slice(0, 100),
            email: String(i.email || "").trim().toLowerCase().slice(0, 254),
            createdAt: clock().toISOString(),
          };
          s.customers.push(c);
        }
        if (!c) return json(res, 401, { error: "Customer account not found." });
        if (i.email) c.email = String(i.email).trim().toLowerCase().slice(0, 254);
        const requestKey = String(i.requestKey || "").slice(0, 100),
          duplicate = requestKey && s.payments.find((x) =>
            x.customerId === c.id && x.requestKey === requestKey
          );
        if (duplicate) {
          return json(res, 200, {
            idempotent: true,
            payment: duplicate,
            checkout: {
              mode: env.PAYMENT_MODE || "mock", provider: duplicate.provider,
              url: duplicate.checkoutUrl, authorizationMode: duplicate.authorizationMode,
            },
          });
        }
        const activeVoucher = s.vouchers.find((v) =>
          v.customerId === c.id && v.status === "active"
        ), latestVoucher = s.vouchers.find((v) => v.customerId === c.id),
          action = accountPurchase ? String(i.action || "") : i.upgrade ? "switch" : "purchase";
        if (accountPurchase && !["renew", "switch"].includes(action)) {
          return json(res, 400, { error: "Choose renew or switch plan." });
        }
        if (action === "renew" && (!latestVoucher || latestVoucher.planId !== plan.id)) {
          return json(res, 409, { error: "You can only renew your current purchasable plan." });
        }
        if (action === "switch" && latestVoucher?.planId === plan.id) {
          return json(res, 409, { error: "Choose a different package or renew your current one." });
        }
        if (activeVoucher && action === "purchase") {
          return json(res, 409, {
            error:
              "Your current bundle is still active. Bundles cannot be stacked.",
          });
        }
        if (activeVoucher && i.upgrade && !accountPurchase) {
          const activePlan = findPlan(s, activeVoucher.planId);
          if (!activePlan || plan.price <= activePlan.price) {
            return json(res, 400, {
              error: "Choose a package above your current bundle to upgrade.",
            });
          }
        }
        const nextEligibleAt = plan.id === "daily" && dailyEligibleAt(s, c.id);
        if (nextEligibleAt && nextEligibleAt > clock()) {
          return json(res, 409, {
            error: `Daily is available again on ${nextEligibleAt.toISOString()}.`,
            nextEligibleAt: nextEligibleAt.toISOString(),
          });
        }
        const p = {
            id: randomUUID(),
            customerId: c.id,
            planId: plan.id,
            amount: plan.price,
            currency: "XAF",
            payerPhone: c.phone,
            email: c.email,
            customerName: c.name,
            network: i.network,
            clientIp: ip(req),
            provider,
            status: "pending",
            createdAt: clock().toISOString(),
            action,
            ...(requestKey ? { requestKey } : {}),
            ...(provider === "mesomb" ? {
              paymentExpiresAt: new Date(
                clock().getTime() + Number(env.PAYMENT_PENDING_SECONDS || 300) * 1000,
              ).toISOString(),
            } : {}),
            ...(activeVoucher ? { replaceVoucherId: activeVoucher.id } : {}),
          },
          made = await pays[provider].createPayment(p);
        p.providerReference = made.providerReference;
        p.authorizationMode = made.authorizationMode || "callback";
        if (made.checkoutUrl) p.checkoutUrl = made.checkoutUrl;
        if (
          s.payments.some((x) => x.providerReference === p.providerReference)
        ) {
          return json(res, 409, {
            error: "Duplicate provider transaction reference.",
          });
        }
        s.payments.unshift(p);
        log(s, "payment.created", {
          paymentId: p.id,
          amount: p.amount,
          provider,
        });
        return json(res, 201, {
          payment: p,
          checkout: {
            mode: env.PAYMENT_MODE || "mock",
            provider,
            message: "Approve the payment request on your phone.",
            url: made.checkoutUrl,
            authorizationMode: p.authorizationMode,
          },
        });
      });
    }
    if (
      req.method === "POST" &&
      /^\/api\/payments\/[^/]+\/confirm$/.test(url.pathname)
    ) {
      if ((env.PAYMENT_MODE || "mock") !== "mock") {
        return json(res, 403, {
          error: "Production payments require a signed provider webhook.",
        });
      }
      const id = url.pathname.split("/")[3];
      return mutate((s) =>
        complete(s, s.payments.find((x) => x.id === id), null, res)
      );
    }
    if (
      req.method === "GET" &&
      /^\/api\/payments\/[^/]+\/status$/.test(url.pathname)
    ) {
      return mutate(async (s) => {
        const id = url.pathname.split("/")[3],
          payment = s.payments.find((x) => x.id === id),
          voucher = payment?.status === "paid" &&
            s.vouchers.find((x) => x.paymentId === payment.id);
        if (!payment) return json(res, 404, { error: "Payment not found." });
        const accountSession = auth(req, s, "dashboardSessions");
        if (accountSession?.customerId === payment.customerId &&
          ["renew", "switch"].includes(payment.action)) {
          refreshCustomerSession(req, res, accountSession);
        }
        if (payment.provider === "mesomb" && payment.status === "pending") {
          const lastCheck = Number(new Date(payment.lastVerificationAt || 0)),
            expired = payment.paymentExpiresAt &&
              new Date(payment.paymentExpiresAt) <= clock();
          if (expired || clock().getTime() - lastCheck >= 5000) {
            payment.lastVerificationAt = clock().toISOString();
            try {
              const verified = await pays.mesomb.verifyPayment(payment);
              if (
                verified.transactionReference !== payment.id ||
                Number(verified.amount) !== payment.amount ||
                verified.currency !== payment.currency
              ) {
                log(s, "payment.verification_mismatch", {
                  paymentId: payment.id,
                  provider: payment.provider,
                });
              } else if (verified.status === "paid") {
                return complete(s, payment, verified.providerReference, res);
              } else {
                payment.status = verified.status;
              }
            } catch (error) {
              payment.verificationError = String(error.message || error).slice(0, 240);
            }
            if (expired && payment.status === "pending") {
              payment.status = "failed";
              payment.failureReason = "Payment approval timed out.";
              payment.failedAt = clock().toISOString();
            }
          }
        }
        if (voucher && voucher.emailStatus !== "sent" && Number(voucher.emailAttempts || 0) < 5) {
          await deliverVoucherEmail(s, voucher);
        }
        return json(res, 200, {
          payment: {
            id: payment.id,
            status: payment.status,
            ...(payment.failureReason ? { failureReason: payment.failureReason } : {}),
          },
          ...(voucher ? {
            access: { code: voucher.code },
            email: { status: voucher.emailStatus, sentAt: voucher.emailSentAt },
          } : {}),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/flutterwave") {
      const provider = "flutterwave", raw = await body(req, true);
      let data;
      try {
        data = await pays[provider].handleWebhook(
          raw,
          req.headers["flutterwave-signature"],
        );
      } catch {
        return json(res, 401, { error: "Invalid webhook signature." });
      }
      return mutate(async (s) => {
        const p = s.payments.find((x) => x.id === data.paymentId);
        if (!p || p.provider !== provider) {
          return json(res, 404, { error: "Payment not found." });
        }
        let verified;
        try {
          verified = await pays.flutterwave.verifyPayment(p, data.transactionId);
        } catch {
          return json(res, 502, { error: "Unable to verify payment with Flutterwave." });
        }
        if (
          verified.transactionReference !== p.id ||
          Number(verified.amount) !== p.amount ||
          verified.currency !== p.currency
        ) {
          return json(res, 400, {
            error: "Verified payment details do not match this order.",
          });
        }
        if (verified.status === "paid") {
          return complete(s, p, verified.providerReference, res);
        }
        p.status = verified.status;
        return json(res, 200, { accepted: true, status: p.status });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/webhooks/mesomb") {
      const provider = "mesomb", raw = await body(req, true);
      let data;
      try {
        data = await pays[provider].handleWebhook(
          raw,
          req.headers["x-mesomb-webhook-signature"],
        );
      } catch {
        return json(res, 401, { error: "Invalid webhook signature." });
      }
      return mutate(async (s) => {
        s.providerEvents ??= [];
        if (data.eventId && s.providerEvents.some((event) =>
          (typeof event === "string" ? event : event.eventId) === data.eventId
        )) {
          return json(res, 200, { accepted: true, idempotent: true });
        }
        const p = s.payments.find((x) => x.id === data.paymentId);
        if (!p || p.provider !== provider) {
          return json(res, 404, { error: "Payment not found." });
        }
        let verified;
        try {
          verified = await pays.mesomb.verifyPayment(p);
        } catch {
          return json(res, 502, { error: "Unable to verify payment with MeSomb." });
        }
        if (
          verified.transactionReference !== p.id ||
          Number(verified.amount) !== p.amount ||
          verified.currency !== p.currency
        ) {
          return json(res, 400, {
            error: "Verified payment details do not match this order.",
          });
        }
        if (data.eventId) {
          s.providerEvents.unshift({
            id: randomUUID(), eventId: data.eventId, at: clock().toISOString(),
          });
          s.providerEvents = s.providerEvents.slice(0, 1000);
        }
        if (verified.status === "paid") {
          return complete(s, p, verified.providerReference, res);
        }
        p.status = verified.status;
        return json(res, 200, { accepted: true, status: p.status });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/vouchers/redeem") {
      const i = await body(req);
      return mutate(async (s) => {
        if (
          s.securityEvents.filter((x) =>
            x.type === "redeem.failed" && x.ip === ip(req) &&
            new Date(x.at) > new Date(clock() - 9e5)
          ).length >= 20
        ) {
          return json(res, 429, {
            error: "Too many attempts. Try again later.",
          });
        }
        const v = s.vouchers.find((x) =>
          safeEqual(x.code, normalizeActivationCode(i.code))
        );
        let c = s.customers.find((x) => x.phone === phone(i.phone));
        if (v?.status === "available" && !c && phoneOk(i.phone)) {
          c = {
            id: randomUUID(),
            phone: phone(i.phone),
            name: "Voucher customer",
            email: "",
            createdAt: clock().toISOString(),
          };
          s.customers.push(c);
        }
        if (v?.status === "available" && c) {
          if (s.vouchers.some((item) => item.customerId === c.id && item.status === "active")) {
            return json(res, 409, { error: "This customer already has an active voucher." });
          }
          const plan = findPlan(s, v.planId), activatedAt = clock();
          if (!plan) return json(res, 409, { error: "This voucher's bundle is unavailable." });
          Object.assign(v, {
            customerId: c.id,
            status: "active",
            activatedAt: activatedAt.toISOString(),
            expiresAt: new Date(activatedAt.getTime() + plan.validityHours * 36e5).toISOString(),
          });
          await router.syncVoucher(v);
          log(s, "voucher.resale_claimed", { voucherId: v.id, customerId: c.id });
        }
        if (!v || !c || v.customerId !== c.id) {
          sec(s, "redeem.failed", req);
          return json(res, 401, { error: generic });
        }
        if (v.status !== "active") {
          return json(res, 409, { error: `This code is ${v.status}.` });
        }
        const deviceId = String(i.deviceId || "").slice(0, 200) ||
          secureToken(16);
        let session = s.sessions.find((x) =>
          x.voucherId === v.id && x.deviceId === deviceId &&
          x.status === "online"
        );
        const active = s.sessions.filter((x) =>
          x.voucherId === v.id && x.status === "online"
        );
        if (!session && active.length >= v.deviceLimit) {
          return json(res, 409, {
            error:
              `Device limit reached (${v.deviceLimit}). Disconnect another device first.`,
          });
        }
        if (!session) {
          session = {
            id: randomUUID(),
            voucherId: v.id,
            deviceId,
            label: String(i.label || "Device").slice(0, 80),
            status: "online",
            connectedAt: clock().toISOString(),
          };
          s.sessions.push(session);
        }
        session.lastSeenAt = clock().toISOString();
        log(s, "device.connected", { voucherId: v.id, deviceId });
        return json(res, 200, { voucher: view(v, s), session });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/access/begin") {
      const i = await body(req);
      return mutate((s) => {
        const ph = phone(i.phone), code = normalizeActivationCode(i.code),
          cutoff = new Date(clock().getTime() - 15 * 60_000),
          failures = s.securityEvents.filter((event) =>
            event.type === "customer.access.failed" && new Date(event.at) > cutoff &&
            (event.ip === ip(req) || event.meta?.phone === ph)
          );
        if (failures.length >= 5) {
          return json(res, 429, { error: "Too many access attempts. Try again in 15 minutes." });
        }
        const customer = s.customers.find((item) =>
            item.phone === ph && item.status !== "suspended"
          ),
          voucher = s.vouchers.find((item) => safeEqual(item.code, code)),
          linked = voucher && customer && voucher.customerId === customer.id,
          claimable = voucher?.status === "available" && !voucher.customerId;
        if (!phoneOk(ph) || !voucher || !customer && !claimable ||
          customer && !linked && !claimable ||
          linked && !["active", "expired", "exhausted"].includes(voucher.status)) {
          sec(s, "customer.access.failed", req, { phone: ph });
          return json(res, 401, { error: generic });
        }
        if (claimable && customer && s.vouchers.some((item) =>
          item.customerId === customer.id && item.status === "active"
        )) {
          return json(res, 409, {
            error: "Your account already has an active bundle. Use its voucher to sign in before adding another package.",
          });
        }
        const token = secureToken(32), mode = customer?.pinHash ? "login" : "setup";
        s.customerAccessChallenges.push({
          tokenHash: hashSecret(token, pepper), phone: ph, voucherId: voucher.id,
          mode, used: false, createdAt: clock().toISOString(),
          expiresAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
        });
        return json(res, 200, { token, mode, expiresIn: 600 });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/access/complete") {
      const i = await body(req);
      if (!/^\d{4}$/.test(String(i.pin || ""))) {
        return json(res, 400, { error: "PIN must contain exactly 4 numeric digits." });
      }
      return mutate(async (s) => {
        const challenge = s.customerAccessChallenges.find((item) =>
            !item.used && matchesRotatingHash(
              String(i.token || ""), item.tokenHash, pepper, previousPepper,
            )
          );
        if (!challenge || new Date(challenge.expiresAt) <= clock()) {
          sec(s, "customer.access.failed", req);
          return json(res, 401, { error: "This access attempt expired. Start again." });
        }
        const recentFailures = s.securityEvents.filter((event) =>
          event.type === "customer.access.failed" &&
          new Date(event.at) > new Date(clock().getTime() - 15 * 60_000) &&
          (event.ip === ip(req) || event.meta?.phone === challenge.phone)
        );
        if (recentFailures.length >= 5) {
          return json(res, 429, { error: "Too many access attempts. Try again in 15 minutes." });
        }
        const voucher = s.vouchers.find((item) => item.id === challenge.voucherId);
        let customer = s.customers.find((item) =>
          item.phone === challenge.phone && item.status !== "suspended"
        );
        const linked = voucher && customer && voucher.customerId === customer.id,
          claimable = voucher?.status === "available" && !voucher.customerId;
        if (!voucher || !linked && !claimable ||
          linked && !["active", "expired", "exhausted"].includes(voucher.status)) {
          challenge.used = true;
          sec(s, "customer.access.failed", req, { phone: challenge.phone });
          return json(res, 401, { error: generic });
        }
        const claimPlan = claimable ? findPlan(s, voucher.planId) : null;
        if (claimable && !claimPlan) {
          return json(res, 409, { error: "This voucher's bundle is unavailable." });
        }
        if (claimable && customer && s.vouchers.some((item) =>
          item.customerId === customer.id && item.status === "active"
        )) {
          return json(res, 409, {
            error: "Your account already has an active bundle. This voucher was not used.",
          });
        }
        if (challenge.mode === "login") {
          const throttle = pinThrottle(customer);
          if (throttle) {
            return json(res, 429, {
              error: throttle.locked
                ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
                : "Wait briefly before trying the PIN again.",
              ...throttle,
            }, { "retry-after": String(throttle.retryAfterSeconds) });
          }
          if (!customer?.pinHash || !(await argon2.verify(customer.pinHash, i.pin))) {
            sec(s, "customer.access.failed", req, { phone: challenge.phone });
            const failure = recordPinFailure(s, customer, req, challenge.phone);
            return json(res, failure.locked ? 429 : 401, {
              error: failure.locked
                ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
                : generic,
              ...failure,
            }, { "retry-after": String(failure.retryAfterSeconds || 1) });
          }
          clearPinFailures(customer);
        } else {
          if (i.pin !== i.confirmPin) {
            return json(res, 400, { error: "PIN entries do not match." });
          }
          if (customer?.pinHash) {
            challenge.used = true;
            return json(res, 409, { error: "This account is already set up. Start again and sign in." });
          }
          if (!customer) {
            customer = {
              id: randomUUID(), phone: challenge.phone, name: "Voucher customer",
              email: "", createdAt: clock().toISOString(),
            };
            s.customers.push(customer);
          }
          customer.pinHash = await argon2.hash(i.pin, { type: argon2.argon2id });
          customer.pinCreatedAt = clock().toISOString();
          log(s, "customer.pin.created", { customerId: customer.id });
        }
        if (claimable) {
          const activatedAt = clock();
          Object.assign(voucher, {
            customerId: customer.id, status: "active",
            activatedAt: activatedAt.toISOString(),
            expiresAt: new Date(activatedAt.getTime() + claimPlan.validityHours * 36e5).toISOString(),
          });
          try {
            await router.syncVoucher(voucher);
            voucher.routerSyncStatus = "synchronized";
          } catch (error) {
            voucher.routerSyncStatus = "pending";
            voucher.routerError = String(error.message || error).slice(0, 240);
          }
          log(s, "voucher.resale_claimed", { voucherId: voucher.id, customerId: customer.id });
        }
        challenge.used = true;
        challenge.usedAt = clock().toISOString();
        sec(s, "customer.access.succeeded", req, { customerId: customer.id });
        return issueCustomerSession(s, customer.id, res);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/pin-reset/request") {
      const i = await body(req);
      return mutate(async (s) => {
        const ph = phone(i.phone), cutoff = new Date(clock().getTime() - 15 * 60_000),
          recent = s.securityEvents.filter((event) =>
            event.type === "customer.pin_reset.requested" &&
            new Date(event.at) > cutoff &&
            (event.ip === ip(req) || event.meta?.phone === ph)
          );
        if (recent.length >= 3) {
          return json(res, 429, { error: "Too many reset requests. Try again in 15 minutes." });
        }
        sec(s, "customer.pin_reset.requested", req, { phone: ph });
        const customer = s.customers.find((item) =>
          item.phone === ph && item.status !== "suspended" && item.pinHash && item.email
        );
        if (customer && email.configured()) {
          const token = secureToken(32);
          for (const challenge of s.pinResetChallenges) {
            if (challenge.customerId === customer.id && !challenge.used) challenge.used = true;
          }
          const challenge = {
            id: randomUUID(), customerId: customer.id,
            tokenHash: hashSecret(token, pepper), attempts: 0, used: false,
            createdAt: clock().toISOString(),
            expiresAt: new Date(clock().getTime() + 15 * 60_000).toISOString(),
          };
          s.pinResetChallenges.push(challenge);
          try {
            const sent = await email.sendPinReset({ customer, token });
            challenge.emailMessageId = sent.messageId;
            challenge.emailSentAt = clock().toISOString();
          } catch (error) {
            challenge.deliveryError = String(error.message || error).slice(0, 200);
            log(s, "customer.pin_reset.email_failed", { customerId: customer.id });
          }
        }
        return json(res, 202, {
          message: "If an eligible account matches that phone number, a reset link has been sent to its email address.",
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/pin-reset/confirm") {
      const i = await body(req);
      if (!/^\d{4}$/.test(String(i.pin || ""))) {
        return json(res, 400, { error: "PIN must contain exactly 4 numeric digits." });
      }
      if (i.pin !== i.confirmPin) {
        return json(res, 400, { error: "PIN entries do not match." });
      }
      return mutate(async (s) => {
        const challenge = s.pinResetChallenges.find((item) =>
            !item.used && matchesRotatingHash(
              String(i.token || ""), item.tokenHash, pepper, previousPepper,
            )
          ),
          failures = s.securityEvents.filter((event) =>
            event.type === "customer.pin_reset.failed" && event.ip === ip(req) &&
            new Date(event.at) > new Date(clock().getTime() - 15 * 60_000)
          );
        if (failures.length >= 5) {
          return json(res, 429, { error: "Too many reset attempts. Try again in 15 minutes." });
        }
        if (!challenge || new Date(challenge.expiresAt) <= clock()) {
          sec(s, "customer.pin_reset.failed", req);
          return json(res, 401, { error: "This reset link is invalid or expired." });
        }
        const customer = s.customers.find((item) => item.id === challenge.customerId);
        if (!customer) {
          challenge.used = true;
          return json(res, 401, { error: "This reset link is invalid or expired." });
        }
        customer.pinHash = await argon2.hash(i.pin, { type: argon2.argon2id });
        customer.pinUpdatedAt = clock().toISOString();
        clearPinFailures(customer);
        challenge.used = true;
        challenge.usedAt = clock().toISOString();
        s.dashboardSessions = s.dashboardSessions.filter((session) =>
          session.customerId !== customer.id
        );
        log(s, "customer.pin_reset.completed", { customerId: customer.id });
        return json(res, 200, { reset: true, message: "Your PIN has been reset. You can sign in now." });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/setup/pin") {
      const i = await body(req);
      if (!/^\d{4}$/.test(String(i.pin || ""))) {
        return json(res, 400, { error: "PIN must contain exactly 4 numeric digits." });
      }
      if (i.pin !== i.confirmPin) {
        return json(res, 400, { error: "PIN entries do not match." });
      }
      return mutate(async (s) => {
        const c = s.customers.find((x) => x.phone === phone(i.phone)),
          voucher = c && s.vouchers.find((x) =>
            x.customerId === c.id && safeEqual(x.code, normalizeActivationCode(i.code)) &&
            ["active", "exhausted", "expired"].includes(x.status)
          );
        if (!c || !voucher || c.pinHash) {
          sec(s, "customer.pin_setup.failed", req);
          return json(res, 401, { error: generic });
        }
        c.pinHash = await argon2.hash(i.pin, { type: argon2.argon2id });
        c.pinCreatedAt = clock().toISOString();
        log(s, "customer.pin.created", { customerId: c.id });
        return issueCustomerSession(s, c.id, res);
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/login/pin") {
      const i = await body(req);
      return mutate(async (s) => {
        const ph = phone(i.phone), cutoff = new Date(clock().getTime() - 15 * 60_000),
          failures = s.securityEvents.filter((event) =>
            event.type === "customer.pin.failed" && new Date(event.at) > cutoff &&
            (event.ip === ip(req) || event.meta?.phone === ph)
          );
        if (failures.length >= 5) {
          sec(s, "customer.pin.throttled", req, { phone: ph });
          return json(res, 429, { error: "Too many incorrect PIN attempts. Try again in 15 minutes." });
        }
        const c = s.customers.find((x) => x.phone === ph && x.status !== "suspended"),
          throttle = pinThrottle(c);
        if (throttle) {
          return json(res, 429, {
            error: throttle.locked
              ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
              : "Wait briefly before trying the PIN again.",
            ...throttle,
          }, { "retry-after": String(throttle.retryAfterSeconds) });
        }
        if (c && !c.pinHash && c.totpSecret) {
          return json(res, 409, { error: "Use your existing authenticator to sign in.", authenticatorRequired: true });
        }
        if (!c?.pinHash || !/^\d{4}$/.test(String(i.pin || "")) ||
          !(await argon2.verify(c.pinHash, i.pin))) {
          const failure = recordPinFailure(s, c, req, ph);
          return json(res, failure.locked ? 429 : 401, {
            error: failure.locked
              ? "PIN sign-in is temporarily locked. Use a passkey or Google Authenticator, or try again later."
              : generic,
            ...failure,
          }, { "retry-after": String(failure.retryAfterSeconds || 1) });
        }
        clearPinFailures(c);
        sec(s, "customer.pin_login.succeeded", req, { customerId: c.id });
        return issueCustomerSession(s, c.id, res);
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/account/login/request-authenticator"
    ) {
      const i = await body(req);
      return mutate(async (s) => {
        const ph = phone(i.phone),
          recent = s.otpChallenges.filter((x) =>
            (x.phone === ph || x.ip === ip(req)) &&
            new Date(x.createdAt) > new Date(clock() - 9e5)
          );
        if (recent.length >= 5) {
          sec(s, "otp.throttled", req);
          return json(res, 429, {
            error: "Too many OTP requests. Try again later.",
          });
        }
        const c = s.customers.find((x) => x.phone === ph);
        if (!c?.totpSecret || c.status === "suspended") {
          sec(s, "dashboard.login.failed", req);
          return json(res, 401, { error: generic });
        }
        const ch = {
            id: randomUUID(),
            customerId: c.id,
            phone: ph,
            ip: ip(req),
            attempts: 0,
            used: false,
            createdAt: clock().toISOString(),
            expiresAt: new Date(clock().getTime() + 3e5).toISOString(),
          };
        s.otpChallenges.push(ch);
        const out = {
          challengeId: ch.id,
          enrollmentRequired: false,
          message: "Enter the six-digit code from your authenticator app.",
        };
        return json(res, 200, out);
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/account/login/verify-authenticator"
    ) {
      const i = await body(req);
      return mutate(async (s) => {
        const ch = s.otpChallenges.find((x) => x.id === i.challengeId);
        if (
          !ch || ch.used || new Date(ch.expiresAt) <= clock() ||
          ch.attempts >= 5
        ) {
          return json(res, 401, {
            error: "The verification code is invalid or expired.",
          });
        }
        const customer = s.customers.find((x) => x.id === ch.customerId);
        if (!customer?.totpSecret || !verifyTotp(customer.totpSecret, i.otp, clock().getTime())) {
          ch.attempts++;
          sec(s, "otp.failed", req);
          return json(res, 401, {
            error: "The verification code is invalid or expired.",
            attemptsRemaining: Math.max(0, 5 - ch.attempts),
          });
        }
        ch.used = true;
        const token = secureToken(),
          seconds = Number(env.CUSTOMER_SESSION_SECONDS || 1800),
          expiresAt = new Date(clock().getTime() + seconds * 1000)
            .toISOString();
        s.dashboardSessions.push({
          tokenHash: hashSecret(token, customerSecret),
          customerId: ch.customerId,
          role: "customer",
          expiresAt,
        });
        return json(res, 200, { authenticated: true, expiresAt }, {
          "set-cookie": cookie(
            "customer_session",
            token,
            seconds,
            secureCookies,
          ),
        });
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/account/passkey/options"
    ) {
      const i = await body(req);
      return mutate(async (s) => {
        const c = s.customers.find((x) =>
          x.phone === phone(i.phone) && x.status !== "suspended"
        );
        if (!c?.passkeys?.length) {
          return json(res, 404, {
            error: "No passkey is enrolled for this customer account.",
          });
        }
        const options = await generateAuthenticationOptions({
          rpID: customerRpID,
          userVerification: "required",
          allowCredentials: c.passkeys.map((key) => ({
            id: key.id,
            transports: key.transports,
          })),
        });
        const challenge = {
          id: randomUUID(), customerId: c.id, challenge: options.challenge,
          type: "authentication",
          expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
        };
        s.customerPasskeyChallenges.push(challenge);
        return json(res, 200, { challengeId: challenge.id, options });
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/account/passkey/verify"
    ) {
      const i = await body(req);
      return mutate(async (s) => {
        const challenge = s.customerPasskeyChallenges.find((x) =>
            x.id === i.challengeId && x.type === "authentication"
          ),
          c = challenge && s.customers.find((x) =>
            x.id === challenge.customerId && x.status !== "suspended"
          ),
          key = c?.passkeys?.find((x) => x.id === i.response?.id);
        if (!challenge || !c || !key || new Date(challenge.expiresAt) <= clock()) {
          return json(res, 401, { error: "Passkey challenge is invalid or expired." });
        }
        const verification = await verifyAuthenticationResponse({
          response: i.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: customerOrigin,
          expectedRPID: customerRpID,
          requireUserVerification: true,
          credential: {
            id: key.id,
            publicKey: Buffer.from(key.publicKey, "base64url"),
            counter: key.counter,
            transports: key.transports,
          },
        });
        if (!verification.verified) {
          return json(res, 401, { error: "Passkey verification failed." });
        }
        key.counter = verification.authenticationInfo.newCounter;
        s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter((x) =>
          x.id !== challenge.id
        );
        const token = secureToken(),
          seconds = Number(env.CUSTOMER_SESSION_SECONDS || 1800),
          expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
        s.dashboardSessions.push({
          tokenHash: hashSecret(token, customerSecret), customerId: c.id,
          role: "customer", expiresAt,
        });
        sec(s, "customer.passkey_login.succeeded", req, { customerId: c.id });
        return json(res, 200, { authenticated: true, expiresAt }, {
          "set-cookie": cookie("customer_session", token, seconds, secureCookies),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/logout") {
      return mutate(async (s) => {
        const token = cookies(req).customer_session;
        if (token) {
          s.dashboardSessions = s.dashboardSessions.filter((x) =>
            !matchesRotatingHash(
              token, x.tokenHash, customerSecret, previousCustomerSecret,
            )
          );
        }
        return json(res, 200, { loggedOut: true }, {
          "set-cookie": cookie("customer_session", "", 0, secureCookies),
        });
      });
    }
    if (req.method === "GET" && url.pathname === "/api/account/dashboard") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, {
            error: "Dashboard session expired. Please sign in again.",
          });
        }
        refreshCustomerSession(req, res, a);
        const c = s.customers.find((x) => x.id === a.customerId),
          v = s.vouchers.filter((x) => x.customerId === c.id).map((x) =>
            view(x, s)
          );
        const {
          totpSecret: _totpSecret,
          pinHash: _pinHash,
          pinFailedAttempts: _pinFailedAttempts,
          pinNextAttemptAt: _pinNextAttemptAt,
          pinLockedUntil: _pinLockedUntil,
          passkeys: customerPasskeys = [],
          ...safeCustomer
        } = c;
        a.csrfToken ??= secureToken();
        return json(res, 200, {
          customer: {
            ...safeCustomer,
            authenticatorEnrolled: Boolean(_totpSecret),
            pinConfigured: Boolean(_pinHash),
            passkeys: customerPasskeys.length,
          },
          activeBundle: v.find((x) => x.status === "active") || null,
          vouchers: v,
          payments: s.payments.filter((x) => x.customerId === c.id).slice(
            0,
            30,
          ),
          sessionExpiresAt: a.expiresAt,
          csrfToken: a.csrfToken,
          availablePlans: catalogue(s),
          currentPlan: v[0] || null,
          dailyAvailability: (() => {
            const eligibleAt = dailyEligibleAt(s, c.id);
            return {
              available: !eligibleAt || eligibleAt <= clock(),
              nextEligibleAt: eligibleAt?.toISOString() || null,
            };
          })(),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/mfa/enroll") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.totpSecret) return json(res, 409, { error: "Authenticator 2FA is already enabled." });
        const secret = totpSecret(), challenge = {
          id: randomUUID(), customerId: c.id, secret,
          expiresAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
        };
        s.customerMfaChallenges.push(challenge);
        return json(res, 200, {
          challengeId: challenge.id, secret, uri: totpUri(secret, c.phone),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/mfa/confirm") {
      const i = await body(req);
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          challenge = c && s.customerMfaChallenges.find((x) =>
            x.id === i.challengeId && x.customerId === c.id
          );
        if (!challenge || new Date(challenge.expiresAt) <= clock() ||
          !verifyTotp(challenge.secret, i.code, clock().getTime())) {
          return json(res, 400, { error: "The authenticator code is invalid or expired." });
        }
        c.totpSecret = challenge.secret;
        c.totpEnrolledAt = clock().toISOString();
        s.customerMfaChallenges = s.customerMfaChallenges.filter((x) => x.id !== challenge.id);
        log(s, "customer.authenticator.enrolled", { customerId: c.id });
        return json(res, 200, { mfaEnabled: true });
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/account/passkeys/options"
    ) {
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        const options = await generateRegistrationOptions({
          rpName: customerRpName,
          rpID: customerRpID,
          userName: c.phone,
          userID: Buffer.from(c.id),
          attestationType: "none",
          excludeCredentials: (c.passkeys || []).map((key) => ({
            id: key.id, transports: key.transports,
          })),
          authenticatorSelection: {
            residentKey: "preferred", userVerification: "required",
          },
        });
        const challenge = {
          id: randomUUID(), customerId: c.id, challenge: options.challenge,
          type: "registration",
          expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
        };
        s.customerPasskeyChallenges.push(challenge);
        return json(res, 200, { challengeId: challenge.id, options });
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/account/passkeys/verify"
    ) {
      const i = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          challenge = c && s.customerPasskeyChallenges.find((x) =>
            x.id === i.challengeId && x.customerId === c.id &&
            x.type === "registration"
          );
        if (!challenge || new Date(challenge.expiresAt) <= clock()) {
          return json(res, 400, { error: "Passkey enrollment expired." });
        }
        const verification = await verifyRegistrationResponse({
          response: i.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: customerOrigin,
          expectedRPID: customerRpID,
          requireUserVerification: true,
        });
        if (!verification.verified || !verification.registrationInfo) {
          return json(res, 400, { error: "Passkey enrollment failed." });
        }
        const credential = verification.registrationInfo.credential;
        c.passkeys ??= [];
        c.passkeys.push({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: credential.transports,
          createdAt: clock().toISOString(),
        });
        s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter((x) =>
          x.id !== challenge.id
        );
        log(s, "customer.passkey.enrolled", { customerId: c.id });
        return json(res, 200, { enrolled: true, passkeys: c.passkeys.length });
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/account/devices/disconnect"
    ) {
      const i = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, {
            error: "Dashboard session expired. Please sign in again.",
          });
        }
        const x = s.sessions.find((x) =>
            x.id === i.sessionId && x.status === "online"
          ),
          v = x &&
            s.vouchers.find((v) =>
              v.id === x.voucherId && v.customerId === a.customerId
            );
        if (!x || !v) {
          return json(res, 404, { error: "Active device session not found." });
        }
        x.status = "disconnected";
        x.disconnectedAt = clock().toISOString();
        await router.disconnectDevice(x.deviceId);
        return json(res, 200, {
          message: "Device disconnected. Its slot is now available.",
          voucher: view(v, s),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/passkey/options") {
      const i = await body(req);
      return mutate(async (s) => {
        const user = s.adminUsers.find((item) => item.username === String(i.username || "").trim().toLowerCase() && item.active !== false);
        if (!user?.passkeys?.length) return json(res, 404, { error: "No passkey is enrolled for this account." });
        const options = await generateAuthenticationOptions({
          rpID, userVerification: "required",
          allowCredentials: user.passkeys.map((key) => ({ id: key.id, transports: key.transports })),
        });
        s.adminPasskeyChallenges.push({ id: randomUUID(), userId: user.id, challenge: options.challenge, expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString() });
        return json(res, 200, { challengeId: s.adminPasskeyChallenges.at(-1).id, options });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/passkey/verify") {
      const i = await body(req);
      return mutate(async (s) => {
        const challenge = s.adminPasskeyChallenges.find((item) => item.id === i.challengeId),
          user = challenge && s.adminUsers.find((item) => item.id === challenge.userId),
          key = user?.passkeys?.find((item) => item.id === i.response?.id);
        if (!challenge || !user || !key || new Date(challenge.expiresAt) <= clock()) return json(res, 401, { error: "Passkey challenge is invalid or expired." });
        const verification = await verifyAuthenticationResponse({
          response: i.response, expectedChallenge: challenge.challenge,
          expectedOrigin: adminOrigin, expectedRPID: rpID, requireUserVerification: true,
          credential: { id: key.id, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports },
        });
        if (!verification.verified) return json(res, 401, { error: "Passkey verification failed." });
        key.counter = verification.authenticationInfo.newCounter;
        s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter((item) => item.id !== challenge.id);
        const token = secureToken(), seconds = Number(env.ADMIN_SESSION_SECONDS || 1800), expiresAt = new Date(clock().getTime() + seconds * 1000).toISOString();
        s.adminSessions.push({ tokenHash: hashSecret(token, adminSecret), userId: user.id, role: user.role, csrfToken: secureToken(), createdAt: clock().toISOString(), lastSeenAt: clock().toISOString(), expiresAt });
        req.adminActor = user.username;
        audit(s, "admin.passkey_login.succeeded", req);
        return json(res, 200, { authenticated: true, expiresAt, user: { username: user.username, role: user.role } }, { "set-cookie": cookie("admin_session", token, seconds, secureCookies) });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/login") {
      const i = await body(req);
      return mutate(async (s) => {
        const recent = s.securityEvents.filter((x) =>
          x.type === "admin.login.failed" && x.ip === ip(req) &&
          new Date(x.at) > new Date(clock() - 9e5)
        );
        if (recent.length >= 5) {
          audit(s, "admin.login.rate_limited", req);
          return json(res, 429, {
            error: "Too many login attempts. Try again later.",
          });
        }
        const username = String(i.username || env.ADMIN_USERNAME || "owner").trim().toLowerCase();
        let user = s.adminUsers.find((item) => item.username === username && item.active !== false),
          validPassword = user?.passwordHash
            ? await argon2.verify(user.passwordHash, String(i.password || i.pin || ""))
            : !s.adminUsers.length && safeEqual(hashSecret(i.password || i.pin, adminSecret), adminHash);
        if (!validPassword) {
          sec(s, "admin.login.failed", req);
          audit(s, "admin.login.failed", req);
          return json(res, 401, { error: "Invalid admin credentials." });
        }
        if (!user) {
          user = {
            id: randomUUID(), username, displayName: "Owner", role: "owner",
            passwordHash: await argon2.hash(String(i.password || i.pin)),
            passkeys: [], active: true, createdAt: clock().toISOString(),
          };
          s.adminUsers.push(user);
        }
        const mfaEnabled = env.ADMIN_MFA_ENABLED === "true" ||
          s.adminProfile?.mfaEnabled;
        if (mfaEnabled) {
          const challenge = {
            id: secureToken(24),
            userId: user.id,
            ip: ip(req),
            attempts: 0,
            used: false,
            expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
          };
          s.adminLoginChallenges = (s.adminLoginChallenges || []).filter((x) =>
            new Date(x.expiresAt) > clock() && !x.used
          );
          s.adminLoginChallenges.push(challenge);
          audit(s, "admin.login.password_verified", req, { userId: user.id });
          return json(res, 202, {
            authenticated: false,
            mfaRequired: true,
            challengeId: challenge.id,
            expiresAt: challenge.expiresAt,
          });
        }
        const token = secureToken(),
          seconds = Number(env.ADMIN_SESSION_SECONDS || 1800),
          expiresAt = new Date(clock().getTime() + seconds * 1000)
            .toISOString();
        const csrfToken = secureToken();
        s.adminSessions.push({
          tokenHash: hashSecret(token, adminSecret),
          userId: user.id,
          role: user.role,
          csrfToken,
          createdAt: clock().toISOString(),
          lastSeenAt: clock().toISOString(),
          expiresAt,
        });
        req.adminActor = user.username;
        audit(s, "admin.login.succeeded", req);
        return json(res, 200, { authenticated: true, expiresAt, mfaEnabled, user: { username: user.username, role: user.role } }, {
          "set-cookie": cookie("admin_session", token, seconds, secureCookies),
        });
      });
    }
    if (
      req.method === "POST" && url.pathname === "/api/admin/login/mfa"
    ) {
      const i = await body(req);
      return mutate((s) => {
        const challenge = (s.adminLoginChallenges || []).find((x) =>
            safeEqual(x.id, i.challengeId) && !x.used
          ),
          user = challenge && s.adminUsers.find((x) =>
            x.id === challenge.userId && x.active !== false
          );
        if (
          !challenge || !user || challenge.ip !== ip(req) ||
          new Date(challenge.expiresAt) <= clock() || challenge.attempts >= 5
        ) {
          return json(res, 401, {
            error: "The MFA challenge is invalid or expired. Sign in again.",
          });
        }
        const validMfa = s.adminProfile?.totpSecret
          ? verifyTotp(s.adminProfile.totpSecret, i.mfaCode, clock().getTime())
          : env.ADMIN_MFA_CODE
          ? safeEqual(i.mfaCode || "", env.ADMIN_MFA_CODE)
          : s.adminProfile?.mfaCodeHash && matchesRotatingHash(
            i.mfaCode, s.adminProfile.mfaCodeHash,
            adminSecret, previousAdminSecret,
          );
        if (!validMfa) {
          challenge.attempts++;
          sec(s, "admin.mfa.failed", req, { userId: user.id });
          return json(res, 401, {
            error: "The authenticator code is invalid or expired.",
            attemptsRemaining: Math.max(0, 5 - challenge.attempts),
          });
        }
        challenge.used = true;
        const token = secureToken(),
          seconds = Number(env.ADMIN_SESSION_SECONDS || 1800),
          expiresAt = new Date(clock().getTime() + seconds * 1000)
            .toISOString(),
          csrfToken = secureToken();
        s.adminSessions.push({
          tokenHash: hashSecret(token, adminSecret),
          userId: user.id,
          role: user.role,
          csrfToken,
          createdAt: clock().toISOString(),
          lastSeenAt: clock().toISOString(),
          expiresAt,
        });
        req.adminActor = user.username;
        audit(s, "admin.login.succeeded", req);
        return json(res, 200, {
          authenticated: true,
          expiresAt,
          mfaEnabled: true,
          user: { username: user.username, role: user.role },
        }, {
          "set-cookie": cookie("admin_session", token, seconds, secureCookies),
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/logout") {
      return mutate((s) => {
        const session = auth(req, s, "adminSessions");
        if (!session) {
          return json(res, 401, { error: "Admin session expired." });
        }
        if (env.NODE_ENV === "production" && !safeEqual(req.headers["x-csrf-token"] || "", session.csrfToken || "")) return json(res, 403, { error: "Security token expired." });
        const token = cookies(req).admin_session;
        s.adminSessions = s.adminSessions.filter((x) =>
          !matchesRotatingHash(
            token, x.tokenHash, adminSecret, previousAdminSecret,
          )
        );
        audit(s, "admin.logout", req);
        return json(res, 200, { loggedOut: true }, {
          "set-cookie": cookie("admin_session", "", 0, secureCookies),
        });
      });
    }
    if (url.pathname.startsWith("/api/admin/")) {
      return mutate(async (s) => {
        const administrator = auth(req, s, "adminSessions");
        if (!administrator) {
          return json(res, 401, { error: "Admin session expired." });
        }
        const adminUser = s.adminUsers.find((item) => item.id === administrator.userId);
        administrator.tokenHash = hashSecret(
          cookies(req).admin_session, adminSecret,
        );
        req.adminActor = adminUser?.username || "legacy-admin";
        if (env.NODE_ENV === "production" && req.method !== "GET" && req.method !== "HEAD" && !safeEqual(req.headers["x-csrf-token"] || "", administrator.csrfToken || "")) {
          return json(res, 403, { error: "Security token expired. Refresh the page and try again." });
        }
        administrator.lastSeenAt = clock().toISOString();
        const role = adminUser?.role || administrator.role || "owner",
          mutationAllowed = role === "owner" ||
            role === "operator" && !url.pathname.startsWith("/api/admin/profile/") && !url.pathname.startsWith("/api/admin/users") ||
            role === "reseller" && url.pathname === "/api/admin/vouchers/generate";
        if (req.method !== "GET" && req.method !== "HEAD" && !mutationAllowed) {
          audit(s, "admin.authorization.denied", req, { role, path: url.pathname });
          return json(res, 403, { error: "Your role does not permit this action." });
        }
        if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
          const paid = s.payments.filter((x) => x.status === "paid"),
            catalog = [...plans, ...s.bundles];
          return json(res, 200, {
            metrics: {
              customers: s.customers.length,
              activeCodes: s.vouchers.filter((x) =>
                x.status === "active"
              ).length,
              activeSessions: s.sessions.filter((x) =>
                x.status === "online"
              ).length,
              revenue: paid.reduce((n, x) => n + x.amount, 0),
              bundles: catalog.length,
              exhausted: s.vouchers.filter((x) =>
                x.status === "exhausted"
              ).length,
              expired: s.vouchers.filter((x) => x.status === "expired").length,
            },
            usageByBundle: Object.fromEntries(
              catalog.map((p) => [
                p.name,
                s.vouchers.filter((v) => v.planId === p.id).length,
              ]),
            ),
            customers: s.customers.map(({
              totpSecret: _secret,
              pinHash: _pinHash,
              passkeys: customerPasskeys = [],
              ...customer
            }) => ({
              ...customer,
              authenticatorEnrolled: Boolean(_secret),
              passkeys: customerPasskeys.length,
            })),
            vouchers: s.vouchers.map((v) => view(v, s, true)),
            payments: s.payments.slice(0, 100),
            sessions: s.sessions.slice(-100).reverse(),
            events: s.events.slice(0, 50),
            suspiciousAttempts: s.securityEvents.slice(0, 50),
            auditLogs: s.auditLogs.slice(0, 100),
            administrators: s.adminUsers.map(({ id, username, displayName, role, active, passkeys = [], createdAt }) => ({ id, username, displayName, role, active, passkeys: passkeys.length, createdAt })),
            bundles: catalog,
            integrations: {
              mikrotik: env.MIKROTIK_MODE || "mock",
              omada: env.OMADA_MODE || "not-configured",
              payments: env.PAYMENT_MODE || "mock",
              email: env.EMAIL_MODE || "not-configured",
            },
            deployment: {
              mode: bootstrapMode ? "setup" : "operational",
              operational: !bootstrapMode,
              providers: {
                [env.PAYMENT_MODE === "mesomb" ? "mesomb" : "flutterwave"]:
                  paymentProviders.length > 0,
                mikrotik: Boolean(
                  env.MIKROTIK_API_URL && env.MIKROTIK_USER &&
                    env.MIKROTIK_PASSWORD
                ),
                omada: Boolean(env.OMADA_API_URL && env.OMADA_API_TOKEN),
                email: email.configured(),
              },
            },
            profile: {
              username: adminUser?.username || "legacy-admin",
              role: adminUser?.role || administrator.role,
              passkeys: adminUser?.passkeys?.length || 0,
              mfaEnabled: env.ADMIN_MFA_ENABLED === "true" ||
                Boolean(s.adminProfile?.mfaEnabled),
            },
            csrfToken: administrator.csrfToken,
            zone: s.zone,
          });
        }
        const i = req.method === "POST" ? await body(req) : {};
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/vouchers/resend-email"
        ) {
          const voucher = s.vouchers.find((item) => item.id === i.voucherId);
          if (!voucher) return json(res, 404, { error: "Voucher not found." });
          const sent = await deliverVoucherEmail(s, voucher, true);
          audit(s, "voucher.email_retried", req, { voucherId: voucher.id, sent });
          return json(res, 200, {
            sent,
            emailStatus: voucher.emailStatus,
            error: sent ? undefined : voucher.emailLastError,
          });
        }
        if (req.method === "POST" && url.pathname === "/api/admin/users") {
          const username = String(i.username || "").trim().toLowerCase(),
            role = String(i.role || "auditor"), password = String(i.password || "");
          if (!/^[a-z0-9._-]{3,40}$/.test(username) || !["owner", "operator", "reseller", "auditor"].includes(role) || password.length < 14) {
            return json(res, 400, { error: "Enter a valid username, role, and password of at least 14 characters." });
          }
          if (s.adminUsers.some((user) => user.username === username)) return json(res, 409, { error: "That administrator already exists." });
          const user = { id: randomUUID(), username, displayName: String(i.displayName || username).slice(0, 80), role, passwordHash: await argon2.hash(password), passkeys: [], active: true, createdAt: clock().toISOString() };
          s.adminUsers.push(user);
          audit(s, "admin.user_created", req, { userId: user.id, username, role });
          return json(res, 201, { user: { id: user.id, username, displayName: user.displayName, role, active: true } });
        }
        if (req.method === "POST" && url.pathname === "/api/admin/profile/passkeys/options") {
          if (!adminUser) return json(res, 409, { error: "Sign in again to migrate the administrator account." });
          const options = await generateRegistrationOptions({
            rpName, rpID, userName: adminUser.username,
            userID: Buffer.from(adminUser.id), attestationType: "none",
            excludeCredentials: (adminUser.passkeys || []).map((key) => ({ id: key.id, transports: key.transports })),
            authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
          });
          s.adminPasskeyChallenges.push({ id: randomUUID(), userId: adminUser.id, challenge: options.challenge, type: "registration", expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString() });
          return json(res, 200, { challengeId: s.adminPasskeyChallenges.at(-1).id, options });
        }
        if (req.method === "POST" && url.pathname === "/api/admin/profile/passkeys/verify") {
          const challenge = s.adminPasskeyChallenges.find((item) => item.id === i.challengeId && item.userId === adminUser?.id && item.type === "registration");
          if (!challenge || new Date(challenge.expiresAt) <= clock()) return json(res, 400, { error: "Passkey enrollment expired." });
          const verification = await verifyRegistrationResponse({ response: i.response, expectedChallenge: challenge.challenge, expectedOrigin: adminOrigin, expectedRPID: rpID, requireUserVerification: true });
          if (!verification.verified || !verification.registrationInfo) return json(res, 400, { error: "Passkey enrollment failed." });
          const credential = verification.registrationInfo.credential;
          adminUser.passkeys ??= [];
          adminUser.passkeys.push({ id: credential.id, publicKey: Buffer.from(credential.publicKey).toString("base64url"), counter: credential.counter, transports: credential.transports, createdAt: clock().toISOString() });
          s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter((item) => item.id !== challenge.id);
          audit(s, "admin.passkey_enrolled", req, { credentialId: credential.id });
          return json(res, 200, { enrolled: true, passkeys: adminUser.passkeys.length });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/integrations/sync-usage"
        ) {
          const readings = await router.readUsage();
          let updated = 0;
          for (const reading of readings) {
            const voucher = s.vouchers.find((item) =>
              item.id === reading.voucherId
            );
            if (
              !voucher || !Number.isFinite(Number(reading.usedBytes)) ||
              Number(reading.usedBytes) < voucher.usedBytes
            ) continue;
            voucher.usedBytes = Number(reading.usedBytes);
            voucher.lastUsageSyncAt = clock().toISOString();
            updated++;
          }
          clean(s, clock(), router);
          audit(s, "integration.usage_synchronized", req, {
            readings: readings.length,
            updated,
          });
          return json(res, 200, { readings: readings.length, updated });
        }
        if (
          req.method === "GET" &&
          url.pathname === "/api/admin/integrations/omada"
        ) {
          try {
            return json(res, 200, await omada.status());
          } catch (error) {
            return json(res, 502, {
              configured: true,
              connected: false,
              error: error.message,
            });
          }
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/profile/mfa/enroll"
        ) {
          const secret = totpSecret();
          s.adminMfaChallenges.push({
            secret,
            createdAt: clock().toISOString(),
            expiresAt: new Date(clock().getTime() + 10 * 60_000).toISOString(),
          });
          return json(res, 200, {
            secret,
            uri: totpUri(secret, "administrator"),
          });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/profile/mfa/confirm"
        ) {
          const challenge = s.adminMfaChallenges.at(-1);
          if (
            !challenge || new Date(challenge.expiresAt) <= clock() ||
            !verifyTotp(challenge.secret, i.code, clock().getTime())
          ) {
            return json(res, 400, {
              error: "The authenticator code is invalid or expired.",
            });
          }
          s.adminProfile = {
            mfaEnabled: true,
            totpSecret: challenge.secret,
            updatedAt: clock().toISOString(),
          };
          s.adminMfaChallenges = [];
          audit(s, "configuration.admin_mfa_changed", req, {
            enabled: true,
            method: "totp",
          });
          return json(res, 200, { mfaEnabled: true });
        }
        if (req.method === "POST" && url.pathname === "/api/admin/bundles") {
          const bundle = {
            id: `custom-${secureToken(8)}`,
            name: String(i.name || "").slice(0, 80),
            price: Number(i.price),
            quotaGb: i.quotaGb === null ? null : Number(i.quotaGb),
            validityHours: Number(i.validityHours),
            deviceLimit: Number(i.deviceLimit),
            custom: true,
            createdAt: clock().toISOString(),
          };
          if (
            !bundle.name || bundle.price < 0 || bundle.validityHours <= 0 ||
            bundle.deviceLimit < 1
          ) return json(res, 400, { error: "Invalid bundle." });
          s.bundles.push(bundle);
          audit(s, "bundle.created", req, { bundleId: bundle.id });
          return json(res, 201, { bundle });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/bundles/update" && plans.some((x) =>
            x.id === i.bundleId
          )
        ) {
          const original = plans.find((x) => x.id === i.bundleId),
            updated = {
              name: String(i.name || "").trim().slice(0, 80),
              price: Number(i.price),
              quotaGb: i.quotaGb === null || i.quotaGb === ""
                ? null
                : Number(i.quotaGb),
              validityHours: Number(i.validityHours),
              deviceLimit: Number(i.deviceLimit),
            };
          if (
            !updated.name || !Number.isFinite(updated.price) ||
            updated.price < 0 ||
            updated.quotaGb !== null &&
              (!Number.isFinite(updated.quotaGb) || updated.quotaGb <= 0) ||
            !Number.isFinite(updated.validityHours) ||
            updated.validityHours <= 0 ||
            !Number.isInteger(updated.deviceLimit) || updated.deviceLimit < 1
          ) return json(res, 400, { error: "Enter valid bundle details." });
          Object.assign(original, updated, {
            updatedAt: clock().toISOString(),
          });
          s.bundleOverrides[original.id] = {
            ...updated,
            updatedAt: original.updatedAt,
          };
          audit(s, "bundle.updated", req, { bundleId: original.id });
          return json(res, 200, { bundle: original });
        }
        if (
          req.method === "POST" && url.pathname === "/api/admin/bundles/update"
        ) {
          const bundle = s.bundles.find((x) => x.id === i.bundleId);
          if (!bundle) {
            return json(res, 404, {
              error: "Custom bundle not found. System bundles are read-only.",
            });
          }
          const updated = {
            name: String(i.name || "").trim().slice(0, 80),
            price: Number(i.price),
            quotaGb: i.quotaGb === null || i.quotaGb === ""
              ? null
              : Number(i.quotaGb),
            validityHours: Number(i.validityHours),
            deviceLimit: Number(i.deviceLimit),
          };
          if (
            !updated.name || !Number.isFinite(updated.price) ||
            updated.price < 0 ||
            updated.quotaGb !== null &&
              (!Number.isFinite(updated.quotaGb) || updated.quotaGb <= 0) ||
            !Number.isFinite(updated.validityHours) ||
            updated.validityHours <= 0 ||
            !Number.isInteger(updated.deviceLimit) || updated.deviceLimit < 1
          ) return json(res, 400, { error: "Enter valid bundle details." });
          Object.assign(bundle, updated, { updatedAt: clock().toISOString() });
          audit(s, "bundle.updated", req, { bundleId: bundle.id });
          return json(res, 200, { bundle });
        }
        if (
          req.method === "POST" && url.pathname === "/api/admin/bundles/delete"
        ) {
          const index = s.bundles.findIndex((x) => x.id === i.bundleId);
          if (index < 0) {
            return json(res, 404, {
              error: "Custom bundle not found. System bundles are read-only.",
            });
          }
          const bundle = s.bundles[index],
            inUse = s.vouchers.some((x) => x.planId === bundle.id) ||
              s.payments.some((x) => x.planId === bundle.id);
          if (inUse) {
            return json(res, 409, {
              error:
                "This bundle has payment or voucher history and cannot be deleted.",
            });
          }
          s.bundles.splice(index, 1);
          audit(s, "bundle.deleted", req, {
            bundleId: bundle.id,
            name: bundle.name,
          });
          return json(res, 200, { deleted: true, bundleId: bundle.id });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/vouchers/generate"
        ) {
          const resale = i.purpose === "resale";
          let plan;
          if (i.planMode === "custom") {
            plan = {
              id: `resale-${randomUUID()}`,
              name: String(i.name || "").trim().slice(0, 80),
              price: Number(i.price),
              quotaGb: i.quotaGb === "" || i.quotaGb === null
                ? null
                : Number(i.quotaGb),
              validityHours: Number(i.validityHours),
              deviceLimit: Number(i.deviceLimit),
              custom: true,
              resale: true,
              createdAt: clock().toISOString(),
            };
            if (
              !plan.name || !Number.isFinite(plan.price) || plan.price < 0 ||
              plan.quotaGb !== null &&
                (!Number.isFinite(plan.quotaGb) || plan.quotaGb <= 0) ||
              !Number.isFinite(plan.validityHours) || plan.validityHours <= 0 ||
              !Number.isInteger(plan.deviceLimit) || plan.deviceLimit < 1
            ) return json(res, 400, { error: "Enter valid custom voucher details." });
          } else plan = findPlan(s, i.planId);
          const c = resale ? null : s.customers.find((x) => x.id === i.customerId),
            quantity = resale ? Number(i.quantity || 1) : 1;
          if (!plan || !resale && !c) {
            return json(res, 400, { error: resale ? "Choose a valid bundle." : "Customer and bundle are required." });
          }
          if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100) {
            return json(res, 400, { error: "Generate between 1 and 100 vouchers at a time." });
          }
          if (c && s.vouchers.some((v) => v.customerId === c.id && v.status === "active")) {
            return json(res, 409, { error: "Customer already has an active voucher." });
          }
          if (i.planMode === "custom") s.bundles.push(plan);
          const generated = [];
          for (let index = 0; index < quantity; index++) {
            const t = clock().getTime(), v = {
              id: randomUUID(),
              customerId: c?.id || null,
              planId: plan.id,
              code: uniqueActivationCode(s),
              status: resale ? "available" : "active",
              activatedAt: resale ? null : new Date(t).toISOString(),
              expiresAt: resale ? null : new Date(t + plan.validityHours * 36e5).toISOString(),
              quotaBytes: plan.quotaGb === null ? null : plan.quotaGb * GB,
              usedBytes: 0,
              deviceLimit: plan.deviceLimit,
              generatedByAdmin: true,
              resale,
              createdAt: new Date(t).toISOString(),
            };
            s.vouchers.unshift(v);
            if (!resale) await router.syncVoucher(v);
            generated.push(view(v, s, true));
          }
          audit(s, resale ? "voucher.resale_batch_generated" : "voucher.generated", req, {
            voucherIds: generated.map((v) => v.id),
            customerId: c?.id || null,
            planId: plan.id,
            quantity,
          });
          return json(res, 201, { voucher: generated[0], vouchers: generated, plan });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/customers/suspend"
        ) {
          const c = s.customers.find((x) => x.id === i.customerId);
          if (!c) return json(res, 404, { error: "Customer not found." });
          c.status = i.suspended === false ? "active" : "suspended";
          for (
            const v of s.vouchers.filter((v) =>
              v.customerId === c.id && v.status === "active"
            )
          ) {
            v.status = "suspended";
            await router.disconnectVoucher(v.id);
          }
          audit(s, "customer.suspension_changed", req, {
            customerId: c.id,
            status: c.status,
          });
          const { totpSecret: _totpSecret, ...safeCustomer } = c;
          return json(res, 200, { customer: safeCustomer });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/admin/customers/reset-authenticator"
        ) {
          const c = s.customers.find((x) => x.id === i.customerId);
          if (!c) return json(res, 404, { error: "Customer not found." });
          delete c.totpSecret;
          delete c.totpEnrolledAt;
          c.passkeys = [];
          s.dashboardSessions = s.dashboardSessions.filter((x) =>
            x.customerId !== c.id
          );
          audit(s, "customer.authenticator_reset", req, {
            customerId: c.id,
          });
          return json(res, 200, { reset: true });
        }
        if (
          req.method === "POST" && url.pathname === "/api/admin/payments/refund"
        ) {
          const p = s.payments.find((x) => x.id === i.paymentId);
          if (!p || p.status !== "paid") {
            return json(res, 400, {
              error: "A paid payment is required.",
            });
          }
          const result = await pays[p.provider].refundPayment(p);
          p.status = result.status;
          audit(s, "payment.refunded", req, {
            paymentId: p.id,
            providerReference: p.providerReference,
          });
          return json(res, 200, { payment: p });
        }
        if (
          req.method === "POST" && url.pathname === "/api/admin/profile/mfa"
        ) {
          if (i.enabled && (!/^\d{6}$/.test(String(i.code || "")))) {
            return json(res, 400, {
              error: "A six-digit MFA code is required.",
            });
          }
          s.adminProfile = {
            mfaEnabled: Boolean(i.enabled),
            mfaCodeHash: i.enabled
              ? hashSecret(i.code, adminSecret)
              : undefined,
            updatedAt: clock().toISOString(),
          };
          audit(s, "configuration.admin_mfa_changed", req, {
            enabled: s.adminProfile.mfaEnabled,
          });
          return json(res, 200, { mfaEnabled: s.adminProfile.mfaEnabled });
        }
        if (url.pathname === "/api/admin/vouchers/revoke") {
          const v = s.vouchers.find((x) => x.id === i.voucherId);
          if (!v) return json(res, 404, { error: "Voucher not found." });
          v.status = "revoked";
          await router.disconnectVoucher(v.id);
          audit(s, "voucher.revoked", req, { voucherId: v.id });
          return json(res, 200, { voucher: view(v, s) });
        }
        if (url.pathname === "/api/admin/devices/disconnect") {
          const x = s.sessions.find((x) =>
            x.id === i.sessionId && x.status === "online"
          );
          if (!x) return json(res, 404, { error: "Session not found." });
          x.status = "disconnected";
          await router.disconnectDevice(x.deviceId);
          audit(s, "device.disconnected", req, { sessionId: x.id });
          return json(res, 200, { disconnected: true });
        }
        if (url.pathname === "/api/admin/payments/status") {
          const p = s.payments.find((x) => x.id === i.paymentId);
          if (
            !p ||
            !["pending", "failed", "cancelled", "expired"].includes(i.status)
          ) return json(res, 400, { error: "Invalid payment or status." });
          p.status = i.status;
          audit(s, "payment.status_corrected", req, {
            paymentId: p.id,
            status: i.status,
          });
          return json(res, 200, { payment: p });
        }
        if (url.pathname === "/api/admin/zone") {
          s.zone = {
            ...s.zone,
            status: ["online", "degraded", "offline", "maintenance"].includes(
                i.status,
              )
              ? i.status
              : s.zone.status,
            notes: String(i.notes || "").slice(0, 500),
            updatedAt: clock().toISOString(),
          };
          audit(s, "configuration.zone_changed", req, {
            status: s.zone.status,
          });
          return json(res, 200, { zone: s.zone });
        }
        if (req.method === "GET" && url.pathname === "/api/admin/export") {
          const rows = [
            "type,id,code,status,amount,createdAt",
            ...s.payments.map((x) =>
              `payment,${x.id},,${x.status},${x.amount},${x.createdAt}`
            ),
            ...s.vouchers.map((x) =>
              `voucher,${x.id},${x.code},${x.status},,${x.activatedAt}`
            ),
          ];
          res.writeHead(200, {
            "content-type": "text/csv",
            "content-disposition": 'attachment; filename="ndahi-report.csv"',
          });
          return res.end(rows.join("\n"));
        }
        return json(res, 404, { error: "Not found." });
      });
    }
    return json(res, 404, { error: "Not found." });
  }
  return async (req, res) => {
    try {
      req.clientIp = resolveClientIp(req, env);
      const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
      if (url.pathname.startsWith("/api/")) return await api(req, res, url);
      return json(res, 404, {
        error: "The API server does not serve application pages.",
      });
    } catch (e) {
      console.error(
        JSON.stringify({
          level: "error",
          message: e.message,
          at: new Date().toISOString(),
        }),
      );
      if (!res.headersSent) {
        json(res, e.message === "Request too large" ? 413 : 400, {
          error: e.message,
        });
      } else res.end();
    }
  };
}
export const createServer = (opts) => http.createServer(createHandler(opts));
const main = process.argv[1] &&
  fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  if (process.env.BOOTSTRAP_MODE !== "true") assertProductionConfig(process.env);
  const port = Number(process.env.PORT || process.env.API_PORT || 8082);
  createServer().listen(
    port,
    process.env.HOST || "0.0.0.0",
    () => console.log(`NDAHI Connect API running on http://localhost:${port}`),
  );
}
