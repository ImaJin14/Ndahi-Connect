import argon2 from "argon2";
import { randomUUID, createHash } from "node:crypto";
import { generateAuthenticationOptions, verifyAuthenticationResponse } from "@simplewebauthn/server";

export const profileCredentialVersion = c => createHash("sha256").update(JSON.stringify([c.pinHash || "", (c.passkeys || []).map(k => [k.id, k.publicKey])])).digest("hex");

export async function profileProofOptions({ s, customer, session, type, target, clock, rpID }) {
  const options = await generateAuthenticationOptions({ rpID, userVerification: "required",
    allowCredentials: customer.passkeys.map((key) => ({ id: key.id, transports: key.transports })) });
  s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter((ch) => !(ch.customerId === customer.id && ch.type === type));
  const challenge = { id: randomUUID(), customerId: customer.id, sessionId: session.id, originalPhone: customer.phone,
    originalEmail: customer.email || "", credentialVersion: profileCredentialVersion(customer), target, ...(type === "phone_change" ? { newPhone: target } : {}),
    type, challenge: options.challenge, expiresAt: new Date(+clock() + 300000).toISOString() };
  s.customerPasskeyChallenges.push(challenge);
  return { challengeId: challenge.id, options };
}
export async function verifyProfileProof({ s, customer, session, input, type, target, clock, rpID, origin, pinThrottle }) {
  if (!input.response) {
    const throttle = pinThrottle(customer);
    if (throttle) return { verified: false, throttle };
    return { verified: /^\d{4}$/.test(String(input.pin || "")) && Boolean(customer.pinHash) &&
      await argon2.verify(customer.pinHash, String(input.pin)).catch(() => false), method: "pin" };
  }
  const attempted = s.customerPasskeyChallenges.find((ch) => ch.id === input.challengeId && ch.customerId === customer.id);
  // A proof is single-use even when its signature, target, purpose, session or
  // credential version is wrong. Never consume another customer's challenge.
  if (attempted) s.customerPasskeyChallenges = s.customerPasskeyChallenges.filter((item) => item.id !== attempted.id);
  const ch = attempted && attempted.type === type && attempted.sessionId === session.id &&
    attempted.originalPhone === customer.phone && attempted.originalEmail === (customer.email || "") &&
    attempted.credentialVersion === profileCredentialVersion(customer) && attempted.target === target && Date.parse(attempted.expiresAt) > +clock() ? attempted : null;
  const key = customer.passkeys?.find((key) => key.id === input.response.id);
  if (ch && key) {
    try {
      const proof = await verifyAuthenticationResponse({ response: input.response, expectedChallenge: ch.challenge,
        expectedOrigin: origin, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: key.id, publicKey: Buffer.from(key.publicKey, "base64url"), counter: key.counter, transports: key.transports } });
      if (proof.verified) key.counter = proof.authenticationInfo.newCounter;
      return { verified: proof.verified, method: "passkey", credentialId: key.id };
    } catch { /* Fail closed without returning raw credential diagnostics. */ }
  }
  return { verified: false };
}
