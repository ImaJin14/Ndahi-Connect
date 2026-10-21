import { sec } from "./api/state.mjs";
import { cookies } from "./api/http.mjs";
import { hashSecret, secureToken } from "./security.mjs";
import { queueSecurityAlert } from "./security-alerts.mjs";

export const signInCookie = "ndahi_signin_browser";
export const loginMethods = {
  pin: "customer.pin_login.succeeded", authenticator: "customer.otp_login.succeeded",
  passkey: "customer.passkey_login.succeeded", recovery: "customer.recovery_code_login.succeeded",
  voucher: "customer.access.succeeded", setup: "customer.account_setup.succeeded",
};
// Recognition is a quiet-notification hint, never an authentication factor or
// proof of a physical device/location. No raw recognition token is persisted.
export function recordCustomerSignIn(s, customerId, req, method, now, pepper, previousPepper) {
  let browser = cookies(req)[signInCookie];
  if (!/^[A-Za-z0-9_-]{43}$/.test(browser || "")) browser = secureToken();
  const fingerprints = [pepper, previousPepper].filter(Boolean).map((key) => hashSecret(customerId + ":" + browser, key));
  const recognized = s.securityEvents.some((e) => e.meta?.customerId === customerId && fingerprints.includes(e.meta?.browserHash) && Object.values(loginMethods).includes(e.type));
  sec(s, loginMethods[method] || loginMethods.setup, req, { customerId, browserHash: fingerprints[0], recognized,
    userAgent: String(req.headers?.["user-agent"] || "").slice(0, 200), ...(method === "recovery" ? { severity: "high" } : {}) });
  const event = s.securityEvents[0]; event.at = now.toISOString();
  if (!recognized || method === "recovery") queueSecurityAlert(s, {
    customerId, kind: method === "recovery" ? "recovery_code_used" : "unfamiliar_sign_in", sourceSignInId: event.id,
    signIn: { id: event.id, type: event.type, ip: event.ip, at: event.at, meta: { customerId, userAgent: event.meta.userAgent, recognized } },
    subject: method === "recovery" ? "A recovery code was used to sign in to your NDAHI Connect account" : "A browser signed in to your NDAHI Connect account",
    lines: [method === "recovery" ? "An unused recovery code was used for account sign-in." : "This browser was not recognized from retained sign-in history.",
      "If this was not you, open Account → Active sessions, sign out unfamiliar sessions and review account security."],
  }, now);
  return browser;
}
