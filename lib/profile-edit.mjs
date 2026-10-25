import { createHash } from "node:crypto";
import {
  normalizeCameroonPhone,
  validCameroonPhone,
} from "../shared-app/cameroon-phone.js";
import { queueSecurityAlert } from "./security-alerts.mjs";
import { sec } from "./api/state.mjs";
import { normalizeEmail, validEmail, linkedEmail } from "./email-state.mjs";
export const profileVersion = (c) =>
  createHash("sha256")
    .update(
      JSON.stringify([
        c.name || "",
        normalizeCameroonPhone(c.phone),
        c.email || "",
        c.emailVerifiedAt || "",
      ]),
    )
    .digest("hex");
export function profileEdit(c, input) {
  if (!input || Array.isArray(input) || typeof input !== "object")
    return { status: 400, error: "Enter valid profile details." };
  const allowed = [
    "name",
    "phone",
    "email",
    "pin",
    "response",
    "challengeId",
    "expectedVersion",
    "operationId",
    "verifyEmail",
    "removeEmail",
    "action",
  ];
  if (Object.keys(input).some((key) => !allowed.includes(key)))
    return { status: 400, error: "Choose supported profile fields." };
  for (const flag of ["verifyEmail", "removeEmail"])
    if (input[flag] !== undefined && typeof input[flag] !== "boolean")
      return { status: 400, error: "Choose valid email confirmation options." };
  const name =
    input.name === undefined
      ? c.name || ""
      : typeof input.name === "string"
        ? input.name.trim().replace(/\s+/g, " ")
        : "";
  if (
    input.name !== undefined &&
    (!name || name.length > 100 || /[\u0000-\u001f\u007f]/.test(input.name))
  )
    return { status: 400, error: "Enter a name between 1 and 100 characters." };
  const phone =
    input.phone === undefined
      ? normalizeCameroonPhone(c.phone)
      : normalizeCameroonPhone(input.phone);
  if (!validCameroonPhone(phone))
    return { status: 400, error: "Enter a valid Cameroon phone number." };
  if (input.email !== undefined && typeof input.email !== "string")
    return {
      status: 400,
      error: "Enter a valid email address or leave it empty.",
    };
  const email =
    input.email === undefined ? c.email || "" : normalizeEmail(input.email);
  if (email && !validEmail(email))
    return {
      status: 400,
      error: "Enter a valid email address or leave it empty.",
    };
  const emailChanged =
    email !== normalizeEmail(c.email) ||
    Boolean(input.verifyEmail && email && !linkedEmail(c));
  if (emailChanged && !email && input.removeEmail !== true)
    return {
      status: 400,
      error:
        "Confirm that removing your email also removes email PIN recovery.",
    };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify([
        name,
        phone,
        email,
        Boolean(input.verifyEmail),
        Boolean(input.removeEmail),
        input.expectedVersion || null,
      ]),
    )
    .digest("hex");
  return {
    name,
    phone,
    email,
    emailChanged,
    phoneChanged: phone !== normalizeCameroonPhone(c.phone),
    fingerprint,
  };
}
export function profileOperation(c, id, fingerprint, now = new Date()) {
  const op = c.profileOperations?.find((op) => op.id === id);
  if (!op) return null;
  if (
    op.fingerprint !== fingerprint ||
    op.status === "cancelled" ||
    (op.status === "pending" &&
      (!c.pendingEmail?.profileChange ||
        c.pendingEmail.profileChange.operationId !== id ||
        Date.parse(c.pendingEmail.expiresAt) <= +now ||
        c.pendingEmail.profileChange.originalVersion !== profileVersion(c)))
  )
    return {
      status: 409,
      error:
        "This profile request is no longer current. Reload your profile before saving again.",
    };
  return {
    status: op.status === "pending" ? 202 : 200,
    body: {
      profileSaved: op.status === "applied",
      verificationPending: op.status === "pending",
      operationId: id,
      profileVersion: profileVersion(c),
    },
  };
}
export function recordProfileOperation(c, input, edit, status, now) {
  if (!input.operationId) return;
  c.profileOperations ??= [];
  let op = c.profileOperations.find((op) => op.id === input.operationId);
  if (!op) {
    op = { id: input.operationId, fingerprint: edit.fingerprint };
    c.profileOperations.push(op);
  }
  Object.assign(op, { status, at: now.toISOString() });
  c.profileOperations = c.profileOperations.slice(-20);
}

export const profilePhoneConflict = (s, c, phone) =>
  s.customers.some(
    (other) =>
      other.id !== c.id && normalizeCameroonPhone(other.phone) === phone,
  );
export function applyProfileFields(s, c, edit, req, now) {
  const oldPhone = c.phone;
  c.name = edit.name;
  if (edit.phone !== normalizeCameroonPhone(c.phone)) {
    c.phone = edit.phone;
    c.phoneVerified = false;
    c.phoneChangedAt = now.toISOString();
    sec(s, "customer.phone_changed", req, {
      customerId: c.id,
      severity: "high",
    });
    queueSecurityAlert(
      s,
      {
        customerId: c.id,
        kind: "phone_changed",
        subject: "Your NDAHI Connect account number changed",
        lines: [
          "Your account number changed after PIN/passkey verification. Bundles, vouchers, payment history and device approvals stay with your account.",
          "Review your account or contact support if this was not you.",
        ],
      },
      now,
    );
  }
  sec(s, "customer.profile_changed", req, { customerId: c.id });
  return oldPhone;
}
export function revokeProfileAuthority(s, c, oldPhone = c.phone) {
  const voucherIds = new Set(
    s.vouchers.filter((v) => v.customerId === c.id).map((v) => v.id),
  );
  for (const key of [
    "pinResetChallenges",
    "customerPasskeyChallenges",
    "customerMfaChallenges",
    "otpChallenges",
    "customerAccessChallenges",
  ])
    s[key] = s[key].filter(
      (ch) =>
        ch.customerId !== c.id &&
        ch.phone !== oldPhone &&
        ch.phone !== c.phone &&
        !voucherIds.has(ch.voucherId),
    );
  s.dashboardSessions = s.dashboardSessions.filter(
    (session) => session.customerId !== c.id,
  );
}
