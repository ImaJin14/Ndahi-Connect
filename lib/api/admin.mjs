import { createAdminRecoveryRoutes } from "./admin-recovery.mjs";
import { createAdminVouchersRoutes } from "./admin-vouchers.mjs";
import { createAdminProfileRoutes } from "./admin-profile.mjs";
import { createNetworkRoutes, createNetworkPreflight } from "./network.mjs";
import { createBundlesRoutes } from "./bundles.mjs";
import { createAdminCustomersRoutes } from "./admin-customers.mjs";
import { createAdminPaymentsRoutes, createPaymentPreflight } from "./admin-payments.mjs";
import { createReportingRoutes } from "./reporting.mjs";
import { json, cookies, body } from "./http.mjs";
import { hashSecret, safeEqual } from "../security.mjs";
import { audit } from "./state.mjs";
import { paymentView } from "../billing.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { createAdminNotificationRoutes } from "./notifications.mjs";
import { authenticatorRetired } from "../authentication-migration.mjs";
import { adminRoles } from "../admin-sensitive-actions.mjs";
const readOnlyPaths = new Set(["/api/admin/dashboard", "/api/admin/records", "/api/admin/export", "/api/admin/wifi-devices"]);
const selfServicePaths = new Set(["/api/admin/profile/proof/options", "/api/admin/profile/passkeys/options", "/api/admin/profile/passkeys/verify", "/api/admin/profile/passkeys/remove"]);
export function createAdminRoutes(context) {
  const { mutate, auth, adminSecret, env, clock, networkSetup, billing, store, routerProcessor } =
    context;
  const preflight = [createNetworkPreflight(context), createPaymentPreflight(context)];
  const routes = [
    createAdminNotificationRoutes(context),
    createAdminVouchersRoutes(context),
    createAdminProfileRoutes(context),
    createNetworkRoutes(context),
    createBundlesRoutes(context),
    createAdminCustomersRoutes(context),
    createAdminRecoveryRoutes(context),
    createAdminPaymentsRoutes(context),
    createReportingRoutes(context),
  ];
  return async function (req, res, url) {
    if (url.pathname.startsWith("/api/admin/")) {
      const effects = {},
        // Read-only views run concurrently with customer traffic; they only touch
        // this administrator's session row, so the session is their scope.
        readOnly = req.method === "GET" && readOnlyPaths.has(url.pathname);
      await mutate(async (s) => {
        const administrator = auth(req, s, "adminSessions");
        if (!administrator) {
          return json(res, 401, { error: "Admin session expired." });
        }
        const adminUser = s.adminUsers.find((item) => item.id === administrator.userId);
        const retired = authenticatorRetired(s), role = adminUser?.role || administrator.role;
        // Prepared revisions retain unbound legacy sessions until cutover, but
        // a deleted bound user or any revoked/unknown-role account never falls
        // back to an owner session. Cutover requires a real current account.
        if ((!adminUser && (retired || administrator.userId)) || adminUser?.active === false || !adminRoles.has(role) ||
          (adminUser && administrator.role !== adminUser.role))
          return json(res, 401, { error: "Admin session expired. Sign in again." });
        administrator.tokenHash = hashSecret(cookies(req).admin_session, adminSecret);
        req.adminActor = adminUser?.username || "legacy-admin";
        if (
          (env.NODE_ENV === "production" || retired) &&
          req.method !== "GET" &&
          req.method !== "HEAD" &&
          !safeEqual(req.headers["x-csrf-token"] || "", administrator.csrfToken || "")
        ) {
          return json(res, 403, {
            error: "Security token expired. Refresh the page and try again.",
          });
        }
        administrator.lastSeenAt = clock().toISOString();
        const mutationAllowed =
            role === "owner" ||
            selfServicePaths.has(url.pathname) ||
            (role === "operator" &&
              !url.pathname.startsWith("/api/admin/profile/") &&
              !url.pathname.startsWith("/api/admin/users")) ||
            (role === "reseller" && url.pathname === "/api/admin/vouchers/generate");
        if (req.method !== "GET" && req.method !== "HEAD" && !mutationAllowed && url.pathname !== "/api/admin/notifications") {
          audit(s, "admin.authorization.denied", req, { role, path: url.pathname });
          return json(res, 403, { error: "Your role does not permit this action." });
        }

        for (const route of preflight) {
          if ((await route(req, res, url, { s, administrator, role, effects })) !== NOT_HANDLED)
            return;
        }
        const i = req.method === "POST" ? await body(req) : {};
        // Domain handlers share this authorized transaction. External work runs after commit.
        for (const route of routes) {
          if (
            (await route(req, res, url, { s, i, administrator, adminUser, role, effects })) !==
            NOT_HANDLED
          )
            return;
        }

        return json(res, 404, { error: "Not found." });
      }, readOnly ? { res, scope: [`admin-session:${cookies(req).admin_session || ""}`] }
        : { res });
      if (effects.wakeRouter && env.NETWORK_QUEUE_ENABLED !== "false") routerProcessor.wake();
      if (effects.networkRequest) {
        res.setHeader("cache-control", "no-store");
        try {
          const result = await networkSetup.handle(
            effects.networkRequest.action,
            effects.networkRequest.input,
            effects.networkRequest.actor,
          );
          return json(res, effects.networkRequest.action === "apply" ? 202 : 200, result);
        } catch (error) {
          const safe =
            error instanceof TypeError ||
            error instanceof SyntaxError ||
            /decrypt|authenticate data|fetch failed/i.test(error.message)
              ? "Network setup failed. Check server configuration, credentials, and management connectivity."
              : error.message;
          return json(res, 400, { error: safe });
        }
      }
      if (effects.paymentCheckId) {
        const result = await billing.recheckPayment(effects.paymentCheckId, { support: true });
        await mutate((s) => audit(s, "payment.support_verification.completed", req, { paymentId: effects.paymentCheckId, outcome: result?.outcome || "checked" }));
        const payment = (await store.snapshot()).payments.find((p) => p.id === effects.paymentCheckId);
        return json(res, result?.outcome === "busy" ? 429 : 200, { payment: paymentView(payment), message: result?.outcome === "busy" ? "A provider check is already in progress or was requested recently. Wait before checking again." : "Provider check recorded. Review the payment and activation status." });
      }
      if (effects.refundPaymentId || effects.refundCheckId) {
        if (effects.refundPaymentId) await billing.submitRefund(effects.refundPaymentId);
        else await billing.recheckRefund(effects.refundCheckId);
        await mutate(() => {});
        const p = (await store.snapshot()).payments.find(
          (p) => p.id === (effects.refundPaymentId || effects.refundCheckId),
        );
        return json(res, 200, { payment: paymentView(p) });
      }
      if (effects.routerCommandId) {
        const result = await routerProcessor.process(effects.routerCommandId);
        if (result.retried) {
          return json(res, 502, {
            error: result.error || "MikroTik usage sync failed. It will retry automatically.",
          });
        }
        return json(res, 200, { readings: result.readings ?? 0, updated: result.updated ?? 0 });
      }
      return;
    }
    return NOT_HANDLED;
  };
}
