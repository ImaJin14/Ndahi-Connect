import { body, json, cookie } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { sec } from "./state.mjs";
import { secureToken, hashSecret, verifyTotp } from "../security.mjs";
import { profileProofOptions, verifyProfileProof } from "../profile-proof.mjs";
import { deviceName, mainDeviceView, isMainController, routerRevision } from "../device-identities.mjs";
import { requestWifiDisconnect, wifiDeviceView, wifiReadingMaxAgeMs } from "../wifi-devices.mjs";
import { queueSecurityAlert } from "../security-alerts.mjs";
import { approveDevice } from "../wifi-approval.mjs";

const root = "/api/account/device-management";
export function createDeviceManagementRoutes({ mutate, auth, clock, pepper, previousPepper, secureCookies,
  customerRpID, customerOrigin, pinThrottle, recordPinFailure, clearPinFailures, routerProcessor, env }) {
  return async (req, res, url) => {
    if (![root, root + "/main", root + "/main/options", root + "/disconnect", root + "/disconnect/options"].includes(url.pathname)) return NOT_HANDLED;
    if (!["GET", "POST"].includes(req.method)) return json(res, 405, { error: "Method not allowed." });
    const input = req.method === "POST" ? await body(req) : {};
    const result = await mutate(async (s) => {
      const session = auth(req, s, "dashboardSessions"), customer = session && s.customers.find((c) => c.id === session.customerId);
      if (!customer) return { status: 401, body: { error: "Customer session expired." } };
      if (customer.status === "suspended") return { status: 403, body: { error: "This account is suspended." } };
      const main = () => ({ mainDevice: mainDeviceView(s, customer), isMainController: isMainController(req, customer, pepper, previousPepper), setupRequired: !customer.wifiMainDevice?.controllerHash,
        authenticatorEnrolled: Boolean(customer.totpSecret), passkeys: Boolean(customer.passkeys?.length) });
      if (url.pathname === root && req.method === "GET") return { status: 200, body: main() };
      if (req.method !== "POST" || url.pathname === root) return { status: 405, body: { error: "POST required." } };
      const mac = String(input.mac || "").toUpperCase();
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
      if (!selecting) return requestWifiDisconnect(s, voucher, input, clock, { ownerVerified: true });
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
