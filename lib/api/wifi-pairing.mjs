import { randomUUID } from "node:crypto";
import { body, json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { phone, sec } from "./state.mjs";
import { hashSecret, normalizeActivationCode, safeEqual } from "../security.mjs";
import { isMainController, routerRevision, deviceName } from "../device-identities.mjs";
import { pairingEnabled, pairingLifetimeMs, pairingCode, matchesPairingSecret, pairingView, pairingVoucher, pendingPairing } from "../wifi-pairing.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { wifiReadingMaxAgeMs, requestWifiRefresh } from "../wifi-devices.mjs";

const publicRoot = "/api/wifi/pairing", accountRoot = "/api/account/device-management/pairing";
const outcome = (status, body) => ({ status, body });
export function createWifiPairingRoutes({ mutate, auth, clock, coverage, router, routerProcessor, pepper, previousPepper, env }) {
  const available = (s) => pairingEnabled(s) && env.COVERAGE_ACCESS_ENABLED === "true" && env.NETWORK_QUEUE_ENABLED !== "false";
  const codeFor = (p, key) => {
    if (!pendingPairing(p)) return undefined;
    const secret = [pepper, previousPepper].filter(Boolean).find((secret) => safeEqual(p.keyHash, hashSecret(key, secret)));
    return secret ? pairingCode(p.id, key, secret) : undefined;
  };
  return async (req, res, url) => {
    const publicPath = [publicRoot + "/config", publicRoot + "/request", publicRoot + "/status", publicRoot + "/cancel"].includes(url.pathname),
      accountPath = [accountRoot, accountRoot + "/approve", accountRoot + "/decline"].includes(url.pathname);
    if (!publicPath && !accountPath) return NOT_HANDLED;
    if (url.pathname === publicRoot + "/config") {
      if (req.method !== "GET") return json(res, 405, { error: "Method not allowed." });
      return json(res, 200, await mutate((s) => ({ enabled: available(s) })));
    }
    if (req.method === "GET" && url.pathname === accountRoot) {
      const result = await mutate((s) => {
        const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
        if (!customer) return outcome(401, { error: "Customer session expired." });
        return outcome(200, { enabled: available(s), isMainController: customer.status !== "suspended" &&
          isMainController(req, customer, pepper, previousPepper) && customer.wifiMainDevice.routerRevision === routerRevision(s),
          requests: (s.wifiPairingRequests || []).filter((p) => p.customerId === customer.id).slice(-20).reverse().map(pairingView) });
      });
      return json(res, result.status, result.body);
    }
    if (req.method !== "POST") return json(res, 405, { error: "Method not allowed." });
    const input = await body(req);
    if (url.pathname === publicRoot + "/request") {
      if (!/^[a-f0-9]{32,64}$/.test(String(input.key || ""))) return json(res, 400, { error: "Reload the connection page and request a new code." });
      if (coverage?.access(req).allowed === false) return json(res, 403, { code: "WIFI_REQUIRED", error: "Join NDAHI Wi-Fi on the new device before requesting a connection." });
      const prepared = await mutate((s) => {
        if (!available(s)) return outcome(503, { error: "Assisted connection is not enabled. Use voucher and PIN to connect." });
        const customer = s.customers.find((c) => c.phone === phone(input.phone)),
          voucher = customer && s.vouchers.find((v) => v.customerId === customer.id && safeEqual(v.code, normalizeActivationCode(input.code)));
        if (!voucher || !pairingVoucher(s, { customerId: customer.id, voucherId: voucher.id }, clock())) return outcome(401, { error: "Check the account number and active voucher. Your bundle must have data remaining." });
        if (!customer.wifiMainDevice || customer.wifiMainDevice.routerRevision !== routerRevision(s)) return outcome(409, { error: "The account owner must select a main device first." });
        const existing = s.wifiPairingRequests.find((p) => p.customerId === customer.id && matchesPairingSecret(input.key, p.keyHash, pepper, previousPepper));
        if (existing) return outcome(200, { request: pairingView(existing), code: codeFor(existing, input.key) });
        const recent = s.wifiPairingRequests.filter((p) => p.customerId === customer.id && Date.parse(p.at) > +clock() - 900000);
        if (recent.length >= 10 || recent.filter(pendingPairing).length >= 3) return outcome(429, { error: "Too many connection requests. Finish or decline existing requests, or try again later." });
        return { customerId: customer.id, voucherId: voucher.id, revision: routerRevision(s) };
      });
      if (prepared.status) return json(res, prepared.status, prepared.body);
      let target;
      try {
        if (typeof router.readGuestDevice !== "function") throw Error("Unsupported bridge");
        target = await router.readGuestDevice({ mac: String(input.mac || "").toUpperCase(), address: String(input.address || "") });
      } catch (error) {
        return json(res, error.permanent ? 409 : 503, { error: error.permanent ? error.message : "The router could not verify the new device. Stay on NDAHI Wi-Fi and try again." });
      }
      // Hints arriving from router HTML are untrusted candidates. The router's
      // fresh guest row pins the target; creation alone grants no access.
      if (!target || target.server !== "ndahi-hotspot" || target.mac !== String(input.mac || "").toUpperCase() ||
          target.address !== input.address || !target.hostId) return json(res, 503, { error: "The router did not verify the new device." });
      const result = await mutate((s) => {
        if (!available(s) || routerRevision(s) !== prepared.revision ||
            !pairingVoucher(s, prepared, clock()) || !s.customers.find((c) => c.id === prepared.customerId)?.wifiMainDevice) {
          return outcome(409, { error: "Network or bundle details changed. Request a new connection." });
        }
        const existing = s.wifiPairingRequests.find((p) => p.customerId === prepared.customerId && matchesPairingSecret(input.key, p.keyHash, pepper, previousPepper));
        if (existing) return outcome(200, { request: pairingView(existing), code: codeFor(existing, input.key) });
        const recent = s.wifiPairingRequests.filter((p) => p.customerId === prepared.customerId && Date.parse(p.at) > +clock() - 900000);
        if (recent.length >= 10) return outcome(429, { error: "Too many connection requests. Try again later." });
        const active = s.wifiPairingRequests.filter((p) => p.customerId === prepared.customerId && pendingPairing(p));
        if (active.length >= 3 || active.some((p) => p.mac === target.mac)) return outcome(409, { error: "This device already has a request. Use its displayed code or wait for that request to expire." });
        const request = { id: randomUUID(), ...prepared, routerRevision: prepared.revision, mac: target.mac, name: deviceName(target.name),
          target: { mac: target.mac, address: target.address, loginAddress: target.loginAddress, hostId: target.hostId },
          keyHash: hashSecret(input.key, pepper), status: "pending", at: clock().toISOString(),
          expiresAt: new Date(Math.min(+clock() + pairingLifetimeMs, Date.parse(s.vouchers.find((v) => v.id === prepared.voucherId).expiresAt))).toISOString(),
          codeAttempts: 0 };
        delete request.revision;
        const code = pairingCode(request.id, input.key, pepper);
        request.codeHash = hashSecret(code, pepper);
        s.wifiPairingRequests.push(request);
        sec(s, "wifi_pairing.requested", req, { customerId: request.customerId, requestId: request.id });
        return outcome(201, { request: pairingView(request), code });
      });
      return json(res, result.status, result.body);
    }
    if (publicPath) {
      const result = await mutate((s) => {
        const p = s.wifiPairingRequests.find((p) => p.id === input.id && matchesPairingSecret(String(input.key || ""), p.keyHash, pepper, previousPepper));
        if (!p) return outcome(404, { error: "Connection request not found. Request a new code." });
        if (url.pathname.endsWith("/status") && pendingPairing(p)) {
          if (p.polledAt && +clock() - Date.parse(p.polledAt) < 1500) return outcome(429, { error: "Wait a moment before checking the connection again." });
          p.polledAt = clock().toISOString();
        }
        if (url.pathname.endsWith("/cancel")) {
          if (p.status !== "pending") return outcome(409, { error: "This request has already been handled. Check its connection status." });
          p.status = "cancelled"; p.updatedAt = clock().toISOString();
        }
        return outcome(200, { request: pairingView(p), ...(pendingPairing(p) ? { code: codeFor(p, input.key) } : {}) });
      });
      return json(res, result.status, result.body);
    }
    const result = await mutate((s) => {
      const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
      if (!customer) return outcome(401, { error: "Customer session expired." });
      if (customer.status === "suspended" || !isMainController(req, customer, pepper, previousPepper) || customer.wifiMainDevice.routerRevision !== routerRevision(s)) {
        return outcome(403, { error: "Use the selected main device's controlling browser to approve or decline requests." });
      }
      const p = s.wifiPairingRequests.find((p) => p.id === input.id && p.customerId === customer.id);
      if (!p) return outcome(404, { error: "Connection request not found." });
      if (p.status !== "pending") return outcome(p.status === "connecting" || p.status === "connected" ? 200 : 409, { request: pairingView(p),
        ...(p.status === "connecting" || p.status === "connected" ? {} : { error: "This request is no longer available. Request a new code." }) });
      if (url.pathname.endsWith("/decline")) {
        p.status = "declined"; p.updatedAt = clock().toISOString();
        return outcome(200, { request: pairingView(p) });
      }
      if (!available(s) || p.routerRevision !== routerRevision(s)) return outcome(409, { error: "Assisted connection is unavailable. Request a new code after setup is checked." });
      if (!/^\d{6}$/.test(String(input.code || "")) || !matchesPairingSecret(String(input.code), p.codeHash, pepper, previousPepper)) {
        p.codeAttempts++;
        if (p.codeAttempts >= 5) { p.status = "failed"; p.updatedAt = clock().toISOString(); p.message = "Too many incorrect pairing codes. Request a new code."; }
        return outcome(401, { code: "VERIFICATION_FAILED", error: "The pairing code does not match the code shown on the new device." });
      }
      const v = pairingVoucher(s, p, clock());
      if (!v) return outcome(409, { error: "The bundle is unavailable, expired or out of data." });
      if (!Number.isFinite(Date.parse(v.wifiDevicesAt)) || +clock() - Date.parse(v.wifiDevicesAt) > wifiReadingMaxAgeMs || Date.parse(v.wifiDevicesAt) > +clock() + 5000) {
        requestWifiRefresh(s, clock);
        return { ...outcome(409, { code: "DEVICE_REFRESH_REQUIRED", error: "Refreshing connected devices. Wait a moment and approve again." }), wakeRouter: true };
      }
      const reserved = s.wifiPairingRequests.filter((x) => x.id !== p.id && x.voucherId === v.id && x.status === "connecting").length;
      if ((v.wifiDevices || []).filter((d) => d.mac !== p.mac).length + reserved >= v.deviceLimit) return outcome(409, { error: "All device slots are in use. Disconnect a device and wait for confirmation before approving." });
      p.status = "connecting"; p.approvedBy = customer.wifiMainDevice.controllerHash; p.updatedAt = clock().toISOString();
      const command = enqueueRouterCommand(s, { action: "connect_wifi_device", targetId: p.id }, clock);
      p.commandId = command.id; command.customerId = customer.id;
      sec(s, "wifi_pairing.approved", req, { customerId: customer.id, requestId: p.id });
      return outcome(202, { request: pairingView(p) });
    });
    json(res, result.status, result.body);
    if ((result.status === 202 || result.wakeRouter) && env.NETWORK_QUEUE_ENABLED !== "false") routerProcessor.wake();
  };
}
