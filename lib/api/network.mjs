import { safeEqual } from "../security.mjs";
import { scheduleRouterCommandReplay } from "../router-queue.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { audit } from "./state.mjs";
import { json, body } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createNetworkRoutes({ clock, env, omada }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    if (req.method === "POST" && url.pathname === "/api/admin/integrations/sync-usage") {
      effects.routerCommandId = enqueueRouterCommand(
        s,
        { action: "sync_usage", targetId: "global" },
        clock,
      ).id;
      audit(s, "integration.usage_sync_requested", req, {});
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/admin/integrations/omada") {
      if (s.networkSetup?.connections?.omada || env.NETWORK_OMADA_SOURCE === "saved") {
        effects.networkRequest = { action: "controller-status", input: {}, actor: req.adminActor };
        return;
      }
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
    if (url.pathname === "/api/admin/devices/disconnect") {
      const x = s.sessions.find((x) => x.id === i.sessionId && x.status === "online");
      if (!x) return json(res, 404, { error: "Session not found." });
      x.status = "disconnected";
      enqueueRouterCommand(s, { action: "disconnect_device", targetId: x.deviceId }, clock);
      audit(s, "device.disconnected", req, { sessionId: x.id });
      return json(res, 200, { disconnected: true });
    }
    if (url.pathname === "/api/admin/zone") {
      s.zone = {
        ...s.zone,
        status: ["online", "degraded", "offline", "maintenance"].includes(i.status)
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
    return NOT_HANDLED;
  };
}

export function createNetworkPreflight({ clock }) {
  return async function (req, res, url, { s, administrator, role, effects }) {
    if (url.pathname.startsWith("/api/admin/network/setup/")) {
      if (role !== "owner")
        return json(res, 403, { error: "Only the owner can configure network devices." });
      const action = url.pathname.slice("/api/admin/network/setup/".length);
      if (
        !(req.method === "GET" && action === "status") &&
        !(
          req.method === "POST" &&
          [
            "connection",
            "discover",
            "preview",
            "apply",
            "confirm",
            "rollback",
            "refresh",
            "recovery",
            "resolve",
            "activate",
            "cancel",
          ].includes(action)
        )
      )
        return json(res, 405, { error: "Unsupported setup method or action." });
      if (
        req.method === "POST" &&
        !safeEqual(req.headers["x-csrf-token"] || "", administrator.csrfToken || "")
      )
        return json(res, 403, {
          error: "Security token expired. Refresh the page and try again.",
        });
      effects.networkRequest = {
        action,
        input: req.method === "POST" ? await body(req) : {},
        actor: req.adminActor,
      };
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/network/commands/replay") {
      const input = await body(req);
      const response = scheduleRouterCommandReplay(s, String(input.commandId || ""), clock);
      if (response.status === 202)
        audit(s, "network.command_replay_requested", req, { commandId: input.commandId });
      return json(res, response.status, response.body);
    }
    return NOT_HANDLED;
  };
}
