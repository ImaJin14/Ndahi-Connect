// A PIN reset link sent to a customer's confirmed email (#399). Used by the
// customer's own Forgot PIN and by staff's "Send PIN reset email" on Customer
// detail (#341; owner 26 Nov): the same link, valid 15 minutes, single use,
// and any earlier unused link stops working.
import { randomUUID } from "node:crypto";
import { secureToken, hashSecret } from "./security.mjs";

export async function issuePinReset(s, customer, { email, clock, pepper, log }) {
  const token = secureToken(32);
  for (const challenge of s.pinResetChallenges) {
    if (challenge.customerId === customer.id && !challenge.used) challenge.used = true;
  }
  const challenge = {
    id: randomUUID(),
    customerId: customer.id,
    tokenHash: hashSecret(token, pepper),
    attempts: 0,
    used: false,
    createdAt: clock().toISOString(),
    expiresAt: new Date(clock().getTime() + 15 * 60_000).toISOString(),
  };
  s.pinResetChallenges.push(challenge);
  try {
    const sent = await email.sendPinReset({ customer, token });
    challenge.emailMessageId = sent.messageId;
    challenge.emailSentAt = clock().toISOString();
  } catch (error) {
    challenge.deliveryError = String(error.message || error).slice(0, 200);
    log(s, "customer.pin_reset.email_failed", { customerId: customer.id });
  }
  return { sent: Boolean(challenge.emailSentAt) };
}
