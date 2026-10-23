import { requestJson } from "./compat.js";
export async function loadAuthenticationPolicy() {
  const { response, body } = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/authentication-policy", { credentials: "include", cache: "no-store" });
  if (!response.ok) throw Error("Sign-in methods could not be checked.");
  return body;
}
export function mountAuthenticationMigration({ container } = {}) { if (container) container.remove(); return {}; }
