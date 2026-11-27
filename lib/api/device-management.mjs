import { deviceCapabilities } from "../device-capabilities.mjs";
import { authenticatorRetired } from "../authentication-migration.mjs";
import { body, json, cookie } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { sec } from "./state.mjs";
import { secureToken, hashSecret } from "../security.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { deviceName, mainDeviceView, mainRegistrationValid, isMainController, routerRevision } from "../device-identities.mjs";
import { requestWifiDisconnect, wifiDeviceView, wifiReadingMaxAgeMs } from "../wifi-devices.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { approveDevice, deviceRevocation } from "../wifi-approval.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { revokeDeviceGrant, isPersonalUnlimited } from "../device-slots.mjs";
import { slotRows } from "../admin-records.mjs";
import { randomUUID } from "node:crypto";
import { connectivityState } from "../connectivity-state.mjs";
import { currentWifiView } from "../current-wifi-device.mjs";
import { appAssociation, rememberAppDevice, invalidateAppDevice, wifiAppCookie, wifiAppLifetimeSeconds } from "../wifi-app-associations.mjs";

const root = "/api/account/device-management";
export function createDeviceManagementRoutes({ mutate, auth, clock, pepper, previousPepper, secureCookies,
  customerRpID, customerOrigin, pinThrottle, recordPinFailure, clearPinFailures, routerProcessor, env, router, coverage }) {
  return async (req, res, url) => {
    if (![root, root + "/main", root + "/main/options", root + "/disconnect", root + "/disconnect/options", root + "/forget", root + "/forget/options", root + "/replace", root + "/replace/options", root + "/current", root + "/current/identify", root + "/current/reset", root + "/nickname"].includes(url.pathname)) return NOT_HANDLED;
    if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "Method not allowed." });
    const input = req.method === "POST" ? await body(req) : {};
    if (url.pathname.startsWith(root + "/current")) {
      const identify = url.pathname.endsWith("/identify");
      const reset = url.pathname.endsWith("/reset");
      if (req.method !== (identify || reset ? "POST" : "GET")) return json(res, 405, { error: "Method not allowed." });
      const prepared = await mutate((s) => {
        const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
        if (!customer) return { status: 401, body: { error: "Customer session expired." } };
        if (customer.status === "suspended" || customer.suspended) return { status: 403, body: { error: "This account is suspended." } };
        const association = appAssociation(s, req, session, clock(), pepper, previousPepper);
        const inCoverage = coverage.enabled && coverage.access(req).allowed;
        const view = () => {
          const result = currentWifiView(s, customer.id, session.currentWifi, clock(), { inCoverage, sessionId: session.id });
          result.connectivity = connectivityState(s, { session, ingress: inCoverage, coverageEnabled: coverage.enabled, now: clock() });
          rememberAppDevice(s, session, clock());
          if (result.state === "connected") association.row.lastConfirmedAt = result.checkedAt;
          if (!session.currentWifi && inCoverage) result.identificationOptions = s.vouchers.filter((v) => v.customerId === customer.id && v.status === "active" &&
            Number.isFinite(Date.parse(v.wifiDevicesAt)) && Math.abs(+clock() - Date.parse(v.wifiDevicesAt)) <= wifiReadingMaxAgeMs)
            .flatMap((v) => v.wifiDevices || []).filter((d, i, all) => d.sessionId && d.startedAt && !deviceRevocation(s, customer.id, d.mac) && all.findIndex((x) => x.mac === d.mac) === i)
            .map((d) => ({ mac: d.mac, address: d.address, name: deviceName(d.name) }));
          return result;
        };
        if (reset) {
          delete session.currentWifi; delete association.row.candidate; delete association.row.lastConfirmedAt;
          association.row.invalidatedAt = clock().toISOString();
          return { status: 200, body: view(), appCookie: association.token };
        }
        if (!identify) {
          const voucher = s.vouchers.find((v) => v.customerId === customer.id && v.status === "active");
          if (inCoverage && voucher && (!voucher.wifiDevicesAt || +clock() - Date.parse(voucher.wifiDevicesAt) > 15000) &&
              !s.routerCommands.some((c) => c.id === "router:sync_usage:global" && c.status === "dead_letter")) enqueueRouterCommand(s, { action: "sync_usage" }, clock);
          return { status: 200, body: view(), appCookie: association.token };
        }
        let candidate = input.mac ? { mac: String(input.mac).toUpperCase(), address: String(input.address || "") }
          : session.currentWifi?.routerRevision === routerRevision(s) ? session.currentWifi : undefined;
        if (input.confirmMac === true && !view().identificationOptions?.some((d) => d.mac === candidate?.mac && d.address === candidate?.address)) return { status: 409, body: { error: "Refresh and select one of your current devices after matching its Wi-Fi MAC." } };
        if (!input.mac && candidate) {
          const devices = s.vouchers.filter((v) => v.customerId === customer.id && v.status === "active" &&
            Number.isFinite(Date.parse(v.wifiDevicesAt)) && Math.abs(+clock() - Date.parse(v.wifiDevicesAt)) <= wifiReadingMaxAgeMs)
            .flatMap((v) => v.wifiDevices || []).filter((d) => d.mac === candidate.mac);
          if (devices.length === 1 && devices[0].address) candidate = { ...candidate, address: devices[0].address };
        }
        if (!inCoverage) return { status: 200, body: view() };
        if (!/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(candidate?.mac || "") || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate?.address || "") || candidate.address.split(".").some((part) => +part > 255)) return { status: 200, body: { state: "unknown", checkedAt: null, message: "Open Wi-Fi sign-in on this device to identify its connection." } };
        if (session.wifiIdentifyAt && +clock() - Date.parse(session.wifiIdentifyAt) < 5000) return { status: 429, body: { error: "Wait a moment before identifying this device again." } };
        session.wifiIdentifyAt = clock().toISOString();
        const identificationId = randomUUID(), revision = routerRevision(s);
        // Keep a retry candidate, but invalidate its proof before the router read.
        // A failed check must never revive the previous Connected result.
        session.currentWifi = { mac: candidate.mac, address: candidate.address, sessionId: session.id, routerRevision: revision, verifiedAt: null,
          lastConfirmedAt: association.row.lastConfirmedAt, identificationId };
        return { sessionId: session.id, customerId: customer.id, revision, identificationId, appCookie: association.token, candidate: { mac: candidate.mac, address: candidate.address } };
      });
      if (prepared.appCookie) res.setHeader("set-cookie", cookie(wifiAppCookie, prepared.appCookie, wifiAppLifetimeSeconds, secureCookies));
      if (prepared.status) {
        json(res, prepared.status, prepared.body);
        if (!identify && env.NETWORK_QUEUE_ENABLED !== "false") routerProcessor?.wake();
        return;
      }
      let target;
      try { target = await router.readGuestDevice(prepared.candidate); }
      catch { return json(res, 200, { state: "unknown", checkedAt: null, message: "The router could not identify this device. Open Wi-Fi sign-in again, or refresh when the router is available." }); }
      const result = await mutate((s) => {
        const session = auth(req, s, "dashboardSessions");
        if (!session || session.id !== prepared.sessionId || !s.customers.some((c) => c.id === session.customerId && c.status !== "suspended" && !c.suspended)) return { status: 401, body: { error: "Customer session expired." } };
        if (session.currentWifi?.identificationId !== prepared.identificationId) return { status: 409, body: { error: "A newer device check replaced this one. Refresh the connection status." } };
        if (routerRevision(s) !== prepared.revision || target?.server !== "ndahi-hotspot" || target.mac !== prepared.candidate.mac || target.address !== prepared.candidate.address || !target.hostId) return { status: 409, body: { error: "The router connection changed. Open Wi-Fi sign-in again." } };
        session.currentWifi = { ...prepared.candidate, sessionId: session.id, loginAddress: target.loginAddress, routerRevision: prepared.revision, verifiedAt: clock().toISOString() };
        rememberAppDevice(s, session, clock());
        const result = currentWifiView(s, session.customerId, session.currentWifi, clock(), { sessionId: session.id });
        if (result.state === "connected") {
          const row = s.wifiAppAssociations.find((a) => a.id === session.wifiAppAssociationId);
          if (row) row.lastConfirmedAt = result.checkedAt;
        }
        result.connectivity = connectivityState(s, { session, ingress: coverage.enabled && coverage.access(req).allowed, coverageEnabled: coverage.enabled, now: clock() });
        return { status: 200, body: result };
      });
      return json(res, result.status, result.body);
    }
    const result = await mutate(async (s) => {
      const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
      if (!customer) return { status: 401, body: { error: "Customer session expired." } };
      if (customer.status === "suspended" || customer.suspended) return { status: 403, body: { error: "This account is suspended." } };
      const capabilities = deviceCapabilities(s, customer.id, clock());
      const main = () => ({ deviceCapabilities: capabilities, mainDevice: capabilities.mainDeviceSupported ? mainDeviceView(s, customer, clock()) : null, isMainController: capabilities.mainDeviceSupported && isMainController(req, customer, pepper, previousPepper), setupRequired: capabilities.mainDeviceSupported && !mainRegistrationValid(s, customer, pepper, previousPepper),
        authenticatorEnrolled: false, authenticatorRetired: true, passkeys: Boolean(customer.passkeys?.length),
        // A running Personal Unlimited bundle's slots (#349, #350): each device holding
        // one (masked MAC, online or last seen, removal pending), and when the bundle ends.
        ...(() => { const v = s.vouchers.find((x) => x.customerId === customer.id && x.status === "active" && isPersonalUnlimited(x));
          return v ? { slots: { total: v.deviceSlots || v.deviceLimit || 1, rows: slotRows(s, v), endsAt: v.expiresAt || null } } : {}; })(),
        approvedDevices: (s.wifiDeviceGrants || []).filter((g) => g.customerId === customer.id && (g.status === "approved" || deviceRevocation(s, customer.id, g.mac)))
          .map((g) => {
            const operation = deviceRevocation(s, customer.id, g.mac), nickname = customer.deviceNicknames?.[g.mac] || "";
            return { id: g.id, mac: g.mac, nickname, name: nickname || deviceName(g.name),
              main: capabilities.mainDeviceSupported && customer.wifiMainDevice?.mac === g.mac && customer.wifiMainDevice.routerRevision === g.routerRevision,
              routerChanged: g.routerRevision !== routerRevision(s), ...(operation ? { removal: operation.status === "dead_letter" ? "failed" : "pending" } : {}) };
          }) });
      if (url.pathname === root && req.method === "GET") return { status: 200, body: main() };
      if (req.method !== "POST" || url.pathname === root) return { status: 405, body: { error: "POST required." } };
      if (url.pathname === root + "/nickname") {
        const mac = String(input.mac || "").toUpperCase();
        if (!/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(mac)) return { status: 400, body: { error: "Valid MAC address required." } };
        const nickname = typeof input.nickname === "string" ? input.nickname.trim().slice(0, 60) : "";
        customer.deviceNicknames = customer.deviceNicknames || {};
        if (nickname) {
          customer.deviceNicknames[mac] = nickname;
        } else {
          delete customer.deviceNicknames[mac];
        }
        return { status: 200, body: { mac, nickname: customer.deviceNicknames[mac] || "", ...main() } };
      }
      // Replace a device (#350): the device being refused because every slot is
      // full gives up another one's slot. Same PIN proof and removal as forget;
      // the slot frees only once the router confirms, then this device connects
      // through its usual request. Retrying is safe: a removal still waiting is
      // left alone, and one the router failed is asked for again.
      const replacing = url.pathname.startsWith(root + "/replace");
      if (url.pathname.startsWith(root + "/forget") || replacing) {
        const grant = (s.wifiDeviceGrants || []).find((g) => g.id === input.approvalId && g.customerId === customer.id);
        if (!grant) return { status: 404, body: { error: "Saved device approval not found." } };
        const target = JSON.stringify([grant.id, grant.routerRevision, grant.approvedAt]);
        if (url.pathname.endsWith("/options")) {
          if (!customer.passkeys?.length) return { status: 400, body: { error: "Use your PIN to verify this action." } };
          return { status: 200, body: await profileProofOptions({ s, customer, session, type: "wifi_forget", target, clock, rpID: customerRpID }) };
        }
        const proof = await verifyProfileProof({ s, customer, session, input, type: "wifi_forget", target, clock,
          rpID: customerRpID, origin: customerOrigin, pinThrottle });
        if (proof.throttle) return { status: 429, body: { error: "PIN verification is temporarily locked.", ...proof.throttle } };
        if (!proof.verified) {
          return { status: 401, body: { code: "VERIFICATION_FAILED", error: "Could not verify account ownership.", ...recordPinFailure(s, customer, req, customer.phone) } };
        }
        clearPinFailures(customer);
        if (grant.status === "revoked") {
          const command = grant.revocationCommandId && (s.routerCommands || []).find((c) => c.id === grant.revocationCommandId);
          if (replacing && command?.status === "dead_letter" && !grant.revocationConfirmedAt && grant.routerRevision === routerRevision(s)) {
            const again = enqueueRouterCommand(s, { action: "revoke_wifi_device", targetId: randomUUID() }, clock);
            again.customerId = customer.id; again.grantId = grant.id; again.routerRevision = grant.routerRevision; grant.revocationCommandId = again.id;
            s.auditLogs ??= []; s.auditLogs.unshift({ id: randomUUID(), action: "voucher.device_slot_release_retried", actor: customer.id, meta: { customerId: customer.id, voucherId: grant.voucherId || null, macSuffix: grant.mac.slice(-5) }, at: clock().toISOString() });
            return { status: 202, body: main() };
          }
          return { status: deviceRevocation(s, customer.id, grant.mac) ? 202 : 200, body: main() };
        }
        // Shared with the admin's revoke (#334): the slot is freed only once the
        // router confirms the device's session, saved login and binding are gone.
        const removal = revokeDeviceGrant(s, customer.id, grant, clock(), { kind: "customer", actor: customer.id });
        if (removal.conflict) return { status: 409, body: { error: "This device has a connection being confirmed. Wait for it to finish, then forget it." } };
        const removedMain = customer.wifiMainDevice?.mac === grant.mac && customer.wifiMainDevice.routerRevision === grant.routerRevision;
        if (removedMain) delete customer.wifiMainDevice;
        sec(s, replacing ? "customer.wifi_device.replaced" : "customer.wifi_device.forgotten", req, { customerId: customer.id, main: removedMain });
        queueSecurityAlert(s, { customerId: customer.id, kind: replacing ? "wifi_device_replaced" : "wifi_device_forgotten", subject: replacing ? "A saved NDAHI Wi-Fi device was replaced" : "A saved NDAHI Wi-Fi device was removed",
          lines: [replacing ? "Another device took this device's slot after account-owner verification. The replaced device needs fresh approval to reconnect." : "A device's saved approval was removed after account-owner verification. It will need fresh approval to reconnect."] }, clock());
        return { status: grant.revocationCommandId ? 202 : 200, body: main(),
          ...(removedMain ? { cookie: cookie("ndahi_main_device", "", 0, secureCookies) } : {}) };
      }
      if (url.pathname.includes("/main") && !capabilities.mainDeviceSupported) return { status: capabilities.connectionMode === "unavailable" ? 404 : 409, body: { code: "MAIN_DEVICE_UNSUPPORTED", error: capabilities.connectionMode === "single" ? "Your bundle connects one device. Main-device setup is not required." : "An active multi-device bundle is required for main-device setup.", deviceCapabilities: capabilities } };
      const mac = String(input.mac || "").toUpperCase();
      if (deviceRevocation(s, customer.id, mac)) return { status: 409, body: { error: "Wait for this device's router removal before selecting it again." } };
      const voucher = s.vouchers.find((v) => v.customerId === customer.id && v.status === "active" && v.wifiDevices?.some((d) => d.mac === mac));
      const device = voucher?.wifiDevices.find((d) => d.mac === mac);
      if (!device) return { status: 404, body: { error: "Select a device from your current Wi-Fi connections." } };
      if (!Number.isFinite(Date.parse(voucher.wifiDevicesAt)) || +clock() - Date.parse(voucher.wifiDevicesAt) > wifiReadingMaxAgeMs ||
          Date.parse(voucher.wifiDevicesAt) > +clock() + 5000 || !device.sessionId || !Number.isFinite(Date.parse(device.startedAt))) {
        return { status: 409, body: { error: "Refresh Wi-Fi devices before verifying this action.", code: "DEVICE_REFRESH_REQUIRED" } };
      }
      const selecting = url.pathname.includes("/main"), type = selecting ? "main_device" : "main_disconnect";
      const target = JSON.stringify([mac, routerRevision(s), ...(selecting ? [] : [device.sessionId, device.startedAt])]);
      if (url.pathname.endsWith("/options")) {
        if (!customer.passkeys?.length) return { status: 400, body: { error: "Use your PIN to verify this action." } };
        return { status: 200, body: await profileProofOptions({ s, customer, session, type, target, clock, rpID: customerRpID }) };
      }
      const proof = await verifyProfileProof({ s, customer, session, input, type, target, clock,
        rpID: customerRpID, origin: customerOrigin, pinThrottle });
      if (proof.throttle) return { status: 429, body: { error: "PIN verification is temporarily locked.", ...proof.throttle } };
      // Main-device changes require fresh PIN/passkey ownership proof.
      if (!proof.verified) {
        sec(s, "customer.main_device.failed", req, { customerId: customer.id });
        return { status: 401, body: { code: "VERIFICATION_FAILED", error: "Could not verify account ownership.", ...recordPinFailure(s, customer, req, customer.phone) } };
      }
      clearPinFailures(customer);
      if (!selecting) return requestWifiDisconnect(s, voucher, input, clock, { ownerVerified: true, retainApproval: input.retainApproval === true });
      const token = secureToken(), previous = customer.wifiMainDevice;
      customer.wifiMainDevice = { mac, name: deviceName(device.name), routerRevision: routerRevision(s),
        controllerHash: hashSecret(token, pepper), pinVersion: hashSecret(customer.pinHash, pepper), selectedAt: clock().toISOString() };
      approveDevice(s, customer.id, device, clock(), "main_selection");
      sec(s, "customer.main_device.changed", req, { customerId: customer.id, replaced: Boolean(previous) });
      queueSecurityAlert(s, { customerId: customer.id, kind: "main_device_changed", subject: "Your NDAHI Connect main device changed",
        lines: ["Your main Wi-Fi device and controlling browser were selected after account-owner verification.",
          "The previous browser can no longer approve assisted connections. If this was not you, recover your account or contact support."] }, clock());
      return { status: 200, body: { ...main(), isMainController: true, ...wifiDeviceView(s, voucher) },
        cookie: cookie("ndahi_main_device", token, 31536000, secureCookies) };
    });
    json(res, result.status, result.body, result.cookie ? { "set-cookie": result.cookie } : {});
    if (result.status === 202 && env.NETWORK_QUEUE_ENABLED !== "false") routerProcessor?.wake();
  };
}
