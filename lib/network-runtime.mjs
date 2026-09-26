import { RouterHotspot } from "./router-hotspot.mjs";
import { allowedEndpoint, unseal } from "./network-secrets.mjs";

export function savedRouterAdapter({ store, env, fallback, factory = (connection) => new RouterHotspot(connection) }) {
  const methods = ["syncVoucher", "disconnectDevice", "disconnectVoucher", "readUsage", "readState", "markInactive"];
  return Object.fromEntries(methods.map((method) => [method, async (...args) => {
    const state = await store.snapshot();
    if (!state.networkSetup?.runtimeRouterEnabled) return fallback[method](...args);
    const connection = state.networkSetup.connections?.router;
    if (!connection || connection.mode !== "live") throw Error("The active saved router connection is unavailable.");
    const secret = unseal(connection.secret, env);
    allowedEndpoint(secret.url, env);
    return factory(secret)[method](...args);
  }]));
}
