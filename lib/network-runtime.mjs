import { RouterHotspot } from "./router-hotspot.mjs";
import { allowedEndpoint, unseal } from "./network-secrets.mjs";
import { approvalPolicy } from "./wifi-approval.mjs";

export function savedRouterAdapter({ store, env, fallback, factory = (connection) => new RouterHotspot(connection) }) {
  const methods = ["syncVoucher", "disconnectDevice", "disconnectWifiDevice", "connectWifiDevice", "readGuestDevice", "disconnectVoucher", "readUsage", "readState", "markInactive"];
  return Object.fromEntries(methods.map((method) => [method, async (...args) => {
    const state = await store.snapshot();
    if (!state.networkSetup?.runtimeRouterEnabled) {
      if (approvalPolicy(state)) throw Error("Private device approval requires the saved live router. Restore that connection before retrying.");
      if (typeof fallback[method] !== "function") throw Error("The router adapter does not support confirmed device disconnection.");
      return fallback[method](...args);
    }
    const connection = state.networkSetup.connections?.router;
    if (!connection || connection.mode !== "live") throw Error("The active saved router connection is unavailable.");
    const secret = unseal(connection.secret, env);
    allowedEndpoint(secret.url, env);
    if (method === "syncVoucher" && approvalPolicy(state)) args[0] = { ...args[0], approvalRequired: true };
    return factory({ ...secret, approvalKey: env.NETWORK_CONFIG_KEY })[method](...args);
  }]));
}
