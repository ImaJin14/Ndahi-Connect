import { body, json, cookie } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { sec } from "./state.mjs";
import { secureToken, hashSecret, verifyTotp } from "../security.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { deviceName, mainDeviceView, isMainController, routerRevision } from "../device-identities.mjs";
import { requestWifiDisconnect, wifiDeviceView, wifiReadingMaxAgeMs } from "../wifi-devices.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { approveDevice, deviceRevocation } from "../wifi-approval.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { randomUUID } from "node:crypto";
import { currentWifiView } from "../current-wifi-device.mjs";

const root = "/api/account/device-management";
export function createDeviceManagementRoutes({ mutate, auth, clock, pepper, previousPepper, secureCookies,
  customerRpID, customerOrigin, pinThrottle, recordPinFailure, clearPinFailures, routerProcessor, env, router, coverage }) {
  return async (req, res, url) => {
    if (![root, root + "/main", root + "/main/options", root + "/disconnect", root + "/disconnect/options", root + "/forget", root + "/forget/options", root + "/current", root + "/current/identify"].includes(url.pathname)) return NOT_HANDLED;
    if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "Method not allowed." });
    const input = req.method === "POST" ? await body(req) : {};
    if (url.pathname.startsWith(root + "/current")) {
      const identify = url.pathname.endsWith("/identify");
      if (req.method !== (identify ? "POST" : "GET")) return json(res, 405, { error: "Method not allowed." });
      const prepared = await mutate((s) => {
        const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
        if (!customer) return { status: 401, body: { error: "Customer session expired." } };
        if (customer.status === "suspended") return { status: 403, body: { error: "This account is suspended." } };
        const inCoverage = coverage.enabled && coverage.access(req).allowed;
        const view = () => currentWifiView(s, customer.id, session.currentWifi, clock(), { inCoverage, sessionId: session.id });
        if (!identify) {
          const voucher = s.vouchers.find((v) => v.customerId === customer.id && v.status === "active");
          if (inCoverage && voucher && (!voucher.wifiDevicesAt || +clock() - Date.parse(voucher.wifiDevicesAt) > 15000) &&
              !s.routerCommands.some((c) => c.id === "router:sync_usage:global" && c.status === "dead_letter")) enqueueRouterCommand(s, { action: "sync_usage" }, clock);
          return { status: 200, body: view() };
        }
        const candidate = input.mac ? { mac: String(input.mac).toUpperCase(), address: String(input.address || "") } : session.currentWifi;
        if (!inCoverage) return { status: 200, body: view() };
        if (!/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(candidate?.mac || "") || !/^\d{1,3}(?:\.\d{1,3}){3}$/.test(candidate?.address || "") || candidate.address.split(".").some((part) => +part > 255)) return { status: 200, body: { state: "unknown", checkedAt: null, message: "Open Wi-Fi sign-in on this device to identify its connection." } };
        if (session.wifiIdentifyAt && +clock() - Date.parse(session.wifiIdentifyAt) < 5000) return { status: 429, body: { error: "Wait a moment before identifying this device again." } };
        session.wifiIdentifyAt = clock().toISOString();
        delete session.currentWifi;
        return { sessionId: session.id, customerId: customer.id, revision: routerRevision(s), candidate: { mac: candidate.mac, address: candidate.address } };
      });
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
        if (!session || session.id !== prepared.sessionId || !s.customers.some((c) => c.id === session.customerId && c.status !== "suspended")) return { status: 401, body: { error: "Customer session expired." } };
        if (routerRevision(s) !== prepared.revision || target?.server !== "ndahi-hotspot" || target.mac !== prepared.candidate.mac || target.address !== prepared.candidate.address || !target.hostId) return { status: 409, body: { error: "The router connection changed. Open Wi-Fi sign-in again." } };
        session.currentWifi = { ...prepared.candidate, sessionId: session.id, loginAddress: target.loginAddress, routerRevision: prepared.revision, verifiedAt: clock().toISOString() };
        return { status: 200, body: currentWifiView(s, session.customerId, session.currentWifi, clock(), { sessionId: session.id }) };
      });
      return json(res, result.status, result.body);
    }
    const result = await mutate(async (s) => {
      const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
      if (!customer) return { status: 401, body: { error: "Customer session expired." } };
      if (customer.status === "suspended") return { status: 403, body: { error: "This account is suspended." } };
      const main = () => ({ mainDevice: mainDeviceView(s, customer), isMainController: isMainController(req, customer, pepper, previousPepper), setupRequired: !customer.wifiMainDevice?.controllerHash,
        authenticatorEnrolled: Boolean(customer.totpSecret), passkeys: Boolean(customer.passkeys?.length),
        approvedDevices: (s.wifiDeviceGrants || []).filter((g) => g.customerId === customer.id && (g.status === "approved" || deviceRevocation(s, customer.id, g.mac)))
          .map((g) => { const operation = deviceRevocation(s, customer.id, g.mac); return { id: g.id, mac: g.mac, name: deviceName(g.name),
            main: customer.wifiMainDevice?.mac === g.mac && customer.wifiMainDevice.routerRevision === g.routerRevision,
            routerChanged: g.routerRevision !== routerRevision(s), ...(operation ? { removal: operation.status === "dead_letter" ? "failed" : "pending" } : {}) }; }) });
      if (url.pathname === root && req.method === "GET") return { status: 200, body: main() };
      if (req.method !== "POST" || url.pathname === root) return { status: 405, body: { error: "POST required." } };
      if (url.pathname.startsWith(root + "/forget")) {
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
        if (!proof.verified || (customer.totpSecret && !verifyTotp(customer.totpSecret, String(input.otp || ""), +clock()))) {
          return { status: 401, body: { code: "VERIFICATION_FAILED", error: "Could not verify account ownership.", ...recordPinFailure(s, customer, req, customer.phone) } };
        }
        clearPinFailures(customer);
        if (grant.status === "revoked") return { status: deviceRevocation(s, customer.id, grant.mac) ? 202 : 200, body: main() };
        const requests = s.wifiPairingRequests.filter((p) => p.customerId === customer.id && p.mac === grant.mac && ["pending", "awaiting_code", "connecting"].includes(p.status));
        if (requests.some((p) => s.routerCommands.some((c) => c.id === p.commandId && c.status === "processing"))) {
          return { status: 409, body: { error: "This device has a connection being confirmed. Wait for it to finish, then forget it." } };
        }
        for (const p of requests) {
          p.status = "cancelled"; p.updatedAt = clock().toISOString(); p.message = "Saved device approval was removed. Request fresh access.";
          delete p.codeHash; delete p.codeNonce;
          const command = s.routerCommands.find((c) => c.id === p.commandId);
          if (command && ["queued", "retry"].includes(command.status)) {
            command.status = "processed"; command.result = "cancelled"; command.processedAt = clock().toISOString(); command.nextAttemptAt = null;
            delete command.leaseToken; delete command.leaseUntil;
          }
        }
        grant.status = "revoked"; grant.revokedAt = clock().toISOString();
        if (grant.routerRevision === routerRevision(s)) {
          const command = enqueueRouterCommand(s, { action: "revoke_wifi_device", targetId: randomUUID() }, clock);
          grant.revocationCommandId = command.id;
          command.customerId = customer.id; command.grantId = grant.id; command.routerRevision = grant.routerRevision;
        }
        const removedMain = customer.wifiMainDevice?.mac === grant.mac && customer.wifiMainDevice.routerRevision === grant.routerRevision;
        if (removedMain) delete customer.wifiMainDevice;
        sec(s, "customer.wifi_device.forgotten", req, { customerId: customer.id, main: removedMain });
        queueSecurityAlert(s, { customerId: customer.id, kind: "wifi_device_forgotten", subject: "A saved NDAHI Wi-Fi device was removed",
          lines: ["A device's saved approval was removed after account-owner verification. It will need fresh approval to reconnect."] }, clock());
        return { status: grant.revocationCommandId ? 202 : 200, body: main(),
          ...(removedMain ? { cookie: cookie("ndahi_main_device", "", 0, secureCookies) } : {}) };
      }
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
      // Main-device selection/linking keeps fresh PIN/passkey proof; an enrolled
      // authenticator is optional here. Main-device removal retains its check.
      const otp = String(input.otp || "").trim(), checkAuthenticator = customer.totpSecret && (!selecting || Boolean(otp));
      if (!proof.verified || (checkAuthenticator && !verifyTotp(customer.totpSecret, otp, +clock()))) {
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
