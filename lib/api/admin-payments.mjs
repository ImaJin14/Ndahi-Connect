import { scheduleWebhookReplay } from "../payment-webhooks.mjs";
import { json, body } from "./http.mjs";
import { audit } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createAdminPaymentsRoutes({ billing }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    if (req.method === "POST" && url.pathname === "/api/admin/payments/refund") {
      const p = s.payments.find((x) => x.id === i.paymentId);
      if (!p || !["paid", "refund-pending", "refunded"].includes(p.status)) {
        return json(res, 400, {
          error: "A paid payment is required.",
        });
      }
      billing.requestRefund(p);
      effects.refundPaymentId = p.id;
      audit(s, "payment.refund_submission_requested", req, { paymentId: p.id });
      return;
    }
    if (url.pathname === "/api/admin/payments/status") {
      const p = s.payments.find((x) => x.id === i.paymentId);
      if (!p || !["pending", "failed", "cancelled", "expired"].includes(i.status))
        return json(res, 400, { error: "Invalid payment or status." });
      return json(res, 409, {
        error:
          "Payment status is provider-verified. Use payment recovery or refund verification instead of manual status changes.",
      });
    }
    return NOT_HANDLED;
  };
}

export function createPaymentPreflight({ clock }) {
  return async function (req, res, url, { s, administrator, role, effects }) {
    if (req.method === "POST" && url.pathname === "/api/admin/payments/refund/check") {
      const input = await body(req),
        p = s.payments.find((p) => p.id === input.paymentId);
      if (!p?.refund) return json(res, 404, { error: "Refund not found." });
      effects.refundCheckId = p.id;
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/admin/payments/webhooks/replay") {
      const input = await body(req);
      const response = scheduleWebhookReplay(s, String(input.eventId || ""), clock);
      if (response.status === 202)
        audit(s, "payment.webhook_replay_requested", req, { eventId: input.eventId });
      return json(res, response.status, response.body);
    }
    return NOT_HANDLED;
  };
}
