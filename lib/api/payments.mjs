import { body, json, ip } from "./http.mjs";
import { phoneOk, phone, findPlan, ensureState, audit } from "./state.mjs";
import { paymentView, ensureReceipt, receiptDocument, checkoutTiming } from "../billing.mjs";
import { reservePurchase } from "../domain/purchases.mjs";
import { enqueuePaymentWebhook } from "../payment-webhooks.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { correlation } from "../correlation.mjs";
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
}) {
  return async function (req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/purchase/recover") {
      const input = await body(req);
      if (!phoneOk(input.phone) || typeof input.requestKey !== "string" || !input.requestKey)
        return json(res, 400, { error: "Saved checkout details are required." });
      const s = await store.snapshot(),
        c = s.customers.find((c) => c.phone === phone(input.phone)),
        p = c && s.payments.find((p) => p.customerId === c.id && p.requestKey === input.requestKey);
      if (!p) return json(res, 404, { error: "No saved payment was submitted." });
      return json(res, 200, {
        payment: paymentView(p),
        checkout: {
          mode: p.provider === "mock" ? "mock" : "live",
          provider: p.provider,
          url: p.checkoutUrl,
        },
      });
    }
    if (
      req.method === "POST" &&
      ["/api/purchase", "/api/account/plan/purchase"].includes(url.pathname)
    ) {
      const i = await body(req);
      const accountPurchase = url.pathname.startsWith("/api/account/");
      if (
        !accountPurchase &&
        (!phoneOk(i.phone) ||
          (env.PAYMENT_MODE !== "mock" &&
            !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(i.email || ""))))
      ) {
        return json(res, 400, {
          error: "Enter a valid Cameroon phone number and email address.",
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
        payment: paymentView(p),
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
      if (!p || ((accountPayment || receipt) && p.customerId !== session.customerId))
        return json(res, 404, { error: "Payment not found." });
      if (!receipt) {
        await billing.recheckPayment(id);
        await billing.expireCheckout(id);
        await billing.recheckRefund(id);
        await billing.sendReceipt(id);
      }
      return mutate(async (s) => {
        const payment = s.payments.find((p) => p.id === id),
          a = auth(req, s, "dashboardSessions");
        if (a?.customerId === payment.customerId) refreshCustomerSession(req, res, a);
        const record = ensureReceipt(payment, findPlan(s, payment.planId));
        if (receipt) {
          if (!record)
            return json(res, 409, { error: "A receipt is available after confirmed payment." });
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            // Inline styles render the branded receipt; scripts, images and requests stay blocked.
            "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
            "content-disposition": `attachment; filename="ndahi-receipt-${payment.id}.html"`,
          });
          return res.end(receiptDocument(record));
        }
        const voucher = payment.status === "paid" && s.vouchers.find((v) => v.paymentId === id);
        if (voucher && voucher.emailStatus !== "sent" && Number(voucher.emailAttempts || 0) < 5)
          await deliverVoucherEmail(s, voucher);
        return json(res, 200, {
          payment: paymentView(payment),
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
          billing.requestRefund(p, input.reason);
          audit(s, "payment.refund_requested", req, { paymentId: p.id, customerId: a.customerId });
        }
        paymentId = p.id;
      });
      if (!paymentId) return;
      if (url.pathname.endsWith("/receipt-email")) await billing.sendReceipt(paymentId);
      const p = (await store.snapshot()).payments.find((p) => p.id === paymentId);
      return json(res, 200, { payment: paymentView(p) });
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
