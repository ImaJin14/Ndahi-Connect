import { authenticationReadiness, authenticatorRetired } from "./authentication-migration.mjs";
import { safeEqual } from "./security.mjs";

export const retirementVersion = 1;
const customerFactorFields = Object.freeze([
  "totpSecret", "totpEnrolledAt", "recoveryCodes", "authenticatorRecoveryPermit",
  "mfaProofs", "mfaCompletion", "mfaCheck",
]);
const administratorFactorFields = Object.freeze(["totpSecret", "totpEnrolledAt", "mfaEnabled", "mfaCodeHash"]);
const sessionFactorFields = Object.freeze(["mfaRecoveryGrant", "authMigrationIntent"]);
const customerFactorProofTypes = new Set(["authenticator_replace", "authenticator_resume", "migration_enroll_pin", "migration_confirm"]);
const administratorFactorProofTypes = new Set(["sensitive:migration_confirm", "sensitive:auth_cutover_attestation"]);
// Inventory: otpChallenges is exclusively customer authenticator login. Email,
// PIN recovery, voucher admission and Wi-Fi access use different collections.
const factorCollections = Object.freeze(["customerMfaChallenges", "otpChallenges", "adminMfaChallenges", "adminLoginChallenges"]);

export class AuthenticatorRetirementError extends Error {
  constructor(code, message, blockers = []) {
    super(message);
    this.name = "AuthenticatorRetirementError";
    this.code = code;
    this.blockers = [...blockers];
  }
}

function removeFields(object, fields) {
  if (!object || typeof object !== "object") return 0;
  let removed = 0;
  for (const field of fields) if (Object.hasOwn(object, field)) { delete object[field]; removed++; }
  return removed;
}

/**
 * Deterministic mutation of an already locked transaction draft, with no I/O.
 * No readiness failure changes any state, and the global marker is written last.
 */
export function retireAuthenticatorState(s, { pepper, now = new Date(), expectedDigest } = {}) {
  if (!pepper || !(now instanceof Date) || !Number.isFinite(+now)) {
    throw new AuthenticatorRetirementError("INVALID_RETIREMENT_CONTEXT", "Retirement requires the configured pepper and a valid timestamp.");
  }
  if (authenticatorRetired(s)) {
    if (s.zone.authenticatorRetirement.version !== retirementVersion) {
      throw new AuthenticatorRetirementError("UNSUPPORTED_RETIREMENT_VERSION", "This retirement version cannot modify a newer retirement state.");
    }
    return { version: retirementVersion, applied: false, alreadyRetired: true, retiredAt: s.zone.authenticatorRetirement.retiredAt };
  }
  if (typeof expectedDigest !== "string" || !/^[a-f0-9]{64}$/.test(expectedDigest)) {
    throw new AuthenticatorRetirementError("EXPECTED_DIGEST_REQUIRED", "Apply requires the exact reviewed readiness digest.");
  }
  const readiness = authenticationReadiness(s, { pepper, now });
  if (!safeEqual(readiness.digest, expectedDigest)) {
    throw new AuthenticatorRetirementError("READINESS_CHANGED", "The authentication inventory changed. Recheck and review readiness again.");
  }
  if (!readiness.ready) {
    throw new AuthenticatorRetirementError("READINESS_REQUIRED", "Verified replacements and recovery/pilot/rollback review are required before retirement.", readiness.blockers);
  }
  // Owner-reviewed evidence is already validated against the exact credential
  // inventory by authenticationReadiness; retain its reference, never secrets.
  const review = s.zone.authenticationMigrationReview;
  const counts = {
    customersChanged: 0, customerFieldsRemoved: 0, administratorFieldsRemoved: 0,
    sessionFieldsRemoved: 0, factorChallengesRemoved: {}, customerProofChallengesRemoved: 0, administratorProofChallengesRemoved: 0,
  };
  for (const customer of s.customers || []) {
    const fields = removeFields(customer, customerFactorFields);
    counts.customerFieldsRemoved += fields;
    if (fields) counts.customersChanged++;
  }
  counts.administratorFieldsRemoved += removeFields(s.adminProfile, administratorFactorFields);
  // Baseline administrator factors are global adminProfile fields. Remove the
  // same exact factor names from partial/imported individual profiles as well.
  for (const user of s.adminUsers || []) counts.administratorFieldsRemoved += removeFields(user, administratorFactorFields);
  for (const key of ["dashboardSessions", "adminSessions"]) {
    for (const session of s[key] || []) counts.sessionFieldsRemoved += removeFields(session, sessionFactorFields);
  }
  for (const key of factorCollections) {
    counts.factorChallengesRemoved[key] = (s[key] || []).length;
    if (Object.hasOwn(s, key)) s[key] = [];
  }
  for (const [collection, obsolete, count] of [
    ["customerPasskeyChallenges", customerFactorProofTypes, "customerProofChallengesRemoved"],
    ["adminPasskeyChallenges", administratorFactorProofTypes, "administratorProofChallengesRemoved"],
  ]) if (Array.isArray(s[collection])) {
    const kept = s[collection].filter((challenge) => !obsolete.has(challenge.type));
    counts[count] = s[collection].length - kept.length;
    s[collection] = kept;
  }
  s.zone.authenticatorRetirement = {
    version: retirementVersion, retiredAt: now.toISOString(), readinessDigest: readiness.digest,
    rollbackRevision: review.rollbackRevision, evidenceReference: review.evidenceReference,
    reviewedAt: review.at, counts,
  };
  return { version: retirementVersion, applied: true, alreadyRetired: false, retiredAt: now.toISOString(), counts };
}
