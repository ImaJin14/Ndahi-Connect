import { body, json, ip } from "./http.mjs";
import { phoneOk, phone, findPlan, ensureState, audit } from "./state.mjs";
import { paymentView, ensureReceipt, checkoutTiming, checkoutKeyActive } from "../billing.mjs";
import { receiptView } from "../receipt.mjs";
import { receiptPdf, receiptFilename } from "../receipt-pdf.mjs";
import { reservePurchase } from "../domain/purchases.mjs";
import { enqueuePaymentWebhook } from "../payment-webhooks.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { correlation } from "../correlation.mjs";
import { safeEqual } from "../security.mjs";
import { normalizeEmail, validEmail } from "../email-state.mjs";
export function createPaymentRoutes({
  store,
  env,
  paymentProviders,
  mutate,
  auth,
  refreshCustomerSession,
  clock,
  billing,
  complete,
  deliverVoucherEmail,
  pays,
  webhookProcessor,
  customerScope,
  sessionScope,
  logger,
  coverage,
}) {
  // Receipts expose payment IDs. Guest access requires the browser's private
  // checkout key while it is still active; an ID alone must never disclose that
  // key or an activation code.
  const keyActive = (s, payment) => checkoutKeyActive(payment,
    s.customers.find((c) => c.id === payment.customerId), clock(), checkoutTiming(env));
  const canReadStatus = (req, payment, session, s) => Boolean(payment && (
    session?.customerId === payment.customerId ||
    (typeof payment.requestKey === "string" && payment.requestKey &&
      typeof req.headers?.["x-checkout-key"] === "string" &&
      safeEqual(req.headers["x-checkout-key"], payment.requestKey) && keyActive(s, payment))
  ));
  return async function (req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/purchase/recover") {
      // Current portals keep only the random key on the device, never contact details.
      // Older portals also send the phone number, which must then match.
      const input = await body(req), key = typeof input.requestKey === "string" ? input.requestKey : "",
        byPhone = input.phone !== undefined;
      if (!key || (byPhone ? !phoneOk(input.phone) : key.length < 32))
        return json(res, 400, { error: "Saved checkout details are required." });
      const find = (s) => {
        const matches = s.payments.filter((p) => p.requestKey === key &&
          (!byPhone || (p.guestCheckoutDetails?.phone || p.payerPhone) === phone(input.phone)));
        return matches.length === 1 && keyActive(s, matches[0]) ? matches[0] : null;
      };
      const saved = find(await store.snapshot());
      const unavailable = { error: "Saved checkout access is unavailable or expired. Sign in to review payments or contact support if money was deducted." };
      if (!saved) return json(res, 404, unavailable);
      // A checkout resumed after its window reports as closed, so the customer can start again.
      await billing.expireCheckout(saved.id);
      const s = await store.snapshot(), p = find(s);
      if (!p) return json(res, 404, unavailable);
      res.setHeader("cache-control", "no-store");
      return json(res, 200, {
        payment: paymentView(p, { timing: checkoutTiming(env), now: clock() }),
        checkout: {
          mode: p.provider === "mock" ? "mock" : "live",
          provider: p.provider,
          url: p.checkoutUrl,
        },
        // Only echo details supplied for this guest checkout. Older records do
        // not establish where their name/email came from, so leave them blank.
        details: p.guestCheckoutDetails
          ? { name: p.guestCheckoutDetails.name, phone: p.guestCheckoutDetails.phone, email: p.guestCheckoutDetails.email, network: p.guestCheckoutDetails.network }
          : { name: "", phone: p.payerPhone || "", email: "", network: p.network || null },
      });
    }
    if (
      req.method === "POST" &&
      ["/api/purchase", "/api/account/plan/purchase"].includes(url.pathname)
    ) {
      // Recovery and payment completion stay reachable after a network change.
      // Check before reserving a purchase or contacting the payment provider.
      if (!coverage(req, res)) return;
      const i = await body(req);
      const accountPurchase = url.pathname.startsWith("/api/account/");
      if (
        (!accountPurchase && !phoneOk(i.phone)) ||
        (normalizeEmail(i.email) && !validEmail(normalizeEmail(i.email)))
      ) {
        return json(res, 400, {
          error: "Enter a valid Cameroon phone number. Email is optional; if supplied, enter a valid address.",
        });
      }
      const provider =
        env.PAYMENT_MODE === "mock"
          ? "mock"
          : env.PAYMENT_MODE === "mesomb"
            ? "mesomb"
            : "flutterwave";
      if (!paymentProviders.includes(provider)) {
        return json(res, 503, {
          error: `${provider === "mesomb" ? "MeSomb" : "Flutterwave"} payments are not configured on the API service.`,
          code: "PAYMENT_PROVIDER_NOT_CONFIGURED",
          operational: false,
        });
      }
      if (provider !== "mock" && !["mtn", "orange"].includes(i.network))
        return json(res, 400, { error: "Choose MTN Mobile Money or Orange Money." });
      let reservedId;
      await mutate(
        (s) => {
          reservedId = undefined;
          const session = accountPurchase && auth(req, s, "dashboardSessions");
          if (accountPurchase && !session) return json(res, 401, { error: "Customer session expired." });
          if (session) refreshCustomerSession(req, res, session);
          const outcome = reservePurchase(s, i, {
            clock,
            provider,
            paymentMode: env.PAYMENT_MODE || "mock",
            ...checkoutTiming(env),
            requester: { ip: ip(req) },
            correlationId: correlation().correlationId,
            ...(session ? { accountCustomerId: session.customerId } : {}),
          });
          if (!outcome.payment) return json(res, outcome.status, outcome.body);
          reservedId = outcome.payment.id;
        },
        { res, ...(accountPurchase ? sessionScope(req) : { scope: customerScope(i.phone) }) },
      );
      if (!reservedId) return;
      logger.info("payment.created", { paymentId: reservedId, provider });
      await billing.startPayment(reservedId);
      const p = (await store.snapshot()).payments.find((p) => p.id === reservedId);
      return json(res, 201, {
        payment: paymentView(p, { timing: checkoutTiming(env), now: clock() }),
        checkout: {
          mode: env.PAYMENT_MODE || "mock",
          provider: p.provider,
          url: p.checkoutUrl,
          authorizationMode: p.authorizationMode,
          message:
            p.creationState === "uncertain"
              ? "Recheck this payment before paying again."
              : "Approve the payment request on your phone.",
        },
      });
    }
    if (req.method === "POST" && /^\/api\/payments\/[^/]+\/confirm$/.test(url.pathname)) {
      if ((env.PAYMENT_MODE || "mock") !== "mock") {
        return json(res, 403, {
          error: "Production payments require a signed provider webhook.",
        });
      }
      const id = url.pathname.split("/")[3];
      return mutate((s) =>
        complete(
          s,
          s.payments.find((x) => x.id === id),
          null,
          res,
        ),
      );
    }
    if (
      req.method === "GET" &&
      /^\/api\/(?:account\/)?payments\/[^/]+\/(?:status|receipt)$/.test(url.pathname)
    ) {
      const id = url.pathname.split("/").at(-2),
        accountPayment = url.pathname.startsWith("/api/account/"),
        receipt = url.pathname.endsWith("/receipt"),
        state = ensureState(await store.snapshot()),
        session = auth(req, state, "dashboardSessions"),
        p = state.payments.find((p) => p.id === id);
      if ((accountPayment || receipt) && !session)
        return json(res, 401, { error: "Customer session expired." });
      if (!p || ((accountPayment || receipt) && p.customerId !== session.customerId) ||
        (!accountPayment && !receipt && !canReadStatus(req, p, session, state)))
        return json(res, 404, { error: "Payment not found." });
      if (receipt) {
        const snapshot = await mutate((s) => {
          const a = auth(req, s, "dashboardSessions");
          if (!a) { json(res, 401, { error: "Customer session expired." }); return null; }
          const payment = s.payments.find((p) => p.id === id && p.customerId === a.customerId);
          if (!payment) { json(res, 404, { error: "Payment not found." }); return null; }
          const record = ensureReceipt(payment, findPlan(s, payment.planId));
          if (!record) { json(res, 409, { error: "A receipt is available after confirmed payment." }); return null; }
          refreshCustomerSession(req, res, a);
          return structuredClone({ record, refund: paymentView(payment, { timing: checkoutTiming(env), now: clock() }).refund });
        }, { res, ...sessionScope(req) });
        if (!snapshot) return;
        if (url.searchParams.get("format") === "json") {
          res.setHeader("cache-control", "no-store");
          return json(res, 200, { receipt: receiptView(snapshot.record, snapshot.refund) });
        }
        // Generate the PDF outside the state transaction so other customers can keep billing.
        const pdf = await receiptPdf(snapshot.record);
        res.writeHead(200, {
          "content-type": "application/pdf", "cache-control": "no-store",
          "content-disposition": `attachment; filename="${receiptFilename(snapshot.record)}"`,
          "content-length": pdf.length,
        });
        return res.end(pdf);
      }
      await billing.expireCheckout(id);
      await billing.recheckPayment(id);
      await billing.recheckRefund(id);
      await billing.sendReceipt(id);
      return mutate(async (s) => {
        const payment = s.payments.find((p) => p.id === id),
          a = auth(req, s, "dashboardSessions");
        if (accountPayment && !a) return json(res, 401, { error: "Customer session expired." });
        if (!payment || (accountPayment && payment.customerId !== a.customerId) ||
          (!accountPayment && !canReadStatus(req, payment, a, s)))
          return json(res, 404, { error: "Payment not found." });
        if (a?.customerId === payment.customerId) refreshCustomerSession(req, res, a);
        ensureReceipt(payment, findPlan(s, payment.planId));
        const voucher = payment.status === "paid" && s.vouchers.find((v) => v.paymentId === id);
        if (voucher && voucher.emailStatus !== "sent" && Number(voucher.emailAttempts || 0) < 5)
          await deliverVoucherEmail(s, voucher);
        return json(res, 200, {
          payment: paymentView(payment, { timing: checkoutTiming(env), now: clock() }),
          ...(voucher
            ? {
                access: { code: voucher.code },
                email: { status: voucher.emailStatus, sentAt: voucher.emailSentAt },
              }
            : {}),
        });
      });
    }
    if (
      req.method === "POST" &&
      ["/api/account/payments/refund", "/api/account/payments/receipt-email"].includes(url.pathname)
    ) {
      const input = await body(req);
      let paymentId;
      await mutate((s) => {
        const a = auth(req, s, "dashboardSessions");
        if (!a) return json(res, 401, { error: "Customer session expired." });
        const p = s.payments.find((p) => p.id === input.paymentId && p.customerId === a.customerId);
        if (!p) return json(res, 404, { error: "Payment not found." });
        if (!ensureReceipt(p, findPlan(s, p.planId)))
          return json(res, 409, { error: "A confirmed payment is required." });
        if (url.pathname.endsWith("/refund")) {
          if (!["paid", "refunded", "refund-pending"].includes(p.status))
            return json(res, 409, { error: "This transaction is not eligible for a refund." });
          billing.requestRefund(p, input.reason);
          audit(s, "payment.refund_requested", req, { paymentId: p.id, customerId: a.customerId });
        }
        paymentId = p.id;
      });
      if (!paymentId) return;
      if (url.pathname.endsWith("/receipt-email")) await billing.sendReceipt(paymentId);
      const p = (await store.snapshot()).payments.find((p) => p.id === paymentId);
      return json(res, 200, { payment: paymentView(p, { timing: checkoutTiming(env), now: clock() }) });
    }
    if (
      req.method === "POST" &&
      ["/api/webhooks/flutterwave", "/api/webhooks/mesomb"].includes(url.pathname)
    ) {
      const provider = url.pathname.split("/").at(-1),
        raw = await body(req, true);
      let data;
      try {
        data = await pays[provider].handleWebhook(
          raw,
          req.headers[
            provider === "mesomb" ? "x-mesomb-webhook-signature" : "flutterwave-signature"
          ],
        );
      } catch {
        return json(res, 401, { error: "Invalid webhook signature." });
      }
      const queued = await enqueuePaymentWebhook(store, provider, data, raw, clock);
      if (queued.body) return json(res, queued.status, queued.body);
      if (queued.status === "processed")
        return json(res, 200, { accepted: true, idempotent: true });
      if (queued.status === "dead_letter")
        return json(res, 200, { accepted: true, requiresReview: true });
      const response = await webhookProcessor.process(queued.id);
      return json(res, response.status, response.body);
    }
    return NOT_HANDLED;
  };
}
