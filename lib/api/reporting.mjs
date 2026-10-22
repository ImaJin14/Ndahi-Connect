import { authenticatorRetired } from "../authentication-migration.mjs";
import { plans } from "./state.mjs";
import { json } from "./http.mjs";
import { webhookSummary } from "../payment-webhooks.mjs";
import { reconciliationConfig } from "../payment-reconciliation.mjs";
import { routerReconciliationConfig } from "../router-reconciliation.mjs";
import { routerQueueSummary } from "../router-queue.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { dashboardTotals, parseRecordQuery, queryRecords, RecordQueryError } from "../admin-records.mjs";
import { voucherAccess, voucherReadState, voucherListView } from "../voucher-access.mjs";
import { adminWifiSummary, liveRouter } from "../wifi-devices.mjs";
export function createReportingRoutes({ env, clock, bootstrapMode, paymentProviders, email }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    if (req.method !== "GET" || !["/api/admin/dashboard", "/api/admin/records", "/api/admin/export", "/api/admin/wifi-devices"].includes(url.pathname)) return NOT_HANDLED;
    const { authenticationMigrationReview: _migrationReview, authenticatorRetirement: _retirement, ...publicZone } = s.zone || {};
    const access = voucherAccess(role, adminUser, administrator), scoped = voucherReadState(s, access);
    const profile = {
      username: adminUser?.username || "legacy-admin", role,
      passkeys: adminUser?.passkeys?.length || 0,
      mfaEnabled: !authenticatorRetired(s) && (env.ADMIN_MFA_ENABLED === "true" || Boolean(s.adminProfile?.mfaEnabled)),
      authenticatorRetired: authenticatorRetired(s),
      passkeyList: (adminUser?.passkeys || []).map(({ id, label, createdAt }) => ({ id, label, createdAt })),
    };
    if (req.method === "GET" && url.pathname === "/api/admin/dashboard" && !access.contacts) {
      const catalog = [...plans, ...s.bundles], now = clock(),
        totals = dashboardTotals(scoped, { now, live: liveRouter(s, env) }),
        wifi = { ...adminWifiSummary(scoped, now), live: liveRouter(s, env) };
      return json(res, 200, {
        metrics: { customers: 0, activeCodes: totals.vouchers.active, activeSessions: totals.activeSessions,
          revenue: 0, bundlesSold: 0, giftedBundles: 0, bundles: catalog.length,
          exhausted: totals.vouchers.exhausted, expired: totals.vouchers.expired },
        wifi, recordTotals: { customers: 0, vouchers: scoped.vouchers.length, payments: 0, sessions: 0, auditLogs: 0 },
        paymentWebhooks: {}, paymentReconciliation: { enabled: false, issues: [] },
        networkReconciliation: { enabled: false, issues: [] }, networkCommands: { pending: 0, deadLetters: 0, commands: [] },
        administrators: [], bundles: catalog, usageByBundle: {},
        integrations: { mikrotik: wifi.live ? "live" : "mock", omada: "not-configured", payments: "restricted", email: "restricted" },
        deployment: { mode: "operational", operational: true, providers: {} },
        profile,
        csrfToken: administrator.csrfToken, scopeKey: access.scopeKey, zone: publicZone,
      });
    }
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
        profile,
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
      if (!access.contacts && !["vouchers", "wifiDevices"].includes(query.collection)) {
        return json(res, 403, { error: "Your role does not permit this record collection." });
      }
      const result = queryRecords(scoped, query, { now: clock(),
        voucherView: (v) => voucherListView(scoped, v, access),
        voucherSearch: (v, lookup) => [v.id, v.planId, ...(access.codes ? [v.code] : []),
          ...(access.payments ? [v.paymentId, lookup.customerPhone(v.customerId)] : [])],
      });
      if (query.collection === "vouchers") result.scopeKey = access.scopeKey;
      if (!access.contacts && query.collection === "wifiDevices") result.items = result.items.map(({ id, voucherId, name, mac, address, sessionId, startedAt, syncedAt, fresh }) => ({ id, voucherId, name, mac, address, sessionId, startedAt, syncedAt, fresh }));
      return json(res, 200, result);
    }
    if (req.method === "GET" && url.pathname === "/api/admin/wifi-devices") {
      return json(res, 200, { ...adminWifiSummary(scoped, clock()), live: liveRouter(s, env) });
    }
    if (req.method === "GET" && url.pathname === "/api/admin/export") {
      // Use exactly the voucher list query/scope for CSV, including filters. A
      // page parameter never broadens the export to another reseller's stock.
      let query;
      try { query = parseRecordQuery(new URLSearchParams({ ...Object.fromEntries(url.searchParams), collection: "vouchers" })); }
      catch (error) { if (error instanceof RecordQueryError) return json(res, 400, { error: error.message }); throw error; }
      const rows = ["type,id,code,status,amount,createdAt"], csv = (cells) => cells.map((value) => {
        let text = String(value ?? "");
        if (/^[=+@\-\t\r]/.test(text)) text = "'" + text;
        return '"' + text.replaceAll('"', '""') + '"';
      }).join(",");
      if (access.payments && !url.searchParams.size) rows.push(...s.payments.map((x) => csv(["payment", x.id, "", x.status, x.amount, x.createdAt])));
      const options = { voucherView: (v) => voucherListView(scoped, v, access),
        voucherSearch: (v, lookup) => [v.id, v.planId, ...(access.codes ? [v.code] : []), ...(access.payments ? [v.paymentId, lookup.customerPhone(v.customerId)] : [])] };
      // Export all matching rows, rather than truncating to the first page.
      let page = 1, result;
      do {
        result = queryRecords(scoped, { ...query, page, pageSize: 100 }, options);
        rows.push(...result.items.map((v) => csv(["voucher", v.id, v.code, v.status, "", v.activatedAt])));
      } while (page++ < result.pages);
      res.writeHead(200, {
        "cache-control": "no-store",
        "content-type": "text/csv",
        "content-disposition": 'attachment; filename="ndahi-report.csv"',
      });
      return res.end(rows.join("\n"));
    }
    return NOT_HANDLED;
  };
}
