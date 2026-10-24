import { bundleStatus } from "../bundle-status.mjs";
import { validSecurityOperation, recordSecurityAction } from "../account-security.mjs";
import { json, body, cookie, ip } from "./http.mjs";
import { view, catalogue, dailyEligibleAt, log, sec } from "./state.mjs";
import {
  secureToken, safeEqual,
} from "../security.mjs";
import { paymentView, checkoutTiming, expireCustomerCheckouts } from "../billing.mjs";
import { randomUUID } from "node:crypto";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { generateRegistrationOptions, verifyRegistrationResponse } from "@simplewebauthn/server";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { maxPushSubscriptions, pushSubscription, usageAlertConfig } from "../usage-alerts.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { liveRouter, requestWifiDisconnect, wifiDeviceView, disconnectView } from "../wifi-devices.mjs";
import { linkedEmail } from "../email-state.mjs";
import { authenticatorRetired, recordVerifiedMethod, verifiedMethods } from "../authentication-migration.mjs";
import { profileProofOptions, verifyProfileProof, profileCredentialVersion } from "../profile-proof.mjs";
import { approvalPolicy } from "../wifi-approval.mjs";
import { subscriptionPurchaseAccess } from "../subscription-policy.mjs";

export function createAccountRoutes({
  env = {},
  mutate,
  auth,
  refreshCustomerSession,
  clock,
  customerRpName,
  customerRpID,
  customerOrigin,
  secureCookies,
  sessionScope,
  coverage,
  routerProcessor,
  pepper, pinThrottle, recordPinFailure, clearPinFailures,
}) {
  const push = usageAlertConfig(env), timing = checkoutTiming(env);
  async function passkeyProof(s, c, a, req, input, type, target) {
    const failures = s.securityEvents.filter((e) => e.type === "customer.passkey_change.failed" &&
      Date.parse(e.at) > +clock() - 900000 && (e.meta?.customerId === c.id || e.ip === ip(req)));
    if (failures.length >= 5) return { status: 429, code: "VERIFICATION_THROTTLED", error: "Too many credential verification attempts. Try again in 15 minutes." };
    const proof = await verifyProfileProof({ s, customer: c, session: a, input, type, target, clock,
      rpID: customerRpID, origin: customerOrigin, pinThrottle });
    if (proof.throttle) return { status: 429, error: "PIN verification is temporarily locked.", ...proof.throttle };
    if (!proof.verified) {
      sec(s, "customer.passkey_change.failed", req, { customerId: c.id });
      return { status: 401, code: "VERIFICATION_FAILED", error: "Verify with your current PIN or passkey.", ...(!input.response ? recordPinFailure(s, c, req, c.phone) : {}) };
    }
    clearPinFailures(c);
    recordVerifiedMethod(c, proof.method, proof.credentialId, pepper, clock());
    return null;
  }
  return async function (req, res, url) {
    // Usage alerts: the device subscribes with the server's public key; the
    // subscription is stored on the customer and never returned to clients.
    if (url.pathname === "/api/account/push" || url.pathname.startsWith("/api/account/push/")) {
      const i = req.method === "POST" ? await body(req) : {};
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        const count = () => (c.pushSubscriptions || []).length;
        if (req.method === "GET" && url.pathname === "/api/account/push") {
          return json(res, 200, { available: push.enabled, publicKey: push.enabled ? push.publicKey : null, subscriptions: count() });
        }
        if (req.method === "POST" && url.pathname === "/api/account/push/subscribe") {
          if (!push.enabled) return json(res, 503, { error: "Usage alerts are not available yet." });
          const subscription = pushSubscription(i);
          if (!subscription) return json(res, 400, { error: "This browser's notification subscription is not supported." });
          c.pushSubscriptions = [{ ...subscription, createdAt: clock().toISOString() },
            ...(c.pushSubscriptions || []).filter((x) => x.endpoint !== subscription.endpoint)].slice(0, maxPushSubscriptions);
          log(s, "customer.usage_alerts_enabled", { customerId: c.id });
          return json(res, 200, { subscribed: true, subscriptions: count() });
        }
        if (req.method === "POST" && url.pathname === "/api/account/push/unsubscribe") {
          c.pushSubscriptions = (c.pushSubscriptions || []).filter((x) => x.endpoint !== String(i.endpoint || ""));
          return json(res, 200, { subscribed: false, subscriptions: count() });
        }
        return json(res, 404, { error: "Not found." });
      });
    }
    if (req.method === "GET" && url.pathname === "/api/account/hotspot-credentials") {
      return mutate((s) => {
        const session = auth(req, s, "dashboardSessions"),
          customer = session && s.customers.find((item) => item.id === session.customerId);
        if (!customer) return json(res, 401, { error: "Customer session expired." });
        if (customer.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        if (approvalPolicy(s)) return json(res, 409, { code: "DEVICE_APPROVAL_REQUIRED", error: "Connect this device through the device approval page.", pairingRequired: true });
        const voucher = s.vouchers.find((item) => item.customerId === customer.id && item.status === "active" &&
          Date.parse(item.expiresAt) > clock().getTime() &&
          (item.quotaBytes === null || (Number.isFinite(item.quotaBytes) && item.quotaBytes > (item.usedBytes || 0))));
        if (!voucher) {
          const latest = s.vouchers.filter((item) => item.customerId === customer.id && item.activatedAt)
            .reduce((a, b) => (!a || Date.parse(b.activatedAt) > Date.parse(a.activatedAt) ? b : a), null);
          if (latest && (latest.status === "exhausted" || (latest.status === "active" && latest.quotaBytes !== null && latest.usedBytes >= latest.quotaBytes))) {
            return json(res, 409, { code: "QUOTA_EXHAUSTED", error: "Your bundle's data is used up. Renew or switch your plan to reconnect." });
          }
          if (latest && (latest.status === "expired" || (latest.status === "active" && Date.parse(latest.expiresAt) <= clock().getTime()))) {
            return json(res, 409, { code: "BUNDLE_EXPIRED", error: "Your bundle has expired. Renew or switch your plan to reconnect." });
          }
          return json(res, 409, { error: "Activate a bundle before connecting to Wi-Fi." });
        }
        if (voucher.paymentId) {
          const payment = s.payments.find((item) => item.id === voucher.paymentId && item.customerId === customer.id);
          if (!payment || !payment.confirmedAt || !["paid", "refund-pending"].includes(payment.status)) {
            return json(res, 409, { error: "Payment confirmation is required before connecting." });
          }
        }
        if (!s.networkSetup?.runtimeRouterEnabled || s.networkSetup.connections?.router?.mode !== "live") {
          return json(res, 503, { error: "Wi-Fi activation is temporarily unavailable." });
        }
        if (voucher.routerSyncStatus !== "synchronized") {
          return json(res, 202, { code: "HOTSPOT_PENDING", message: "Preparing your Wi-Fi access. Please wait…" }, { "retry-after": "2" });
        }
        // Read the router shortly after this login so the new device appears
        // without waiting for the regular usage sync. A dead-lettered read
        // still waits for an operator.
        if (s.routerCommands?.find((c) => c?.id === "router:sync_usage:global")?.status !== "dead_letter") {
          const sync = enqueueRouterCommand(s, { action: "sync_usage" }, clock);
          if (sync.status === "queued") sync.nextAttemptAt = new Date(clock().getTime() + 5000).toISOString();
        }
        refreshCustomerSession(req, res, session);
        return json(res, 200, { username: voucher.code, password: voucher.code });
      });
    }
    // Devices come from the router's own HotSpot sessions, refreshed by the
    // usage sync. They are the trusted MAC mapping for freeing a device slot.
    if (req.method === "GET" && url.pathname === "/api/account/wifi-devices") {
      const result = await mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        a.csrfToken ??= secureToken();
        const v = s.vouchers.find((item) => item.customerId === a.customerId && item.status === "active");
        refreshCustomerSession(req, res, a);
        if (v && liveRouter(s, env) && (!v.wifiDevicesAt || +clock() - Date.parse(v.wifiDevicesAt) > 15000)) {
          const existing = s.routerCommands?.find((c) => c.id === "router:sync_usage:global");
          if (existing?.status !== "dead_letter") enqueueRouterCommand(s, { action: "sync_usage" }, clock);
        }
        return { ...wifiDeviceView(s, v), csrfToken: a.csrfToken, secondaryApprovalExpiryMinutes: env.WIFI_SECONDARY_EXPIRY_ENABLED === "true" ? 30 : null };
      });
      if (!result) return;
      json(res, 200, result);
      if (env.NETWORK_QUEUE_ENABLED !== "false") routerProcessor?.wake();
      return;
    }
    if (req.method === "GET" && url.pathname.startsWith("/api/account/wifi-devices/operations/")) {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions"), id = decodeURIComponent(url.pathname.split("/").at(-1));
        if (!a) return json(res, 401, { error: "Customer session expired." });
        const command = s.routerCommands?.find((c) => c.id === id && c.action === "disconnect_wifi_device" && c.customerId === a.customerId && s.vouchers.some((v) => v.id === c.device?.voucherId && v.customerId === a.customerId));
        if (!command) return json(res, 404, { error: "Disconnection not found." });
        return json(res, 200, { operation: disconnectView(command) });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/wifi-devices/disconnect") {
      const i = await body(req);
      const result = await mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        const mac = String(i.mac || "").toUpperCase(),
          v = s.vouchers.find((item) => item.customerId === a.customerId && item.status === "active" &&
            item.wifiDevices?.some((device) => device.mac === mac));
        if (!v) return json(res, 404, { error: "That device is no longer connected." });
        const requested = requestWifiDisconnect(s, v, i, clock, { retainApproval: i.retainApproval === true });
        if (requested.status === 409) enqueueRouterCommand(s, { action: "sync_usage" }, clock);
        if (requested.status === 202) log(s, "wifi_device.disconnect_requested", { voucherId: v.id, operationId: requested.body.operation.id });
        return requested;
      });
      if (!result) return;
      json(res, result.status, result.body);
      if (env.NETWORK_QUEUE_ENABLED !== "false") routerProcessor?.wake();
      return;
    }
    if (url.pathname === "/api/account/bundle-status") {
      if (req.method !== "GET") return json(res, 405, { error: "GET required." });
      const result = await mutate(s => {
        const a = auth(req,s,"dashboardSessions"), c = a && s.customers.find(c=>c.id===a.customerId);
        if (!c) return {status:401,body:{error:"Dashboard session expired. Please sign in again."}};
        const snapshot=bundleStatus(s,c,clock(),{live:liveRouter(s,env)});
        const usageAt = Date.parse(snapshot.bundle?.usage.observedAt);
        if (snapshot.activeId && liveRouter(s,env) && (!Number.isFinite(usageAt) || +clock()-usageAt>15000 || snapshot.bundle.devices.state==="unknown") && !s.routerCommands.some(c=>c.id==="router:sync_usage:global"&&c.status==="dead_letter")) enqueueRouterCommand(s,{action:"sync_usage"},clock);
        return {status:200,body:snapshot};
      });
      json(res,result.status,result.body,{"cache-control":"no-store"});
      if(result.status===200&&env.NETWORK_QUEUE_ENABLED!=="false")routerProcessor?.wake();
      return;
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
        expireCustomerCheckouts(s, a.customerId, clock(), timing);
        const c = s.customers.find((x) => x.id === a.customerId),
          v = s.vouchers.filter((x) => x.customerId === c.id).map((x) => view(x, s, true));
        const {
          totpSecret: _totpSecret,
          pinHash: _pinHash,
          wifiMainDevice: _wifiMainDevice,
          pinFailedAttempts: _pinFailedAttempts,
          pinNextAttemptAt: _pinNextAttemptAt,
          pinLockedUntil: _pinLockedUntil,
          recoveryCodes: _recoveryCodes,
          accountBackupCodes: _accountBackupCodes,
          passkeys: customerPasskeys = [],
          pushSubscriptions: _pushSubscriptions,
          pendingEmail: _pendingEmail,
          authenticatorRecoveryPermit: _authenticatorRecoveryPermit,
          mfaCompletion: _mfaCompletion,
          mfaProofs: _mfaProofs,
          mfaCheck: _mfaCheck,
          authMigration: _authMigration,
          ...safeCustomer
        } = c;
        a.csrfToken ??= secureToken();
        return json(res, 200, {
          customer: {
            ...safeCustomer,
            authenticatorEnrolled: false,
            authenticatorRetired: true,
            supportedSignInMethods: ["pin", "passkey"],
            pinConfigured: Boolean(_pinHash),
            passkeys: customerPasskeys.length,
            emailLinked: Boolean(linkedEmail(c)),
            accountBackupCodesRemaining: (_accountBackupCodes || []).length,
            pendingEmail: _pendingEmail ? { email: _pendingEmail.email, expiresAt: _pendingEmail.expiresAt, status: _pendingEmail.status } : null,
          },
          bundleStatus: bundleStatus(s,c,clock(),{live:liveRouter(s,env)}),
          activeBundle: v.find((x) => x.status === "active") || null,
          vouchers: v,
          payments: s.payments.filter((x) => x.customerId === c.id).map((p) => paymentView(p, { timing, now: clock() })),
          securityNotices: (s.securityAlerts || []).filter((notice) => notice.customerId === c.id).slice(-10).reverse().map(({ id, at, subject, lines }) => ({ id, at, subject, lines })),
          sessionExpiresAt: a.expiresAt,
          csrfToken: a.csrfToken,
          zone: { status: s.zone.status, notes: s.zone.notes || undefined },
          availablePlans: catalogue(s),
          purchaseAccess: coverage?.access(req) || { allowed: true },
          subscriptionPurchaseAccess: subscriptionPurchaseAccess(s, c, clock()),
          currentPlan: v[0] || null,
          dailyAvailability: (() => {
            const eligibleAt = dailyEligibleAt(s, c.id);
            return {
              available: !eligibleAt || eligibleAt <= clock(),
              nextEligibleAt: eligibleAt?.toISOString() || null,
            };
          })(),
        });
      }, { res, ...sessionScope(req) });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/proof/options") {
      const input = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        if (env.NODE_ENV === "production" && (!a.csrfToken || !safeEqual(req.headers["x-csrf-token"] || "", a.csrfToken))) return json(res, 403, { error: "Security token expired. Refresh and try again." });
        if (!["passkey_add", "passkey_remove"].includes(input.purpose)) return json(res, 400, { error: "Choose a supported passkey action." });
        if (!c.passkeys?.length) return json(res, 400, { error: "Use your current PIN to verify this action." });
        if (input.purpose === "passkey_remove" && !c.passkeys.some((key) => key.id === input.passkeyId)) return json(res, 404, { error: "Passkey not found." });
        return json(res, 200, await profileProofOptions({ s, customer: c, session: a, type: input.purpose,
          target: input.purpose === "passkey_remove" ? input.passkeyId : "enroll", clock, rpID: customerRpID }));
      }, { res });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/options") {
      const input = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        const failure = await passkeyProof(s, c, a, req, input, "passkey_add", "enroll");
        if (failure) return json(res, failure.status, failure);
        const options = await generateRegistrationOptions({
          rpName: customerRpName,
          rpID: customerRpID,
          userName: c.phone,
          userID: Buffer.from(c.id),
          attestationType: "none",
          excludeCredentials: (c.passkeys || []).map((key) => ({
            id: key.id,
            transports: key.transports,
          })),
          authenticatorSelection: {
            residentKey: "preferred",
            userVerification: "required",
          },
        });
        const challenge = {
          id: randomUUID(),
          customerId: c.id,
          challenge: options.challenge,
          type: "registration", sessionId: a.id, credentialVersion: profileCredentialVersion(c),
          authorizationVersion: 1,
          expiresAt: new Date(clock().getTime() + 5 * 60_000).toISOString(),
        };
        s.customerPasskeyChallenges.push(challenge);
        return json(res, 200, { challengeId: challenge.id, options });
      }, { res });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/verify") {
      const i = await body(req);
      if (!validSecurityOperation(i)) return json(res, 400, { error: "Start a fresh security action." });
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          challenge =
            c &&
            s.customerPasskeyChallenges.find(
              (x) => x.id === i.challengeId && x.customerId === c.id && x.type === "registration",
            );
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        if (challenge) s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter((x) => x.id !== challenge.id);
        if (!challenge || !(Date.parse(challenge.expiresAt) > +clock()) ||
            challenge.authorizationVersion !== 1 || challenge.sessionId !== a.id || challenge.credentialVersion !== profileCredentialVersion(c)) {
          return json(res, 400, { error: "Passkey enrollment expired." });
        }
        let verification;
        try { verification = await verifyRegistrationResponse({
          response: i.response,
          expectedChallenge: challenge.challenge,
          expectedOrigin: customerOrigin,
          expectedRPID: customerRpID,
          requireUserVerification: true,
        }); } catch { return json(res, 400, { error: "Passkey enrollment failed. Start again." }); }
        if (!verification.verified || !verification.registrationInfo) {
          return json(res, 400, { error: "Passkey enrollment failed." });
        }
        const credential = verification.registrationInfo.credential;
        c.passkeys ??= [];
        if (s.customers.some((person) => (person.passkeys || []).some((key) => key.id === credential.id))) return json(res, 409, { error: "This passkey is already enrolled." });
        c.passkeys.push({
          id: credential.id,
          publicKey: Buffer.from(credential.publicKey).toString("base64url"),
          counter: credential.counter,
          transports: credential.transports,
          createdAt: clock().toISOString(),
          label:
            String(i.label || "")
              .trim()
              .slice(0, 60) || `Passkey ${c.passkeys.length + 1}`,
        });
        s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter(
          (x) => x.id !== challenge.id,
        );
        recordSecurityAction(a, i, "passkey_add", clock());
        log(s, "customer.passkey.enrolled", { customerId: c.id });
        queueSecurityAlert(
          s,
          {
            customerId: c.id,
            kind: "passkey_added",
            subject: "A new passkey was added to your NDAHI Connect account",
            lines: ["A new passkey was just added and can now be used to sign in to your account."],
          },
          clock(),
        );
        return json(res, 200, { enrolled: true, passkeys: c.passkeys.length });
      }, { res });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/rename") {
      const i = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          key = c?.passkeys?.find((k) => k.id === i.passkeyId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        if (!key) return json(res, 404, { error: "Passkey not found." });
        const label = String(i.label || "")
          .trim()
          .slice(0, 60);
        if (!label) return json(res, 400, { error: "Enter a name for this passkey." });
        key.label = label;
        log(s, "customer.passkey.renamed", { customerId: c.id });
        return json(res, 200, { renamed: true, label: key.label });
      }, { res });
    }
    if (req.method === "POST" && url.pathname === "/api/account/passkeys/remove") {
      const i = await body(req);
      if (!validSecurityOperation(i)) return json(res, 400, { error: "Start a fresh security action." });
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions"),
          c = a && s.customers.find((x) => x.id === a.customerId),
          key = c?.passkeys?.find((k) => k.id === i.passkeyId);
        if (!c) return json(res, 401, { error: "Customer session expired." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        if (!key) return json(res, 404, { error: "Passkey not found." });
        if (c.status === "suspended") return json(res, 403, { error: "This account is suspended." });
        const failure = await passkeyProof(s, c, a, req, i, "passkey_remove", key.id);
        if (failure) return json(res, failure.status, failure);
        const remaining = { ...c, passkeys: c.passkeys.filter((k) => k.id !== key.id) };
        if (!verifiedMethods(remaining, pepper).length) return json(res, 409, { code: "LAST_CREDENTIAL", error: "Verify a replacement PIN or another passkey before removing this passkey." });
        c.passkeys = c.passkeys.filter((k) => k.id !== key.id);
        recordSecurityAction(a, i, "passkey_remove", clock());
        log(s, "customer.passkey.removed", { customerId: c.id });
        queueSecurityAlert(
          s,
          {
            customerId: c.id,
            kind: "passkey_removed",
            subject: "A passkey was removed from your NDAHI Connect account",
            lines: [
              `The passkey "${key.label || "Passkey"}" was removed and can no longer sign in to your account.`,
              "If you didn't remove it, sign in and review your account security.",
            ],
          },
          clock(),
        );
        return json(res, 200, { removed: true, passkeys: c.passkeys.length });
      }, { res });
    }
    if (req.method === "GET" && url.pathname === "/api/account/security") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        }
        refreshCustomerSession(req, res, a);
        const c = s.customers.find((x) => x.id === a.customerId),
          loginTypes = new Set([
            "customer.pin_login.succeeded",
            "customer.otp_login.succeeded",
            "customer.passkey_login.succeeded",
            "customer.recovery_code_login.succeeded",
            "customer.access.succeeded",
          ]);
        a.csrfToken ??= secureToken();
        return json(res, 200, {
          sessions: s.dashboardSessions
            .filter((x) => x.customerId === c.id)
            .map((x) => ({
              id: x.id,
              createdAt: x.createdAt,
              lastSeenAt: x.lastSeenAt || x.createdAt,
              ip: x.ip,
              userAgent: x.userAgent,
              current: x === a,
            }))
            .sort(
              (x, y) =>
                y.current - x.current ||
                Date.parse(y.lastSeenAt || 0) - Date.parse(x.lastSeenAt || 0),
            ),
          recentLogins: s.securityEvents
            .filter((e) => loginTypes.has(e.type) && e.meta?.customerId === c.id)
            .slice(0, 20)
            .map((e) => ({ type: e.type, at: e.at, ip: e.ip })),
          passkeys: (c.passkeys || []).map((k) => ({
            id: k.id,
            label: k.label || "Passkey",
            createdAt: k.createdAt,
          })),
          authenticatorEnrolled: false,
          authenticatorRetired: true,
          supportedSignInMethods: ["pin", "passkey"],
          pinConfigured: Boolean(c.pinHash),
          recoveryCodesRemaining: null,
          csrfToken: a.csrfToken,
        });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/sessions/revoke") {
      const i = await body(req);
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        }
        const target = s.dashboardSessions.find(
          (x) => x.id && x.id === i.sessionId && x.customerId === a.customerId,
        );
        if (!target) return json(res, 404, { error: "Session not found." });
        const self = target === a;
        s.dashboardSessions = s.dashboardSessions.filter((x) => x !== target);
        sec(s, "customer.session.revoked", req, { customerId: a.customerId, self });
        return self
          ? json(
              res,
              200,
              { revoked: true, loggedOut: true },
              {
                "set-cookie": cookie("customer_session", "", 0, secureCookies),
              },
            )
          : json(res, 200, { revoked: true });
      });
    }
    if (req.method === "POST" && url.pathname === "/api/account/security/logout-everywhere") {
      return mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
        }
        const count = s.dashboardSessions.filter((x) => x.customerId === a.customerId).length;
        s.dashboardSessions = s.dashboardSessions.filter((x) => x.customerId !== a.customerId);
        sec(s, "customer.sessions.revoked_all", req, {
          customerId: a.customerId,
          severity: "high",
          count,
        });
        return json(
          res,
          200,
          { loggedOut: true, sessionsRevoked: count },
          {
            "set-cookie": cookie("customer_session", "", 0, secureCookies),
          },
        );
      });
    }

    if (req.method === "POST" && url.pathname === "/api/account/devices/disconnect") {
      const i = await body(req);
      const result = await mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, {
            error: "Dashboard session expired. Please sign in again.",
          });
        }
        const x = s.sessions.find((x) => x.id === i.sessionId && x.status === "online"),
          v = x && s.vouchers.find((v) => v.id === x.voucherId && v.customerId === a.customerId);
        if (!x || !v) {
          return json(res, 404, { error: "Active device session not found." });
        }
        if (liveRouter(s, env)) {
          const mapped = v.wifiDevices?.find((d) => d.mac === x.deviceId.toUpperCase());
          if (!mapped) return { status: 409, body: { error: "Use the router-reported Wi-Fi device list to disconnect a live device." } };
          return requestWifiDisconnect(s, v, { mac: mapped.mac, sessionId: mapped.sessionId }, clock);
        }
        x.status = "disconnected";
        x.disconnectedAt = clock().toISOString();
        enqueueRouterCommand(s, { action: "disconnect_device", targetId: x.deviceId }, clock);
        return json(res, 200, {
          message: "Device disconnected. Its slot is now available.",
          voucher: view(v, s),
        });
      });
      if (result?.status) {
        json(res, result.status, result.body);
        if (env.NETWORK_QUEUE_ENABLED !== "false") routerProcessor?.wake();
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/account/devices/connect") {
      const i = await body(req);
      return mutate(async (s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) {
          return json(res, 401, {
            error: "Dashboard session expired. Please sign in again.",
          });
        }
        if (approvalPolicy(s)) return json(res, 409, { code: "DEVICE_APPROVAL_REQUIRED", error: "Use the device approval page to connect this device." });
        const v = s.vouchers.find((v) => v.customerId === a.customerId && v.status === "active");
        if (!v) {
          return json(res, 409, {
            error: "You don't have an active bundle yet. Choose a package to get started.",
          });
        }
        const deviceId = String(i.deviceId || "").slice(0, 200) || secureToken(16);
        let session = s.sessions.find(
          (x) => x.voucherId === v.id && x.deviceId === deviceId && x.status === "online",
        );
        const active = s.sessions.filter((x) => x.voucherId === v.id && x.status === "online");
        if (!session && active.length >= v.deviceLimit) {
          return json(res, 409, {
            error: `Device limit reached (${v.deviceLimit}). Disconnect another device first.`,
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
    return NOT_HANDLED;
  };
}
