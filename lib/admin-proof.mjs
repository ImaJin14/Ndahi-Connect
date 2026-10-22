import argon2 from "argon2";
import { createHash, randomUUID } from "node:crypto";
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";

const roles = new Set(["owner", "operator", "reseller", "auditor"]);
const proofWindow = 15 * 60_000, challengeLifetime = 5 * 60_000, maxFailures = 5;
const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("base64url");
const authority = (user) => digest([user.id, user.username, user.role, user.pinHash || user.passwordHash || ""]);
const credentials = (user) => digest((user.passkeys || []).map((key) =>
  [key.id, key.publicKey, key.createdAt || ""]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
const scopeValid = (type, target) => typeof type === "string" && /^[a-z0-9][a-z0-9:_-]{0,99}$/i.test(type) &&
  typeof target === "string" && target.length <= 1024;

function currentContext(s, user, session, now) {
  const current = s.adminUsers?.find((item) => item.id === user?.id);
  const stored = typeof session?.tokenHash === "string" && session.tokenHash && s.adminSessions?.find((item) =>
    item.tokenHash === session.tokenHash && item.userId === current?.id);
  if (!Number.isFinite(now) || !current || current.active === false || !roles.has(current.role) ||
    !current.username || session?.userId !== current.id || !stored || stored.role !== current.role ||
    session.role !== current.role || !(Date.parse(stored.expiresAt) > now) || !(Date.parse(session.expiresAt) > now)) return null;
  return current;
}

function throttleFor(user, now) {
  const state = user.adminProofFailures;
  if (!state) return null;
  const until = Date.parse(state.lockedUntil);
  if (until > now) return { locked: true, retryAfterSeconds: Math.max(1, Math.min(900, Math.ceil((until - now) / 1000))) };
  if (state.lockedUntil || !(Date.parse(state.startedAt) > now - proofWindow)) delete user.adminProofFailures;
  return null;
}

function failure(user, now, method) {
  const previous = user.adminProofFailures;
  const count = Math.min(maxFailures, Math.max(0, Number(previous?.count) || 0) + 1);
  user.adminProofFailures = {
    startedAt: previous?.startedAt || new Date(now).toISOString(), count,
    ...(count >= maxFailures ? { lockedUntil: new Date(now + proofWindow).toISOString() } : {}),
  };
  const throttle = throttleFor(user, now);
  return { verified: false, method, ...(throttle ? { throttle } : {}) };
}

/** Call inside the same committed mutation that stores the returned challenge. */
export async function adminProofOptions({ s, user, session, type, target = "", clock, rpID }) {
  const now = +clock(), current = currentContext(s, user, session, now);
  if (!current || !scopeValid(type, target) || !(current.passkeys?.length > 0)) {
    throw new TypeError("Fresh administrator passkey verification is unavailable.");
  }
  const boundAuthority = authority(current), boundCredentials = credentials(current);
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required",
    allowCredentials: current.passkeys.map((key) => ({ id: key.id, transports: key.transports })) });
  if (currentContext(s, user, session, +clock()) !== current || authority(current) !== boundAuthority || credentials(current) !== boundCredentials) {
    throw new TypeError("Administrator credentials changed. Try again.");
  }
  const purpose = `sensitive:${type}`;
  // Bound the sensitive-proof rows without discarding unrelated login/enrollment challenges.
  const other = (s.adminPasskeyChallenges || []).filter((ch) => !String(ch.type || "").startsWith("sensitive:") ||
    (Date.parse(ch.expiresAt) > now && !(ch.userId === current.id && ch.type === purpose && ch.target === target && ch.sessionTokenHash === session.tokenHash)));
  const retained = other.filter((ch) => ch.userId === current.id && String(ch.type || "").startsWith("sensitive:"));
  const remove = new Set(retained.slice(0, Math.max(0, retained.length - 9)));
  s.adminPasskeyChallenges = other.filter((ch) => !remove.has(ch));
  const challenge = { id: randomUUID(), userId: current.id, type: purpose, target,
    sessionTokenHash: session.tokenHash, authority: boundAuthority, credentials: boundCredentials,
    challenge: options.challenge, expiresAt: new Date(now + challengeLifetime).toISOString() };
  s.adminPasskeyChallenges.push(challenge);
  return { challengeId: challenge.id, options };
}

/** Fresh proof only: this does not authorize an operation or replace role/CSRF checks. */
export async function verifyAdminProof({ s, user, session, input = {}, type, target = "", clock, rpID, origin }) {
  if (!input || typeof input !== "object" || Array.isArray(input)) input = {};
  const method = input.response != null ? "passkey" : (input.password != null || input.currentPassword != null) && (input.pin == null && input.currentPin == null) ? "password" : "pin";
  const now = +clock(), current = currentContext(s, user, session, now);
  if (!current || !scopeValid(type, target)) return { verified: false, method };
  const throttle = throttleFor(current, now);
  if (throttle) return { verified: false, method, throttle };
  const boundAuthority = authority(current);
  if (method === "password" || method === "pin") {
    const candidate = input.pin ?? input.currentPin ?? input.password ?? input.currentPassword;
    const hash = current.pinHash || current.passwordHash;
    const valid = typeof candidate === "string" && candidate.length > 0 && candidate.length <= 1024 &&
      Boolean(hash) && await argon2.verify(hash, candidate).catch(() => false);
    if (valid && currentContext(s, user, session, +clock()) === current && authority(current) === boundAuthority) {
      delete current.adminProofFailures;
      return { verified: true, method };
    }
    return failure(current, now, method);
  }
  const challenge = s.adminPasskeyChallenges?.find((ch) => ch.id === input.challengeId && ch.userId === current.id &&
    String(ch.type || "").startsWith("sensitive:"));
  // Consume before cryptographic verification, including a failed scoped attempt.
  if (challenge) s.adminPasskeyChallenges = s.adminPasskeyChallenges.filter((ch) => ch !== challenge);
  const boundCredentials = credentials(current);
  const key = current.passkeys?.find((item) => item.id === input.response?.id);
  if (!challenge || challenge.type !== `sensitive:${type}` || challenge.target !== target ||
    challenge.sessionTokenHash !== session.tokenHash || challenge.authority !== boundAuthority ||
    challenge.credentials !== boundCredentials || !(Date.parse(challenge.expiresAt) > now) || !key) return failure(current, now, method);
  try {
    const proof = await verifyAuthenticationResponse({ response: input.response, expectedChallenge: challenge.challenge,
      expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
      credential: { id: key.id, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports } });
    if (proof.verified && currentContext(s, user, session, +clock()) === current && authority(current) === boundAuthority &&
      credentials(current) === boundCredentials && Date.parse(challenge.expiresAt) > +clock()) {
      key.counter = proof.authenticationInfo.newCounter;
      delete current.adminProofFailures;
      return { verified: true, method, credentialId: key.id };
    }
  } catch { /* Fail closed; never return raw signature or credential diagnostics. */ }
  return failure(current, now, method);
}
