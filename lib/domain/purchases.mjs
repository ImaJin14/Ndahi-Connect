import { randomUUID } from "node:crypto";
import { phone, purchasablePlan, findPlan, dailyEligibleAt, log } from "../api/state.mjs";
import { paymentView, unresolvedPayment, billingPolicyVersion } from "../billing.mjs";

// Checkout reservation business rules (ARCH-002). Runs inside a store
// transaction, performs no I/O and returns either a rejection, an idempotent
// replay of an earlier checkout, or the newly reserved payment. Provider
// submission happens after commit.
export function reservePurchase(s, input, {
  clock,
  provider,
  paymentMode = "mock",
  pendingSeconds = 300,
  requester,
  accountCustomerId,
  correlationId,
}) {
  const accountPurchase = accountCustomerId !== undefined,
    plan = purchasablePlan(s, input.planId);
  let c = accountPurchase
    ? s.customers.find((x) => x.id === accountCustomerId)
    : s.customers.find((x) => x.phone === phone(input.phone));
  if (!c && !accountPurchase) {
    c = {
      id: randomUUID(),
      phone: phone(input.phone),
      name: String(input.name || "Customer").slice(0, 100),
      email: String(input.email || "").trim().toLowerCase().slice(0, 254),
      createdAt: clock().toISOString(),
    };
    s.customers.push(c);
  }
  if (!c) return { status: 401, body: { error: "Customer account not found." } };
  if (c.suspended) {
    return { status: 403, body: { error: "This account is suspended. Contact support before making a payment." } };
  }
  const requestKey = String(input.requestKey || "").slice(0, 100),
    duplicate = requestKey && s.payments.find((x) => x.customerId === c.id && x.requestKey === requestKey);
  if (duplicate) {
    if (duplicate.planId !== input.planId || (accountPurchase && duplicate.action !== input.action)) {
      return { status: 409, body: { error: "This request belongs to another checkout. Resume that payment first." } };
    }
    return {
      status: 200,
      body: {
        idempotent: true,
        payment: paymentView(duplicate),
        checkout: {
          mode: paymentMode,
          provider: duplicate.provider,
          url: duplicate.checkoutUrl,
          authorizationMode: duplicate.authorizationMode,
        },
      },
    };
  }
  if (
    s.payments.some(
      (p) =>
        p.customerId === c.id &&
        (unresolvedPayment(p) ||
          (["failed", "expired", "cancelled"].includes(p.status) && p.provider !== "mock" && !p.providerFailedAt)),
    )
  ) {
    return {
      status: 409,
      body: {
        code: "PAYMENT_IN_PROGRESS",
        error:
          "An earlier payment needs confirmation. Sign in to your dashboard or resume your saved checkout before paying again.",
      },
    };
  }
  if (!plan) return { status: 400, body: { error: "This package is unavailable or discontinued." } };
  const activeVoucher = s.vouchers.find((v) => v.customerId === c.id && v.status === "active"),
    latestVoucher = s.vouchers.find((v) => v.customerId === c.id),
    action = accountPurchase ? String(input.action || "") : input.upgrade ? "switch" : "purchase";
  if (accountPurchase && !["renew", "switch"].includes(action)) {
    return { status: 400, body: { error: "Choose renew or switch plan." } };
  }
  if (action === "renew" && (!latestVoucher || latestVoucher.planId !== plan.id)) {
    return { status: 409, body: { error: "You can only renew your current purchasable plan." } };
  }
  if (action === "switch" && latestVoucher?.planId === plan.id) {
    return { status: 409, body: { error: "Choose a different package or renew your current one." } };
  }
  if (activeVoucher && action === "purchase") {
    return { status: 409, body: { error: "Your current bundle is still active. Bundles cannot be stacked." } };
  }
  if (activeVoucher && input.upgrade && !accountPurchase) {
    const activePlan = findPlan(s, activeVoucher.planId);
    if (!activePlan || plan.price <= activePlan.price) {
      return { status: 400, body: { error: "Choose a package above your current bundle to upgrade." } };
    }
  }
  const nextEligibleAt = plan.id === "daily" && dailyEligibleAt(s, c.id);
  if (nextEligibleAt && nextEligibleAt > clock()) {
    return {
      status: 409,
      body: {
        error: `Daily is available again on ${nextEligibleAt.toISOString()}.`,
        nextEligibleAt: nextEligibleAt.toISOString(),
      },
    };
  }
  const payment = {
    id: randomUUID(),
    customerId: c.id,
    planId: plan.id,
    amount: plan.price,
    currency: "XAF",
    payerPhone: c.phone,
    email: c.email,
    customerName: c.name,
    network: input.network,
    clientIp: requester.ip,
    provider,
    status: "pending",
    creationState: "reserved",
    planSnapshot: structuredClone(plan),
    policyVersion: billingPolicyVersion,
    createdAt: clock().toISOString(),
    action,
    ...(requestKey ? { requestKey } : {}),
    // Lets later verification, fulfillment and refunds log under the originating operation.
    ...(correlationId ? { correlationId } : {}),
    ...(provider === "mesomb"
      ? { paymentExpiresAt: new Date(clock().getTime() + pendingSeconds * 1000).toISOString() }
      : {}),
    ...(activeVoucher ? { replaceVoucherId: activeVoucher.id } : {}),
  };
  s.payments.unshift(payment);
  log(s, "payment.reserved", { paymentId: payment.id, amount: payment.amount, provider });
  return { status: 201, payment };
}
