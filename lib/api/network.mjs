import { safeEqual } from "../security.mjs";
import { scheduleRouterCommandReplay, resolveObsoleteRouterCommand, routerCommandRecovery } from "../router-queue.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { audit } from "./state.mjs";
import { json, body } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { liveRouter, requestWifiDisconnect, requestWifiRefresh } from "../wifi-devices.mjs";
export function createNetworkRoutes({ clock, env, omada }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    if (req.method === "GET" && url.pathname.startsWith("/api/admin/network/incidents/")) {
      if (!["owner", "operator"].includes(role)) return json(res, 403, { error: "Your role cannot inspect network incidents." });
      const id = url.pathname.slice("/api/admin/network/incidents/".length), incident = (s.operationalIncidents || []).find((n) => n.id === id);
      if (!incident) return json(res, 404, { error: "Incident not found." });
      const commands = incident.status === "resolved" ? incident.completedCommands || [] : s.routerCommands.filter((c) => (c.operationalIncidentIds || [c.operationalIncidentId]).includes(id));
      return json(res, 200, { incident: { id, action: incident.action, problem: incident.problem, status: incident.status, count: incident.count, firstAt: incident.firstAt, lastAt: incident.lastAt, resolvedAt: incident.resolvedAt, resolution: incident.resolution },
        commands: commands.slice(0, 100).map((c) => ({ id: c.id, action: c.action, status: c.status, attempts: c.totalAttempts || 0,
          ...routerCommandRecovery(s, c, { requireScopedDisconnect: env.MIKROTIK_MODE === "live" }) })), total: commands.length });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/wifi-devices/refresh") {
      if (!liveRouter(s, env)) return json(res, 409, { error: "Connect a live router before refreshing Wi-Fi devices." });
      if (env.NETWORK_QUEUE_ENABLED === "false") return json(res, 409, { error: "Enable the network command worker before refreshing devices." });
      const requested = requestWifiRefresh(s, clock);
      if (requested.status === 202) effects.wakeRouter = true;
      audit(s, "wifi_devices.refresh_requested", req, { status: requested.status });
      return json(res, requested.status, requested.body);
    }
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
      if (env.OMADA_MODE !== "standalone" && (s.networkSetup?.connections?.omada || env.NETWORK_OMADA_SOURCE === "saved")) {
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
    if (req.method === "POST" && url.pathname === "/api/admin/wifi-devices/disconnect") {
      const voucher = s.vouchers.find((v) => v.id === i.voucherId && v.status === "active");
      const requested = requestWifiDisconnect(s, voucher, i, clock, { ownerVerified: true });
      if (requested.status === 202) effects.wakeRouter = true;
      audit(s, "wifi_device.disconnect_requested", req, { voucherId: voucher?.id, status: requested.status });
      return json(res, requested.status, requested.body);
    }
    if (req.method === "POST" && url.pathname === "/api/admin/devices/disconnect") {
      const x = s.sessions.find((x) => x.id === i.sessionId && x.status === "online");
      if (!x) return json(res, 404, { error: "Session not found." });
      if (liveRouter(s, env)) {
        const voucher = s.vouchers.find((v) => v.id === x.voucherId), mapped = voucher?.wifiDevices?.find((d) => d.mac === x.deviceId.toUpperCase());
        if (!mapped) return json(res, 409, { error: "Use the router-reported Wi-Fi device list to disconnect a live device." });
        const requested = requestWifiDisconnect(s, voucher, { mac: mapped.mac, sessionId: mapped.sessionId }, clock, { ownerVerified: true });
        if (requested.status === 202) effects.wakeRouter = true;
        return json(res, requested.status, requested.body);
      }
      x.status = "disconnected";
      enqueueRouterCommand(s, { action: "disconnect_device", targetId: x.deviceId }, clock);
      audit(s, "device.disconnected", req, { sessionId: x.id });
      return json(res, 200, { disconnected: true });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/zone") {
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
      const { id, status, notes, updatedAt } = s.zone;
      return json(res, 200, { zone: { id, status, notes, updatedAt } });
    }
    return NOT_HANDLED;
  };
}

export function createNetworkPreflight({ clock, env }) {
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
            "purchase-access",
            "assisted-connections",
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
      const response = scheduleRouterCommandReplay(s, String(input.commandId || ""), clock, { requireScopedDisconnect: liveRouter(s, env) });
      if (response.status === 202)
        audit(s, "network.command_replay_requested", req, { commandId: input.commandId });
      if (response.status === 202) effects.wakeRouter = true;
      return json(res, response.status, response.body);
    }
    if (req.method === "POST" && url.pathname === "/api/admin/network/commands/resolve") {
      const input = await body(req), id = String(input.commandId || "");
      const previous = s.routerCommands?.find((c) => c.id === id)?.status;
      const response = resolveObsoleteRouterCommand(s, id, clock, { requireScopedDisconnect: liveRouter(s, env) });
      if (response.status === 200 && previous !== "resolved") audit(s, "network.command_resolved", req, { commandId: id, resolution: "obsolete_legacy_disconnect" });
      return json(res, response.status, response.body);
    }
    return NOT_HANDLED;
  };
}
