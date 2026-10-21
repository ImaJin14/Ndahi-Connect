import { randomUUID } from "node:crypto";
import { body, json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { phone, sec } from "./state.mjs";
import { hashSecret, normalizeActivationCode, safeEqual } from "../security.mjs";
import { isMainController, routerRevision, deviceName } from "../device-identities.mjs";
import { pairingEnabled, pairingLifetimeMs, pairingCode, matchesPairingSecret, pairingView, pairingVoucher, pendingPairing } from "../wifi-pairing.mjs";
import { approvalPolicy, approvalAvailable, deviceGrant, deviceRevocation } from "../wifi-approval.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { wifiReadingMaxAgeMs, requestWifiRefresh } from "../wifi-devices.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";

const publicRoot = "/api/wifi/pairing", accountRoot = "/api/account/device-management/pairing", ownerConnect = "/api/account/device-management/connect";
const outcome = (status, body) => ({ status, body });
export function createWifiPairingRoutes({ mutate, auth, clock, coverage, router, routerProcessor, pepper, previousPepper, env,
  customerRpID, customerOrigin, pinThrottle, recordPinFailure, clearPinFailures }) {
  const available = (s) => pairingEnabled(s) && env.COVERAGE_ACCESS_ENABLED === "true" && env.NETWORK_QUEUE_ENABLED !== "false";
  const codeFor = (p) => {
    if (p.status !== "awaiting_code" || !p.codeNonce) return undefined;
    for (const key of [pepper, previousPepper].filter(Boolean)) {
      const code = pairingCode(p.id, p.codeNonce, key);
      if (safeEqual(p.codeHash || "", hashSecret(code, key))) return code;
    }
    return undefined;
  };
  const controller = (req, s, c) => c?.status !== "suspended" && isMainController(req, c, pepper, previousPepper) && c.wifiMainDevice.routerRevision === routerRevision(s);
  const view = (s, p) => {
    const c = s.customers.find((c) => c.id === p.customerId), main = c?.wifiMainDevice;
    // Connected is a historical operation result. Permit a browser completion
    // handoff only while its targeted confirmation is recent and still valid.
    const age = +clock() - Date.parse(p.updatedAt), v = p.status === "connected" && pairingVoucher(s, p, clock());
    const completionReady = Boolean(v && age >= -5000 && age <= wifiReadingMaxAgeMs && approvalAvailable(s) &&
      p.routerRevision === routerRevision(s) && deviceGrant(s, p.customerId, p.mac) && !deviceRevocation(s, p.customerId, p.mac) &&
      v.wifiDevices?.some((d) => d.mac === p.mac && d.address === p.target?.loginAddress && d.sessionId && d.startedAt) &&
      !s.routerCommands.some((command) => command.action === "disconnect_wifi_device" && command.device?.voucherId === v.id &&
        command.device.mac === p.mac && ["queued", "processing", "retry"].includes(command.status)));
    return { ...pairingView(p), mainRequired: !main?.controllerHash || main.routerRevision !== routerRevision(s) || !matchesPairingSecret(c.pinHash, main.pinVersion, pepper, previousPepper),
      ...(p.status === "connected" ? { completionReady } : {}),
      ...(["bootstrap", "recovery"].includes(p.kind) ? { firstDevice: true } : {}) };
  };
  const resume = (s, p) => pendingPairing(p) ? outcome(200, { request: view(s, p) })
    : outcome(409, { code: "PAIRING_RESTART_REQUIRED", error: "That earlier connection attempt has finished. Start a new attempt to confirm this device's current Wi-Fi connection." });
  function queue(s, p) {
    const v = pairingVoucher(s, p, clock());
    if (!v) return outcome(409, { error: "The bundle is unavailable, expired or out of data." });
    if (deviceRevocation(s, p.customerId, p.mac)) return outcome(409, { code: "DEVICE_DISCONNECT_PENDING", error: "Wait for this device's saved access to be removed from the router before approving it again." });
    if (s.routerCommands.some((c) => c.action === "disconnect_wifi_device" && c.device?.voucherId === v.id && c.device?.mac === p.mac && ["queued", "processing", "retry"].includes(c.status))) return outcome(409, { code: "DEVICE_DISCONNECT_PENDING", error: "Wait for this device's disconnection to be confirmed before reconnecting it." });
    if (!Number.isFinite(Date.parse(v.wifiDevicesAt)) || +clock() - Date.parse(v.wifiDevicesAt) > wifiReadingMaxAgeMs || Date.parse(v.wifiDevicesAt) > +clock() + 5000) {
      const refresh = requestWifiRefresh(s, clock);
      if (refresh.status >= 400) return outcome(refresh.status, { code: refresh.body.code, error: refresh.body.error });
      return { ...outcome(409, { code: "DEVICE_REFRESH_REQUIRED", error: "Refreshing connected devices. Wait a moment and try again." }), wakeRouter: true };
    }
    const reserved = s.wifiPairingRequests.filter((x) => x.id !== p.id && x.voucherId === v.id && x.status === "connecting").length;
    if ((v.wifiDevices || []).filter((d) => d.mac !== p.mac).length + reserved >= v.deviceLimit) return outcome(409, { error: "All device slots are in use. Disconnect a device and wait for confirmation." });
    p.status = "connecting"; p.updatedAt = clock().toISOString();
    const command = enqueueRouterCommand(s, { action: "connect_wifi_device", targetId: p.id }, clock);
    p.commandId = command.id; command.customerId = p.customerId;
    return outcome(202, { request: view(s, p) });
  }
  async function readTarget(input) {
    if (typeof router.readGuestDevice !== "function") throw Error("The router cannot verify new devices.");
    const result = await router.readGuestDevice({ mac: String(input.mac || "").toUpperCase(), address: String(input.address || "") });
    if (!result || result.server !== "ndahi-hotspot" || result.mac !== String(input.mac || "").toUpperCase() || result.address !== input.address || !result.hostId) throw Error("The router did not verify this device.");
    return result;
  }
  function create(s, prepared, input, device) {
    const p = { id: randomUUID(), customerId: prepared.customerId, voucherId: prepared.voucherId,
      routerRevision: prepared.revision, mac: device.mac, name: deviceName(device.name),
      target: { mac: device.mac, address: device.address, loginAddress: device.loginAddress, hostId: device.hostId },
      keyHash: hashSecret(input.key, pepper), protocol: 2, status: "pending", at: clock().toISOString(),
      expiresAt: new Date(Math.min(+clock() + pairingLifetimeMs, Date.parse(s.vouchers.find((v) => v.id === prepared.voucherId).expiresAt))).toISOString(), codeAttempts: 0 };
    s.wifiPairingRequests.push(p); return p;
  }
  return async (req, res, url) => {
    const publicPath = ["config", "request", "status", "cancel", "redeem"].some((p) => url.pathname === publicRoot + "/" + p),
      accountPath = [accountRoot, accountRoot + "/approve", accountRoot + "/decline", accountRoot + "/manual", ownerConnect, ownerConnect + "/options"].includes(url.pathname);
    if (!publicPath && !accountPath) return NOT_HANDLED;
    if (url.pathname === publicRoot + "/config") {
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
      return json(res, 200, await mutate((s) => ({ enabled: available(s), approvalRequired: approvalPolicy(s) })));
    }
    if (req.method === "GET" && url.pathname === accountRoot) {
      const result = await mutate((s) => {
        const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((c) => c.id === a.customerId);
        if (!c) return outcome(401, { error: "Customer session expired." });
        const controls = controller(req, s, c);
        return outcome(200, { enabled: available(s), isMainController: controls, mainRequired: !c.wifiMainDevice,
          requests: s.wifiPairingRequests.filter((p) => p.customerId === c.id).slice(-20).reverse().map((p) => ({ ...view(s, p),
            ...(controls && p.approvedBy === c.wifiMainDevice.controllerHash && codeFor(p) ? { approvalCode: codeFor(p) } : {}) })) });
      }); return json(res, result.status, result.body);
    }
    if (req.method !== "POST") return json(res, 405, { error: "POST required." });
    const input = await body(req);
    const start = url.pathname === publicRoot + "/request", owned = [ownerConnect, ownerConnect + "/options", accountRoot + "/manual"].includes(url.pathname);
    if (start || owned) {
      if (coverage?.access(req).allowed === false && url.pathname !== accountRoot + "/manual") return json(res, 403, { code: "WIFI_REQUIRED", error: "Join NDAHI Wi-Fi on this device before requesting access." });
      if (!/^[a-f0-9]{32,64}$/.test(String(input.key || ""))) return json(res, 400, { error: "Reload the connection page and try again." });
      const prepared = await mutate(async (s) => {
        const a = owned && auth(req, s, "dashboardSessions"), c = owned ? a && s.customers.find((c) => c.id === a.customerId) : s.customers.find((c) => c.phone === phone(input.phone));
        if (owned && !c) return outcome(401, { error: "Customer session expired." });
        if (owned && c.status === "suspended") return outcome(403, { error: "This account is suspended." });
        const v = c && s.vouchers.find((v) => v.customerId === c.id && (owned ? v.status === "active" : safeEqual(v.code, normalizeActivationCode(input.code))));
        if (v && c.status !== "suspended" && v.status === "active" && v.routerSyncStatus !== "synchronized") {
          if (v.routerSyncStatus === "dead_letter") return outcome(503, { error: "Wi-Fi preparation needs support review. Do not pay again." });
          return { ...outcome(owned ? 202 : 409, { code: "HOTSPOT_PENDING", error: "Your bundle is still being prepared. Please wait and try again." }), wakeRouter: true };
        }
        if (!v || !pairingVoucher(s, { customerId: c.id, voucherId: v.id }, clock())) return outcome(401, { error: "Check the account number and active voucher. Your bundle must have data remaining." });
        if (!approvalAvailable(s) || env.NETWORK_QUEUE_ENABLED === "false") return outcome(503, { error: "Device access is unavailable. Contact the account owner." });
        const grant = deviceGrant(s, c.id, String(input.mac || "").toUpperCase());
        if (!available(s) && !grant) return outcome(503, { error: "New device approvals are currently paused." });
        const manual = url.pathname === accountRoot + "/manual";
        if (manual && (!controller(req, s, c) || input.confirm !== true)) return outcome(403, { error: "Use the main browser and confirm this is your device." });
        const existing = s.wifiPairingRequests.find((p) => p.customerId === c.id && matchesPairingSecret(input.key, p.keyHash, pepper, previousPepper));
        if (existing) return resume(s, existing);
        let recoveryVerified = false;
        if (owned && !manual && !grant && (c.wifiFirstConnectedAt || c.wifiMainDevice)) {
          const proofTarget = JSON.stringify([input.mac, input.address, routerRevision(s)]);
          if (url.pathname.endsWith("/options")) {
            if (!c.passkeys?.length) return outcome(400, { error: "Use your PIN to verify recovery." });
            return outcome(200, await profileProofOptions({ s, customer: c, session: a, type: "wifi_recovery", target: proofTarget, clock, rpID: customerRpID }));
          }
          if (input.recover !== true) return outcome(409, { code: "DEVICE_APPROVAL_REQUIRED", error: "Request access from the main device, or verify ownership to recover a lost main device." });
          const proof = await verifyProfileProof({ s, customer: c, session: a, input, type: "wifi_recovery", target: proofTarget, clock, rpID: customerRpID, origin: customerOrigin, pinThrottle });
          if (proof.throttle) return outcome(429, { error: "Verification is temporarily locked.", ...proof.throttle });
          if (!proof.verified) return outcome(401, { code: "VERIFICATION_FAILED", error: "Could not verify account ownership.", ...recordPinFailure(s, c, req, c.phone) });
          clearPinFailures(c);
          recoveryVerified = true;
        }
        if (url.pathname.endsWith("/options")) return outcome(400, { error: "Owner recovery is not needed for this device." });
        const recent = s.wifiPairingRequests.filter((p) => p.customerId === c.id && Date.parse(p.at) > +clock() - 900000);
        if (recent.length >= 10 || recent.filter(pendingPairing).length >= 3) return outcome(429, { error: "Too many access requests. Finish an existing request or try again later." });
        return { customerId: c.id, voucherId: v.id, revision: routerRevision(s), sessionId: a?.id, pinVersion: c.pinHash, recoveryVerified };
      });
      if (prepared.status) {
        json(res, prepared.status, prepared.body);
        if (prepared.wakeRouter) routerProcessor.wake();
        return;
      }
      let device;
      try { device = await readTarget(input); } catch (error) { return json(res, error.permanent ? 409 : 503, { error: error.permanent ? error.message : "The router could not verify this device. Stay on NDAHI Wi-Fi and try again." }); }
      const result = await mutate((s) => {
        const c = s.customers.find((c) => c.id === prepared.customerId), a = owned && auth(req, s, "dashboardSessions");
        if (!approvalAvailable(s) || routerRevision(s) !== prepared.revision || !pairingVoucher(s, prepared, clock()) ||
          (owned && (!a || a.id !== prepared.sessionId || c.pinHash !== prepared.pinVersion))) return outcome(409, { error: "Account, network or bundle details changed. Try again." });
        const existing = s.wifiPairingRequests.find((p) => p.customerId === c.id && matchesPairingSecret(input.key, p.keyHash, pepper, previousPepper));
        if (existing) return resume(s, existing);
        const pending = s.wifiPairingRequests.filter((p) => p.customerId === c.id && pendingPairing(p));
        if (pending.length >= 3 || pending.some((p) => p.mac === device.mac)) return outcome(409, { error: "This device already has an access request. Continue that request or wait for it to expire." });
        const grant = deviceGrant(s, c.id, device.mac), manual = url.pathname === accountRoot + "/manual";
        if (manual && !controller(req, s, c)) return outcome(403, { error: "Main browser control changed. Verify your main device again." });
        const first = owned && !manual && !grant && !c.wifiFirstConnectedAt && !c.wifiMainDevice;
        if (owned && !manual && !grant && !first && !prepared.recoveryVerified) return outcome(409, { error: "The first connection changed. Request approval or verify owner recovery." });
        if (first && pending.some((p) => p.kind === "bootstrap")) return outcome(409, { error: "The first device is already connecting. Wait for confirmation." });
        const p = create(s, prepared, input, device);
        if (grant) { p.kind = "reconnect"; p.grantApprovedAt = grant.approvedAt; }
        else if (owned && !manual) {
          p.kind = first ? "bootstrap" : "recovery"; p.ownerSessionId = a.id; p.ownerPinVersion = hashSecret(c.pinHash, pepper);
        } else if (manual) { p.kind = "manual"; p.approvedBy = c.wifiMainDevice.controllerHash; }
        if (grant || owned) {
          const queued = queue(s, p);
          if (queued.status !== 202) s.wifiPairingRequests = s.wifiPairingRequests.filter((x) => x.id !== p.id);
          else if (p.kind === "recovery" && c.wifiMainDevice) {
            // Failed admission must leave the working controller intact.
            c.wifiMainDevice.controllerHash = "";
            sec(s, "customer.main_device.recovered", req, { customerId: c.id });
            queued.body.request = view(s, p);
          }
          return queued;
        }
        sec(s, "wifi_pairing.requested", req, { customerId: c.id, requestId: p.id });
        return outcome(201, { request: view(s, p) });
      });
      json(res, result.status, result.body);
      if (result.status === 202 || result.wakeRouter) routerProcessor.wake();
      return;
    }
    const result = await mutate((s) => {
      if (publicPath) {
        const p = s.wifiPairingRequests.find((p) => p.id === input.id && matchesPairingSecret(String(input.key || ""), p.keyHash, pepper, previousPepper));
        if (!p) return outcome(404, { error: "Access request not found. Request access again." });
        if (url.pathname.endsWith("/status")) {
          if (pendingPairing(p) && p.polledAt && +clock() - Date.parse(p.polledAt) < 1500) return outcome(429, { error: "Wait a moment before checking again." });
          p.polledAt = clock().toISOString(); return outcome(200, { request: view(s, p) });
        }
        if (url.pathname.endsWith("/cancel")) {
          if (!["pending", "awaiting_code"].includes(p.status)) return outcome(409, { error: "The request is already being handled. Check its status." });
          p.status = "cancelled"; delete p.codeHash; delete p.codeNonce; p.updatedAt = clock().toISOString(); return outcome(200, { request: view(s, p) });
        }
        if (p.status === "connecting" || p.status === "connected") return outcome(200, { request: view(s, p) });
        if (p.status !== "awaiting_code" || !available(s)) return outcome(409, { error: "Wait for the main device to approve this request, or request access again if it expired." });
        const c = s.customers.find((c) => c.id === p.customerId);
        if (!c?.wifiMainDevice || c.wifiMainDevice.controllerHash !== p.approvedBy || p.routerRevision !== routerRevision(s) ||
          !matchesPairingSecret(c.pinHash, c.wifiMainDevice.pinVersion, pepper, previousPepper)) return outcome(409, { error: "Main-device control changed. Request approval again." });
        if (!/^\d{6}$/.test(String(input.approvalCode || "")) || !matchesPairingSecret(input.approvalCode, p.codeHash, pepper, previousPepper)) {
          p.codeAttempts++;
          if (p.codeAttempts >= 5) { p.status = "failed"; p.updatedAt = clock().toISOString(); delete p.codeHash; delete p.codeNonce; }
          return outcome(401, { code: "VERIFICATION_FAILED", error: p.status === "failed" ? "Too many incorrect codes. Request access again." : "The approval code is incorrect. Ask the main device for its current code." });
        }
        const queued = queue(s, p);
        if (queued.status === 202) { p.redeemedAt = clock().toISOString(); delete p.codeHash; delete p.codeNonce; }
        return queued;
      }
      const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((c) => c.id === a.customerId);
      if (!c) return outcome(401, { error: "Customer session expired." });
      if (!controller(req, s, c)) return outcome(403, { error: "Set a main device, then use its controlling browser to approve requests." });
      const p = s.wifiPairingRequests.find((p) => p.id === input.id && p.customerId === c.id);
      if (!p) return outcome(404, { error: "Access request not found." });
      if (!["pending", "awaiting_code"].includes(p.status)) return outcome(409, { error: "This request has already been handled or expired." });
      if (url.pathname.endsWith("/decline")) {
        p.status = p.status === "awaiting_code" ? "cancelled" : "declined"; p.updatedAt = clock().toISOString(); delete p.codeHash; delete p.codeNonce;
        return outcome(200, { request: view(s, p) });
      }
      if (!available(s) || p.routerRevision !== routerRevision(s) || !pairingVoucher(s, p, clock())) return outcome(409, { error: "Network or bundle details changed. Request access again." });
      if (p.status === "pending" || p.approvedBy !== c.wifiMainDevice.controllerHash) {
        p.codeNonce = randomUUID(); p.approvedBy = c.wifiMainDevice.controllerHash; p.status = "awaiting_code";
        p.expiresAt = new Date(Math.min(+clock() + pairingLifetimeMs, Date.parse(s.vouchers.find((v) => v.id === p.voucherId).expiresAt))).toISOString();
        p.codeHash = hashSecret(pairingCode(p.id, p.codeNonce, pepper), pepper); p.updatedAt = clock().toISOString();
        sec(s, "wifi_pairing.approved", req, { customerId: c.id, requestId: p.id });
      }
      return outcome(200, { request: view(s, p), approvalCode: codeFor(p) });
    });
    json(res, result.status, result.body);
    if (result.status === 202 || result.wakeRouter) routerProcessor.wake();
  };
}
