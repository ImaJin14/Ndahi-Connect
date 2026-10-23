import { json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createAuthenticatorManagementRoutes() {
  return async function (req, res, url) {
    if (!url.pathname.startsWith("/api/account/security/mfa") && url.pathname !== "/api/account/security/recovery-codes/generate") return NOT_HANDLED;
    return json(res, 410, { code: "AUTHENTICATOR_RETIRED", error: "Use your PIN or passkey. Account backup recovery is available in Account." });
  };
}
