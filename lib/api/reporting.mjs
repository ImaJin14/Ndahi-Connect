import { plans, view } from "./state.mjs";
import { json } from "./http.mjs";
import { webhookSummary } from "../payment-webhooks.mjs";
import { reconciliationConfig } from "../payment-reconciliation.mjs";
import { routerReconciliationConfig } from "../router-reconciliation.mjs";
import { routerQueueSummary } from "../router-queue.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { dashboardTotals, parseRecordQuery, queryRecords, RecordQueryError } from "../admin-records.mjs";
import { adminWifiSummary, liveRouter } from "../wifi-devices.mjs";
export function createReportingRoutes({ env, clock, bootstrapMode, paymentProviders, email }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    const { authenticationMigrationReview: _review, authenticatorRetirement: _retirement, ...publicZone } = s.zone || {};
    if (req.method === "GET" && url.pathname === "/api/admin/dashboard") {
      const catalog = [...plans, ...s.bundles],
        now = clock(), wifi = { ...adminWifiSummary(s, now), live: liveRouter(s, env) },
        totals = dashboardTotals(s, { live: wifi.live, now });
      // Record lists are served page by page from /api/admin/records.
      return json(res, 200, {
        metrics: {
          customers: s.customers.length,
          activeCodes: totals.vouchers.active,
          activeSessions: wifi.live && wifi.unreadVouchers ? null : totals.activeSessions,
          revenue: totals.revenue,
          bundlesSold: totals.sales.online.bundles + totals.sales.vouchers.bundles,
          giftedBundles: totals.sales.gifts.bundles,
          bundles: catalog.length,
          exhausted: totals.vouchers.exhausted,
          expired: totals.vouchers.expired,
        },
        sales: totals.sales,
        wifi,
        usageByBundle: Object.fromEntries(catalog.map((p) => [p.name, totals.byPlan.get(p.id) || 0])),
        recordTotals: {
          customers: s.customers.length,
          vouchers: s.vouchers.length,
          payments: s.payments.length,
          sessions: s.sessions.length,
          auditLogs: s.auditLogs.length,
        },
        paymentWebhooks: webhookSummary(s),
        paymentReconciliation: {
          enabled: reconciliationConfig(env).enabled,
          issues: s.payments
            .filter((p) => p.reconciliation?.issues?.length)
            .map((p) => ({
              paymentId: p.id,
              provider: p.provider,
              ...p.reconciliation,
            })),
        },
        networkReconciliation: {
          enabled: routerReconciliationConfig(env).enabled,
          issues: s.vouchers
            .filter((v) => v.networkReconciliation?.issue)
            .map((v) => ({
              voucherId: v.id,
              ...v.networkReconciliation,
            })),
        },
        networkCommands: routerQueueSummary(s, { requireScopedDisconnect: liveRouter(s, env) }),
        administrators: s.adminUsers.map(
          ({ id, username, displayName, role, active, passkeys = [], createdAt }) => ({
            id,
            username,
            displayName,
            role,
            active,
            passkeys: passkeys.length,
            createdAt,
          }),
        ),
        bundles: catalog,
        integrations: {
          mikrotik: s.networkSetup?.runtimeRouterEnabled ? "live" : env.MIKROTIK_MODE || "mock",
          omada:
            s.networkSetup?.connections?.omada?.mode === "live"
              ? "live"
              : env.OMADA_MODE || "not-configured",
          payments: env.PAYMENT_MODE || "mock",
          email: env.EMAIL_MODE || "not-configured",
        },
        deployment: {
          mode: bootstrapMode ? "setup" : "operational",
          operational: !bootstrapMode,
          providers: {
            [env.PAYMENT_MODE === "mesomb" ? "mesomb" : "flutterwave"]: paymentProviders.length > 0,
            mikrotik: Boolean(
              s.networkSetup?.runtimeRouterEnabled ||
              (env.MIKROTIK_API_URL && env.MIKROTIK_USER && env.MIKROTIK_PASSWORD),
            ),
            // A declared standalone site needs no controller to launch.
            omada: env.OMADA_MODE === "standalone" ? "standalone" : Boolean(
              s.networkSetup?.connections?.omada || (env.OMADA_API_URL && env.OMADA_API_TOKEN),
            ),
            email: email.configured(),
          },
        },
        profile: {
          username: adminUser?.username || "legacy-admin",
          role: adminUser?.role || administrator.role,
          passkeys: adminUser?.passkeys?.length || 0,
          mfaEnabled: env.ADMIN_MFA_ENABLED === "true" || Boolean(s.adminProfile?.mfaEnabled),
        },
        csrfToken: administrator.csrfToken,
        zone: publicZone,
      });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/records") {
      let query;
      try {
        query = parseRecordQuery(url.searchParams);
      } catch (error) {
        if (error instanceof RecordQueryError) return json(res, 400, { error: error.message });
        throw error;
      }
      const result = queryRecords(s, query, { now: clock() });
      if (query.collection === "vouchers") {
        // Resolve device sessions for this page only.
        const ids = new Set(result.items.map(({ id }) => id)),
          scoped = { ...s, sessions: s.sessions.filter((x) => ids.has(x.voucherId)) };
        result.items = result.items.map((v) => view(v, scoped, true));
      }
      return json(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/admin/wifi-devices") {
      return json(res, 200, { ...adminWifiSummary(s, clock()), live: liveRouter(s, env) });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/export") {
      const rows = [
        "type,id,code,status,amount,createdAt",
        ...s.payments.map((x) => `payment,${x.id},,${x.status},${x.amount},${x.createdAt}`),
        ...s.vouchers.map((x) => `voucher,${x.id},${x.code},${x.status},,${x.activatedAt}`),
      ];
      res.writeHead(200, {
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="ndahi-report.csv"',
      });
      return res.end(rows.join("\n"));
    }
    return NOT_HANDLED;
  };
}
