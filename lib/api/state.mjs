import { randomUUID } from "node:crypto";
import { ip } from "./http.mjs";
import { activationCode } from "../security.mjs";
import { join, dirname } from "node:path";
import { readFile, mkdir, writeFile, rename } from "node:fs/promises";
import { enqueueRouterCommand } from "../router-queue.mjs";
const GB = 1e9;
const legacyPlans = [
  ["plus", "Connect Plus", 3000, 15, 720, 1],
  ["connect20", "Connect 20", 4000, 20, 720, 2],
].map(([id, name, price, quotaGb, validityHours, deviceLimit]) => ({
  id,
  name,
  price,
  quotaGb,
  validityHours,
  deviceLimit,
  discontinued: true,
}));
const plans = [
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
const blank = () => ({
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
    securityAlerts: [],
    auditLogs: [],
    bundles: [],
    bundleOverrides: {},
    events: [],
    providerEvents: [],
    routerCommands: [],
    networkSetupJobs: [],
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
    String(v || "")
      .replace(/[\s()-]/g, "")
      .replace(/^\+?237(?=6)/, ""),
  phoneOk = (v) => /^6\d{8}$/.test(phone(v));
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
};
const catalogue = (s) => [...plans, ...s.bundles.filter((plan) => plan.discontinued !== true)];
const findPlan = (s, id) => [...plans, ...legacyPlans, ...s.bundles].find((plan) => plan.id === id);
const purchasablePlan = (s, id) => catalogue(s).find((plan) => plan.id === id);
const dailyEligibleAt = (s, customerId, excludeId) => {
  const last = s.payments
    .filter(
      (payment) =>
        payment.id !== excludeId &&
        payment.customerId === customerId &&
        payment.planId === "daily" &&
        payment.status === "paid",
    )
    .sort(
      (a, b) => +new Date(b.confirmedAt || b.createdAt) - +new Date(a.confirmedAt || a.createdAt),
    )[0];
  return last ? new Date(+new Date(last.confirmedAt || last.createdAt) + 7 * 24 * 36e5) : null;
};
const uniqueActivationCode = (s) => {
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = activationCode();
    if (!s.vouchers.some((voucher) => voucher.code === code)) return code;
  }
  throw new Error("Unable to allocate a unique activation code");
};
function createStore({ file = join(process.cwd(), "data", "db.json"), persistent = true } = {}) {
  let state,
    q = Promise.resolve();
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
function clean(s, now) {
  const cutoff = now - 600000,
    at = () => now;
  for (const x of s.sessions) {
    if (x.status === "online" && +new Date(x.lastSeenAt) < cutoff) {
      x.status = "inactive";
      x.disconnectedAt = now.toISOString();
      enqueueRouterCommand(s, { action: "mark_inactive", targetId: x.id }, at);
    }
  }
  for (const v of s.vouchers) {
    if (v.status === "active" && new Date(v.expiresAt) <= now) {
      v.status = "expired";
      enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, at);
      v.routerSyncStatus = "pending";
    }
    if (v.status === "active" && v.quotaBytes !== null && v.usedBytes >= v.quotaBytes) {
      v.status = "exhausted";
      v.exhaustedAt ??= now.toISOString();
      enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, at);
      v.routerSyncStatus = "pending";
    }
  }
  s.dashboardSessions = s.dashboardSessions.filter((x) => new Date(x.expiresAt) > now);
  s.customerAccessChallenges = s.customerAccessChallenges.filter(
    (x) => !x.used && new Date(x.expiresAt) > now,
  );
  s.rateLimitEvents = s.rateLimitEvents.filter(
    (x) => new Date(x.at) > new Date(now.getTime() - 24 * 60 * 60_000),
  );
  s.adminSessions = s.adminSessions.filter((x) => new Date(x.expiresAt) > now);
}
function view(v, s, includeCode = false) {
  const sessions = s.sessions.filter((x) => x.voucherId === v.id && x.status === "online"),
    remainingBytes = v.quotaBytes === null ? null : Math.max(0, v.quotaBytes - v.usedBytes);
  return {
    ...v,
    code: includeCode ? v.code : undefined,
    plan: findPlan(s, v.planId),
    sessions,
    activeDevices: sessions.length,
    remainingBytes,
    usagePercentage:
      v.quotaBytes === null ? null : Math.min(100, (v.usedBytes / v.quotaBytes) * 100),
    eligibleForReactivation: ["expired", "exhausted"].includes(v.status),
  };
}
const authEdgeScopes = Object.freeze({
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
const customerCsrfPaths = Object.freeze({
  "/api/account/plan/purchase": true,
  "/api/account/payments/refund": true,
  "/api/account/payments/receipt-email": true,
  "/api/account/logout": true,
  "/api/account/security/mfa/enroll": true,
  "/api/account/security/mfa/confirm": true,
  "/api/account/passkeys/options": true,
  "/api/account/passkeys/verify": true,
  "/api/account/passkeys/rename": true,
  "/api/account/passkeys/remove": true,
  "/api/account/devices/disconnect": true,
  "/api/account/devices/connect": true,
  "/api/account/security/sessions/revoke": true,
  "/api/account/security/logout-everywhere": true,
  "/api/account/security/recovery-codes/generate": true,
});
export {
  GB,
  legacyPlans,
  plans,
  blank,
  ensureState,
  phone,
  phoneOk,
  log,
  sec,
  audit,
  catalogue,
  findPlan,
  purchasablePlan,
  dailyEligibleAt,
  uniqueActivationCode,
  createStore,
  clean,
  view,
  authEdgeScopes,
  customerCsrfPaths,
};
