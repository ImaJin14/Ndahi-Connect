import http from "node:http";
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
const TZ = "Africa/Douala", PUB = join(process.cwd(), "public"), GB = 1e9;
export const plans = [
  ["daily", "Student Daily", 100, 1, 24, 1],
  ["weekly", "Student Weekly", 500, 5, 168, 1],
  ["monthly", "Student Monthly", 2000, 10, 720, 1],
  ["plus", "Student Plus", 3000, 15, 720, 1],
  ["connect20", "Connect 20", 4000, 20, 720, 2],
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
    adminLoginChallenges: [],
    otpChallenges: [],
    adminMfaChallenges: [],
    securityEvents: [],
    auditLogs: [],
    bundles: [],
    bundleOverrides: {},
    events: [],
    adminProfile: { mfaEnabled: false },
    zone: { id: "student-zone-1", status: "online", notes: "" },
  }),
  phone = (v) =>
    String(v || "").replace(/[\s()-]/g, "").replace(/^\+?237(?=6)/, ""),
  phoneOk = (v) => /^6\d{8}$/.test(phone(v)),
  day = (d) =>
    new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(d),
  ip = (req) =>
    String(req.headers["x-forwarded-for"] || req.socket.remoteAddress || "")
      .split(",")[0].trim();
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
const catalogue = (s) => [...plans, ...s.bundles];
const findPlan = (s, id) => catalogue(s).find((plan) => plan.id === id);
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
    adminSecret = env.ADMIN_SESSION_SECRET || env.SECRET_PEPPER ||
      "development-admin-secret",
    pepper = env.SECRET_PEPPER || "development-only-pepper",
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
  const mutate = (fn) =>
      store.transaction(async (s) => {
        clean(s, clock(), router);
        return fn(s);
      }),
    auth = (req, s, type) => {
      const customer = type === "dashboardSessions",
        name = customer ? "customer_session" : "admin_session",
        secret = customer ? customerSecret : adminSecret,
        token = cookies(req)[name];
      if (!token) return;
      return s[type].find((x) =>
        safeEqual(x.tokenHash, hashSecret(token, secret)) &&
        new Date(x.expiresAt) > clock()
      );
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
      plan = findPlan(s, p.planId);
    if (
      s.vouchers.some((v) => v.customerId === c.id && v.status === "active")
    ) {
      return json(res, 409, {
        error:
          "Your current bundle still has quota. Bundles cannot be stacked.",
      });
    }
    if (
      plan.id === "daily" &&
      s.vouchers.some((v) =>
        v.customerId === c.id && v.planId === "daily" &&
        day(new Date(v.activatedAt)) === day(clock())
      )
    ) {
      return json(res, 409, {
        error:
          "Student Daily can only be activated once per Cameroon calendar day.",
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
    if (req.method === "GET" && url.pathname === "/api/plans") {
      return mutate((s) => json(res, 200, { plans: catalogue(s) }));
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
              payments: paymentProviders.includes("flutterwave"),
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
    if (req.method === "POST" && url.pathname === "/api/purchase") {
      const i = await body(req);
      if (!phoneOk(i.phone) || (env.PAYMENT_MODE !== "mock" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(i.email || "")))) {
        return json(res, 400, {
          error: "Enter a valid Cameroon phone number and email address.",
        });
      }
      const provider = env.PAYMENT_MODE === "mock" ? "mock" : "flutterwave";
      if (!paymentProviders.includes(provider)) {
        return json(res, 503, {
          error: provider === "flutterwave"
            ? "Flutterwave payments are not configured yet. Add FLW_SECRET_KEY and FLW_SECRET_HASH to the API service in Render."
            : "Payments are not configured.",
          code: "PAYMENT_PROVIDER_NOT_CONFIGURED",
          operational: false,
        });
      }
      return mutate(async (s) => {
        const plan = findPlan(s, i.planId);
        if (!plan) {
          return json(res, 400, {
            error: "Choose a valid package and Cameroon phone number.",
          });
        }
        let c = s.customers.find((x) => x.phone === phone(i.phone));
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
        if (i.email) c.email = String(i.email).trim().toLowerCase().slice(0, 254);
        if (
          s.vouchers.some((v) => v.customerId === c.id && v.status === "active")
        ) {
          return json(res, 409, {
            error:
              "Your current bundle is still active. Bundles cannot be stacked.",
          });
        }
        if (
          plan.id === "daily" &&
          s.vouchers.some((v) =>
            v.customerId === c.id && v.planId === "daily" &&
            day(new Date(v.activatedAt)) === day(clock())
          )
        ) {
          return json(res, 409, {
            error:
              "Student Daily can only be activated once per Cameroon calendar day.",
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
        if (voucher?.emailStatus !== "sent" && Number(voucher?.emailAttempts || 0) < 5) {
          await deliverVoucherEmail(s, voucher);
        }
        return json(res, 200, {
          payment: { id: payment.id, status: payment.status },
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
          verified.amount < p.amount ||
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
        const c = s.customers.find((x) => x.phone === ph),
          enrolled = Boolean(c?.totpSecret || c?.passkeys?.length),
          v = !enrolled && s.vouchers.find((x) =>
            safeEqual(x.code, normalizeActivationCode(i.code))
          );
        if (!c || (!enrolled && (!v || v.customerId !== c.id))) {
          sec(s, "dashboard.login.failed", req);
          return json(res, 401, { error: generic });
        }
        const enrollmentSecret = c.totpSecret ? null : totpSecret(),
          ch = {
            id: randomUUID(),
            customerId: c.id,
            phone: ph,
            ip: ip(req),
            enrollmentSecret,
            attempts: 0,
            used: false,
            createdAt: clock().toISOString(),
            expiresAt: new Date(clock().getTime() + 3e5).toISOString(),
          };
        s.otpChallenges.push(ch);
        const out = {
          challengeId: ch.id,
          enrollmentRequired: Boolean(enrollmentSecret),
          message: enrollmentSecret
            ? "Add NDAHI Connect to your authenticator app, then enter its six-digit code."
            : "Enter the six-digit code from your authenticator app.",
        };
        if (enrollmentSecret) {
          out.secret = enrollmentSecret;
          out.uri = totpUri(enrollmentSecret, ph);
        }
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
        const customer = s.customers.find((x) => x.id === ch.customerId),
          secret = customer?.totpSecret || ch.enrollmentSecret;
        if (!customer || !verifyTotp(secret, i.otp, clock().getTime())) {
          ch.attempts++;
          sec(s, "otp.failed", req);
          return json(res, 401, {
            error: "The verification code is invalid or expired.",
            attemptsRemaining: Math.max(0, 5 - ch.attempts),
          });
        }
        ch.used = true;
        if (!customer.totpSecret) {
          customer.totpSecret = ch.enrollmentSecret;
          customer.totpEnrolledAt = clock().toISOString();
          log(s, "customer.authenticator.enrolled", {
            customerId: customer.id,
          });
        }
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
            !safeEqual(x.tokenHash, hashSecret(token, customerSecret))
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
        const c = s.customers.find((x) => x.id === a.customerId),
          v = s.vouchers.filter((x) => x.customerId === c.id).map((x) =>
            view(x, s)
          );
        const {
          totpSecret: _totpSecret,
          passkeys: customerPasskeys = [],
          ...safeCustomer
        } = c;
        return json(res, 200, {
          customer: {
            ...safeCustomer,
            authenticatorEnrolled: Boolean(_totpSecret),
            passkeys: customerPasskeys.length,
          },
          activeBundle: v.find((x) => x.status === "active") || null,
          vouchers: v,
          payments: s.payments.filter((x) => x.customerId === c.id).slice(
            0,
            30,
          ),
          sessionExpiresAt: a.expiresAt,
        });
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
          : s.adminProfile?.mfaCodeHash && safeEqual(
            hashSecret(i.mfaCode, adminSecret),
            s.adminProfile.mfaCodeHash,
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
          !safeEqual(x.tokenHash, hashSecret(token, adminSecret))
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
                flutterwave: Boolean(env.FLW_SECRET_KEY && env.FLW_SECRET_HASH),
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
