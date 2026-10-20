import { createHmac, createHash } from "node:crypto";
import { routerRevision } from "./device-identities.mjs";

// Once enabled, stopping pairing must not restore public voucher passwords.
export const approvalPolicy = (s) => s.networkSetup?.deviceApproval?.version === 1;
export const approvalAvailable = (s) => approvalPolicy(s) && s.networkSetup?.runtimeRouterEnabled === true &&
  s.networkSetup.connections?.router?.mode === "live" && s.networkSetup.deviceApproval.revision === routerRevision(s);
export function privateWifiPassword(voucherId, key) {
  if (!key || key.length < 16) throw Error("Private device access credentials are not configured.");
  return createHmac("sha256", key).update(JSON.stringify(["ndahi-wifi-access-v1", voucherId])).digest("hex");
}
export const grantId = (customerId, mac) => createHash("sha256").update(JSON.stringify([customerId, mac])).digest("hex");
export function deviceGrant(s, customerId, mac) {
  return (s.wifiDeviceGrants || []).find((g) => g.customerId === customerId && g.mac === mac && g.status === "approved" && g.routerRevision === routerRevision(s));
}
export function approveDevice(s, customerId, device, now, origin) {
  s.wifiDeviceGrants ??= [];
  const id = grantId(customerId, device.mac), prior = s.wifiDeviceGrants.find((g) => g.id === id);
  const grant = { id, customerId, mac: device.mac, name: device.name || "", routerRevision: routerRevision(s),
    status: "approved", approvedAt: now.toISOString(), origin };
  if (prior) Object.assign(prior, grant); else s.wifiDeviceGrants.push(grant);
  const customer = s.customers.find((c) => c.id === customerId);
  if (customer) customer.wifiFirstConnectedAt ||= now.toISOString();
  return grant;
}
