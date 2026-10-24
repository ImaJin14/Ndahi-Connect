import { createHmac } from "node:crypto";
import { hashSecret, safeEqual } from "./security.mjs";
import { linkedEmail } from "./email-state.mjs";
import { notificationPreferences } from "./notifications.mjs";
import { deliverEmail, emailVersion } from "./email-delivery.mjs";

// Regenerable only with the server pepper: durable retries store neither a raw
// mailbox code nor an unkeyed hash of it. The existing keyed verifier stays valid.
export function emailConfirmationCode(customerId, pending, pepper) {
  const bytes = createHmac("sha256", pepper)
    .update(
      JSON.stringify([
        "account-email-v1",
        customerId,
        pending.id,
        pending.email,
        pending.sessionId,
      ]),
    )
    .digest();
  return String(bytes.readUInt32BE(0) % 1000000).padStart(6, "0");
}
export function queueVoucherEmail(s, voucher) {
  voucher.emailDelivery ??= {
    status: voucher.emailStatus === "sent" ? "sent" : "pending",
    attempts: Number(voucher.emailAttempts || 0),
    ...(voucher.emailSentAt ? { sentAt: voucher.emailSentAt } : {}),
  };
  voucher.emailStatus = voucher.emailDelivery.status;
  if (
    !linkedEmail(s.customers.find((c) => c.id === voucher.customerId)) &&
    voucher.emailDelivery.status !== "sent"
  )
    voucher.emailStatus = voucher.emailDelivery.status = "needs_email";
}
const unavailable = (blocked, reason) => ({ blocked, reason });
export function createTransactionalEmailService({
  store,
  email,
  now = () => new Date(),
  pepper,
  previousPepper,
  planFor,
  timeoutMs = 10000,
}) {
  const configured = () => email.configured?.() !== false;
  function recipient(s, id, preference = "emailTransactions") {
    const c = s.customers.find((c) => c.id === id);
    if (!c || c.status === "suspended" || c.suspended)
      return unavailable("cancelled", "Account delivery is unavailable.");
    if (!notificationPreferences(s, "customer:" + id)[preference])
      return unavailable(
        "disabled",
        "This email channel is disabled in Account notification settings.",
      );
    const to = linkedEmail(c);
    return to
      ? { customer: c, to }
      : unavailable(
          "needs_email",
          "Link and confirm an account email in Account.",
        );
  }
  const runDelivery = (options) =>
    deliverEmail({ store, now, configured, timeoutMs, ...options });
  async function verification(id) {
    return runDelivery({
      key: "email-verification/" + id,
      locate: (s) =>
        s.customers.find((c) => c.pendingEmail?.id === id)?.pendingEmail
          ?.delivery,
      changed(s, row) {
        const p = s.customers.find(
          (c) => c.pendingEmail?.id === id,
        )?.pendingEmail;
        if (p) p.status = row.status === "failed" ? "unconfirmed" : row.status;
      },
      resolve(s) {
        const c = s.customers.find((c) => c.pendingEmail?.id === id),
          p = c?.pendingEmail;
        if (
          !p ||
          c.status === "suspended" ||
          c.suspended ||
          p.originalEmail !== (c.email || "") ||
          Date.parse(p.expiresAt) <= +now() ||
          p.attempts >= 5 ||
          !s.dashboardSessions.some(
            (a) =>
              a.id === p.sessionId &&
              a.customerId === c.id &&
              Date.parse(a.expiresAt) > +now(),
          )
        )
          return unavailable(
            "cancelled",
            "Request a new email confirmation code from Account.",
          );
        const secret = [pepper, previousPepper]
          .filter(Boolean)
          .find((secret) =>
            safeEqual(
              p.codeHash,
              hashSecret(emailConfirmationCode(c.id, p, secret), secret),
            ),
          );
        if (!secret)
          return unavailable(
            "cancelled",
            "Request a new email confirmation code from Account.",
          );
        return {
          version: emailVersion([c.id, p.id, p.email, p.sessionId]),
          message: {
            to: p.email,
            code: emailConfirmationCode(c.id, p, secret),
            requestId: p.id,
          },
        };
      },
      send: (message, deliveryKey) =>
        email.sendVerification({ ...message, deliveryKey }),
    });
  }
  async function welcome(id) {
    return runDelivery({
      key: "account-welcome/" + id,
      locate: (s) => s.customers.find((c) => c.id === id)?.welcomeEmail,
      resolve(s) {
        const r = recipient(s, id);
        if (r.blocked) return r;
        const row = r.customer.welcomeEmail;
        return {
          version: emailVersion([id, r.to, row?.name]),
          message: { to: r.to, name: row?.name || "Customer", customerId: id },
        };
      },
      send: (message, deliveryKey) =>
        email.sendWelcome({ ...message, deliveryKey }),
    });
  }
  async function voucher(id) {
    return runDelivery({
      key: "voucher-confirmation/" + id,
      locate(s) {
        const v = s.vouchers.find((v) => v.id === id);
        if (!v) return;
        queueVoucherEmail(s, v);
        return v.emailDelivery;
      },
      changed(s, row) {
        const v = s.vouchers.find((v) => v.id === id);
        if (v) {
          v.emailStatus = row.status;
          v.emailAttempts = row.attempts || 0;
          v.emailSentAt = row.sentAt;
          v.emailLastError = row.lastError;
          v.emailNextAttemptAt = row.nextAttemptAt;
        }
      },
      resolve(s) {
        const v = s.vouchers.find((v) => v.id === id),
          p = s.payments.find((p) => p.id === v?.paymentId),
          r = recipient(s, v?.customerId);
        if (r.blocked) return r;
        if (
          !p ||
          p.status !== "paid" ||
          p.customerId !== v.customerId ||
          p.fulfillmentStatus === "needs_review" ||
          !v ||
          !["active", "expired", "exhausted"].includes(v.status)
        )
          return unavailable(
            "cancelled",
            "Voucher email is no longer available. Use your portal for current status.",
          );
        const plan = p.planSnapshot || planFor(s, v.planId);
        if (!plan)
          return unavailable(
            "cancelled",
            "Package information is unavailable.",
          );
        // Freeze the issued document, rather than changing its provider payload when
        // usage or the live customer profile changes during a retry.
        v.emailDelivery.content ??= {
          customerId: v.customerId,
          customer: {
            name: r.customer.name || "Customer",
            phone: r.customer.phone,
          },
          payment: { amount: p.amount, currency: p.currency },
          plan: structuredClone(plan),
          voucher: {
            id: v.id,
            code: v.code,
            planId: v.planId,
            status: "active",
            deviceLimit: v.deviceLimit,
            expiresAt: v.expiresAt,
            activatedAt: v.activatedAt,
          },
        };
        const content = v.emailDelivery.content;
        if (
          content.customerId !== v.customerId ||
          content.voucher.code !== v.code ||
          content.voucher.activatedAt !== v.activatedAt ||
          content.voucher.expiresAt !== v.expiresAt
        ) {
          return unavailable(
            "cancelled",
            "The voucher allocation changed. Use your portal for current status.",
          );
        }
        return {
          version: emailVersion([r.to, content]),
          message: {
            ...structuredClone(content),
            customer: { ...content.customer, email: r.to },
          },
        };
      },
      send: (message, deliveryKey) =>
        email.sendVoucher({ ...message, deliveryKey }),
    });
  }
  async function activation(id) {
    return runDelivery({
      key: "subscription-activation/" + id,
      locate: (s) => s.vouchers.find((v) => v.id === id)?.activationEmail,
      resolve(s) {
        const v = s.vouchers.find((v) => v.id === id),
          p = s.payments.find((p) => p.id === v?.paymentId),
          r = recipient(s, v?.customerId);
        if (r.blocked) return r;
        if (
          !v ||
          v.status !== "active" ||
          p?.status !== "paid" ||
          p.customerId !== v.customerId ||
          !(Date.parse(v.expiresAt) > +now())
        )
          return unavailable(
            "cancelled",
            "This activation is no longer current.",
          );
        const plan = p.planSnapshot || planFor(s, v.planId);
        return {
          version: emailVersion([
            r.to,
            id,
            v.activatedAt,
            v.expiresAt,
            plan?.name,
          ]),
          message: {
            to: r.to,
            voucherId: id,
            planName: plan?.name || v.planId,
            activatedAt: v.activatedAt,
            expiresAt: v.expiresAt,
          },
        };
      },
      send: (message, deliveryKey) =>
        email.sendActivation({ ...message, deliveryKey }),
    });
  }
  let running;
  function run() {
    if (running) return running;
    running = (async () => {
      const s = await store.snapshot();
      const due = (row) =>
        row &&
        !["sent", "cancelled"].includes(row.status) &&
        (row.attempts || 0) < 5 &&
        !(Date.parse(row.nextAttemptAt) > +now()) &&
        !(row.status === "sending" && Date.parse(row.leaseUntil) > +now());
      const opted = (id) => !recipient(s, id).blocked;
      for (const c of s.customers
        .filter((c) => due(c.pendingEmail?.delivery))
        .slice(0, 25))
        await verification(c.pendingEmail.id);
      for (const c of s.customers
        .filter((c) => due(c.welcomeEmail) && opted(c.id))
        .slice(0, 25))
        await welcome(c.id);
      for (const v of s.vouchers
        .filter(
          (v) =>
            v.paymentId &&
            v.emailStatus !== "sent" &&
            (!v.emailDelivery || due(v.emailDelivery)) &&
            opted(v.customerId),
        )
        .slice(0, 25))
        await voucher(v.id);
      for (const v of s.vouchers
        .filter((v) => due(v.activationEmail) && opted(v.customerId))
        .slice(0, 25))
        await activation(v.id);
    })().finally(() => {
      running = undefined;
    });
    return running;
  }
  return { run, verification, voucher, welcome, activation };
}
