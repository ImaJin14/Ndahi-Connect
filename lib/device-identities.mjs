import { hashSecret, safeEqual } from "./security.mjs";
import { cookies } from "./api/http.mjs";

// A hostname is a display label supplied by an untrusted network client.
export const deviceName = (value) => typeof value === "string"
  ? value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "").trim().slice(0, 80) : "";
export const routerRevision = (s) => s.networkSetup?.connections?.router?.revision || "";
export const isMainDevice = (s, customer, mac) => Boolean(customer?.wifiMainDevice &&
  customer.wifiMainDevice.mac === mac && customer.wifiMainDevice.routerRevision === routerRevision(s));
export function mainDeviceView(s, customer) {
  const main = customer?.wifiMainDevice;
  if (!main) return null;
  const device = s.vouchers.filter((v) => v.customerId === customer.id && v.status === "active")
    .flatMap((v) => v.wifiDevices || []).find((d) => isMainDevice(s, customer, d.mac));
  return { mac: main.mac, name: deviceName(device?.name) || deviceName(main.name),
    selectedAt: main.selectedAt, routerChanged: main.routerRevision !== routerRevision(s) };
}
export function isMainController(req, customer, pepper, previousPepper = "") {
  const main = customer?.wifiMainDevice, token = cookies(req).ndahi_main_device;
  if (!main?.controllerHash || !token || !customer.pinHash) return false;
  // Recovery/PIN changes revoke control even if a remembered cookie survives.
  return [pepper, previousPepper].filter(Boolean).some((secret) =>
    safeEqual(main.controllerHash, hashSecret(token, secret)) &&
    safeEqual(main.pinVersion, hashSecret(customer.pinHash, secret)));
}
