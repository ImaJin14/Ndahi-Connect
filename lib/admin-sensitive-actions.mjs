import { createHash, createHmac, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { adminProofOptions, verifyAdminProof } from "./admin-proof.mjs";

export const adminRoles = new Set(["owner", "operator", "reseller", "auditor"]);
const selfService = new Set(["passkey_add", "passkey_remove", "pin_change"]);
const ownerActions = new Set(["staff_create", "staff_deactivate", "support_recovery", "legacy_mfa"]);
const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
export const adminPurposeAllowed = (user, purpose) => adminRoles.has(user?.role) &&
  (selfService.has(purpose) || user.role === "owner" && ownerActions.has(purpose));

export function adminCredentialVersion(user) {
  return digest([user.id, user.username, user.role, user.pinHash || user.passwordHash || "", (user.passkeys || [])
    .map(key => [key.id, key.publicKey, key.createdAt || ""]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
}

// Both the options request and the actual mutation call this exact normalizer.
// Never persist a newly created staff member's raw password in a challenge.
export function adminActionTarget(purpose, input, user, secret, staffIntentId = null) {
  let target;
  if (purpose === "passkey_add") target = [user.id];
  else if (purpose === "passkey_remove") target = [user.id, String(input.credentialId || "")];
  else if (purpose === "pin_change") target = [user.id];
  else if (purpose === "staff_create") {
    const username = String(input.username || "").trim().toLowerCase();
    target = [username, String(input.displayName || username).slice(0, 80), String(input.role || "auditor"),
      staffIntentId];
  } else if (purpose === "staff_deactivate") target = [String(input.userId || "")];
  else if (purpose === "legacy_mfa") {
    if (!["enroll", "set"].includes(input.action)) throw new TypeError("Choose a supported authenticator management action.");
    if (typeof secret !== "string" || !secret) throw new TypeError("Administrator proof binding requires the configured secret.");
    target = [input.action, input.action === "set" ? Boolean(input.enabled) : null, input.action === "set"
      ? createHmac("sha256", secret).update(JSON.stringify(["admin-legacy-code-v1", String(input.code || "")])).digest("base64url") : null];
  }
  else if (purpose === "support_recovery") target = [String(input.customerId || ""),
    String(input.recoveryPurpose || (input.purpose === "authenticator" ? "authenticator" : "pin")),
    String(input.caseReference || "").trim(), String(input.reason || "").trim(), String(input.verificationMethod || ""), input.confirmedIdentity === true];
  else throw new TypeError("Unsupported administrator verification purpose.");
  return JSON.stringify(["admin-action-v1", purpose, target]);
}

export async function adminActionOptions({ s, user, session, input, purpose, clock, rpID, secret }) {
  if (!adminPurposeAllowed(user, purpose)) throw new TypeError("Your role does not permit this verification purpose.");
  let staffIntent;
  if (purpose === "staff_create") {
    const newCredential = input.pin || input.password;
    if (typeof newCredential !== "string" || newCredential.length < 4 || newCredential.length > 1024)
      throw new TypeError("Enter a new staff PIN or password between 4 and 1024 characters.");
    staffIntent = { id: randomUUID(), passwordHash: await argon2.hash(newCredential,
      { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }) };
  }
  const result = await adminProofOptions({ s, user, session, type: `admin_${purpose}`,
    target: adminActionTarget(purpose, input, user, secret, staffIntent?.id), clock, rpID });
  if (staffIntent) {
    const challenge = s.adminPasskeyChallenges.find(ch => ch.id === result.challengeId);
    challenge.staffPasswordIntent = staffIntent;
  }
  return result;
}

export async function verifyAdminAction({ s, user, session, input, purpose, clock, rpID, origin, secret }) {
  if (!adminPurposeAllowed(user, purpose)) return { verified: false };
  // password is the new account's password on staff creation. Only the separate
  // currentPassword field can authenticate the acting administrator there.
  const proofInput = purpose === "staff_create" ? { ...input, pin: input.currentPin, currentPin: undefined, password: input.currentPassword, currentPassword: undefined }
    : { ...input, pin: input.currentPin ?? input.pin, password: input.currentPassword ?? input.password };
  let target = adminActionTarget(purpose, input, user, secret);
  if (purpose === "staff_create" && input.response != null) {
    const challenge = s.adminPasskeyChallenges?.find(ch => ch.id === input.challengeId && ch.userId === user.id &&
      ch.sessionTokenHash === session.tokenHash && ch.type === "sensitive:admin_staff_create" && Date.parse(ch.expiresAt) > +clock());
    const intent = challenge?.staffPasswordIntent;
    const candidate = input.pin || input.password;
    const matches = typeof intent?.id === "string" && typeof intent.passwordHash === "string" &&
      typeof candidate === "string" && candidate.length >= 4 && candidate.length <= 1024 &&
      await argon2.verify(intent.passwordHash, candidate).catch(() => false);
    // Route a failed intent through the same consumed-challenge/throttle path
    // as an invalid UV assertion. No key counter advances on password mismatch.
    target = matches ? adminActionTarget(purpose, input, user, secret, intent.id)
      : JSON.stringify(["admin-staff-intent-invalid"]);
  }
  return verifyAdminProof({ s, user, session, input: proofInput, type: `admin_${purpose}`,
    target, clock, rpID, origin });
}
