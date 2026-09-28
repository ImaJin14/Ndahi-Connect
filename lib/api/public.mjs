import { json } from "./http.mjs";
import { catalogue } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createPublicRoutes({
  mutate,
  paymentProviders,
  bootstrapMode,
  boundedHealthCheck,
  email,
  env,
  store,
  clock,
}) {
  return async function (req, res, url) {
    if (req.method === "GET" && url.pathname === "/api/plans") {
      return mutate((s) =>
        json(res, 200, {
          plans: catalogue(s),
          paymentProvider: paymentProviders[0] || null,
        }),
      );
    }
    if (bootstrapMode && !url.pathname.startsWith("/api/admin/")) {
      if (req.method === "GET" && url.pathname === "/api/health") {
        try {
          await boundedHealthCheck();
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
                env.MIKROTIK_API_URL && env.MIKROTIK_USER && env.MIKROTIK_PASSWORD,
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
      const s = await store.snapshot();
      return json(res, 200, {
        service: s.zone.status,
        zoneNotes: s.zone.notes || undefined,
        zone: "student-zone-1",
        coverage: "four buildings / approximately 300m radius",
        paymentMode: env.PAYMENT_MODE || "mock",
        paymentProviders,
        mikrotikMode: s.networkSetup?.runtimeRouterEnabled ? "live" : env.MIKROTIK_MODE || "mock",
        omadaMode: env.OMADA_MODE || "not-configured",
      });
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      try {
        await boundedHealthCheck();
        return json(res, 200, {
          status: "ready",
          database: env.DATABASE_URL ? "postgresql" : "local",
          checkedAt: clock().toISOString(),
          stateVersion: "readable",
        });
      } catch {
        return json(res, 503, { status: "unhealthy", database: "unavailable" });
      }
    }
    return NOT_HANDLED;
  };
}
