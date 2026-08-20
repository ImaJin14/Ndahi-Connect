import { createHmac, randomUUID } from "node:crypto";
import { safeEqual } from "./security.mjs";

export class PaymentAdapter {
  async createPayment() { throw Error("createPayment is not configured"); }
  async verifyPayment() { throw Error("verifyPayment is not configured"); }
  async handleWebhook() { throw Error("handleWebhook is not configured"); }
  async refundPayment() { throw Error("refundPayment is not configured"); }
}

export class MockPaymentAdapter extends PaymentAdapter {
  async createPayment(payment) { return { providerReference: `mock-${randomUUID()}`, status: "pending", payment }; }
  async verifyPayment(payment) { return { status: "paid", providerReference: payment.providerReference }; }
  async handleWebhook(payload) { return payload; }
  async refundPayment(payment) { return { status: "refunded", providerReference: payment.providerReference }; }
}

async function request(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000) });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { message: text }; }
  if (!response.ok || data.status === "error") {
    throw Error(`Payment provider request failed (${response.status}): ${data.message || data.error || "unknown error"}`);
  }
  return data;
}

export class FlutterwavePaymentAdapter extends PaymentAdapter {
  constructor({ apiUrl = "https://api.flutterwave.com/v3", secretKey, secretHash }) {
    super();
    this.apiUrl = apiUrl.replace(/\/$/, "");
    this.secretKey = secretKey;
    this.secretHash = secretHash;
    if (!/^https:\/\//i.test(this.apiUrl)) throw Error("FLW_API_URL must use HTTPS");
  }
  configured() { return Boolean(this.secretKey && this.secretHash); }
  headers() {
    if (!this.configured()) throw Error("Flutterwave credentials are not configured");
    return { authorization: `Bearer ${this.secretKey}`, "content-type": "application/json", accept: "application/json" };
  }
  async createPayment(payment) {
    const network = ({ mtn: "MTN", orange: "ORANGEMONEY" })[payment.network];
    if (!network) throw Error("Choose MTN Mobile Money or Orange Money");
    const response = await request(`${this.apiUrl}/charges?type=mobile_money_franco`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        amount: payment.amount,
        currency: payment.currency,
        phone_number: `237${payment.payerPhone}`,
        email: payment.email,
        tx_ref: payment.id,
        country: "CM",
        network,
        fullname: payment.customerName,
        client_ip: payment.clientIp,
        meta: { paymentId: payment.id, planId: payment.planId },
      }),
    });
    const data = response.data || {},
      authorization = response.meta?.authorization || data.meta?.authorization || {},
      providerReference = data.id ?? data.flw_ref;
    if (providerReference === undefined || providerReference === null) throw Error("Flutterwave did not return a transaction reference");
    return {
      providerReference: String(providerReference),
      status: data.status === "successful" ? "paid" : "pending",
      authorizationMode: authorization.mode || "callback",
      checkoutUrl: authorization.redirect_url || authorization.redirect ||
        data.redirect_url,
    };
  }
  async verifyPayment(payment, transactionId = payment.providerReference) {
    if (!/^\d+$/.test(String(transactionId || ""))) throw Error("Invalid Flutterwave transaction ID");
    const response = await request(`${this.apiUrl}/transactions/${encodeURIComponent(transactionId)}/verify`, { headers: this.headers() });
    const data = response.data || {};
    return {
      status: data.status === "successful" ? "paid" : data.status === "failed" ? "failed" : "pending",
      providerReference: String(data.id ?? transactionId),
      transactionReference: data.tx_ref,
      amount: Number(data.amount),
      currency: data.currency,
      raw: data,
    };
  }
  async handleWebhook(raw, signature) {
    if (!this.secretHash || !signature) throw Error("Invalid webhook signature");
    const expected = createHmac("sha256", this.secretHash).update(raw).digest("base64");
    if (!safeEqual(expected, signature)) throw Error("Invalid webhook signature");
    const event = JSON.parse(raw), data = event.data || {};
    return { eventId: event.id, type: event.type, paymentId: data.tx_ref || data.reference, transactionId: data.id };
  }
  async refundPayment(payment) {
    if (!/^\d+$/.test(String(payment.providerReference || ""))) throw Error("Invalid Flutterwave transaction ID");
    const response = await request(`${this.apiUrl}/transactions/${encodeURIComponent(payment.providerReference)}/refund`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ amount: payment.amount, comments: `NDAHI refund ${payment.id}` }),
    });
    const status = String(response.data?.status || response.status).toLowerCase();
    return { status: ["completed", "successful", "success"].includes(status) ? "refunded" : "refund-pending", providerReference: payment.providerReference };
  }
}

export function paymentAdapters(env = process.env) {
  return {
    mock: new MockPaymentAdapter(),
    flutterwave: new FlutterwavePaymentAdapter({ apiUrl: env.FLW_API_URL, secretKey: env.FLW_SECRET_KEY, secretHash: env.FLW_SECRET_HASH }),
  };
}
