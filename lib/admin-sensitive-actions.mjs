import { createHash, createHmac } from "node:crypto";
import { adminProofOptions, verifyAdminProof } from "./admin-proof.mjs";

export const adminRoles = new Set(["owner", "operator", "reseller", "auditor"]);
const selfService = new Set(["passkey_add", "passkey_remove"]);
const ownerActions = new Set(["staff_create", "staff_deactivate", "support_recovery"]);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
export const adminPurposeAllowed = (user, purpose) => adminRoles.has(user?.role) &&
  (selfService.has(purpose) || user.role === "owner" && ownerActions.has(purpose));

export function adminCredentialVersion(user) {
  return digest([user.id, user.username, user.role, user.passwordHash || "", (user.passkeys || [])
    .map(key => [key.id, key.publicKey, key.createdAt || ""]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}

// Both the options request and the actual mutation call this exact normalizer.
// Never persist a newly created staff member's raw password in a challenge.
export function adminActionTarget(purpose, input, user, secret) {
  let target;
  if (purpose === "passkey_add") target = [user.id];
  else if (purpose === "passkey_remove") target = [user.id, String(input.credentialId || "")];
  else if (purpose === "staff_create") {
    if (typeof secret !== "string" || !secret) throw new TypeError("Administrator proof binding requires the configured secret.");
    const username = String(input.username || "").trim().toLowerCase();
    target = [username, String(input.displayName || username).slice(0, 80), String(input.role || "auditor"),
      createHmac("sha256", secret).update(JSON.stringify(["admin-new-password-v1", String(input.password || "")])).digest("base64url")];
  } else if (purpose === "staff_deactivate") target = [String(input.userId || "")];
  else if (purpose === "support_recovery") target = [String(input.customerId || ""),
    String(input.recoveryPurpose || (input.purpose === "authenticator" ? "authenticator" : "pin")),
    String(input.caseReference || "").trim(), String(input.reason || "").trim(), String(input.verificationMethod || ""), input.confirmedIdentity === true];
  else throw new TypeError("Unsupported administrator verification purpose.");
  return JSON.stringify(["admin-action-v1", purpose, target]);
}

export async function adminActionOptions({ s, user, session, input, purpose, clock, rpID, secret }) {
  if (!adminPurposeAllowed(user, purpose)) throw new TypeError("Your role does not permit this verification purpose.");
  return adminProofOptions({ s, user, session, type: `admin_${purpose}`, target: adminActionTarget(purpose, input, user, secret), clock, rpID });
}

export async function verifyAdminAction({ s, user, session, input, purpose, clock, rpID, origin, secret }) {
  if (!adminPurposeAllowed(user, purpose)) return { verified: false };
  // password is the new account's password on staff creation. Only the separate
  // currentPassword field can authenticate the acting administrator there.
  const proofInput = purpose === "staff_create" ? { ...input, password: input.currentPassword, currentPassword: undefined }
    : { ...input, password: input.currentPassword ?? input.password };
  return verifyAdminProof({ s, user, session, input: proofInput, type: `admin_${purpose}`,
    target: adminActionTarget(purpose, input, user, secret), clock, rpID, origin });
}
