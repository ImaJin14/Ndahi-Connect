const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
}[character]));

const money = (amount, currency = "XAF") =>
  new Intl.NumberFormat("en", { style: "currency", currency, maximumFractionDigits: 0 }).format(amount);

function voucherMessage({ customer, payment, plan, voucher, portalUrl }) {
  const name = customer.name || "Customer",
    expiry = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Douala",
    }).format(new Date(voucher.expiresAt)),
    quota = plan.quotaGb == null ? "Unlimited (fair use applies)" : `${plan.quotaGb} GB`,
    subject = `Your NDAHI Connect voucher: ${voucher.code}`,
    text = [
      `Hello ${name},`,
      "",
      "Your payment was confirmed and your NDAHI Connect access is ready.",
      `Voucher code: ${voucher.code}`,
      `Package: ${plan.name}`,
      `Payment: ${money(payment.amount, payment.currency)}`,
      `Data: ${quota}`,
      `Devices: ${voucher.deviceLimit}`,
      `Expires: ${expiry} (Africa/Douala)`,
      "",
      `Sign in and finish securing your account: ${portalUrl}/login`,
      "Keep this voucher private. NDAHI Connect will never ask for your authenticator code by email.",
    ].join("\n"),
    html = `<!doctype html><html><body style="font-family:Arial,sans-serif;color:#082d25;line-height:1.5"><div style="max-width:560px;margin:auto;padding:28px"><p>Hello ${escapeHtml(name)},</p><h1 style="font-size:24px">Your connection is ready</h1><p>Your payment was confirmed successfully.</p><div style="background:#f4f8f4;border:1px solid #d8e3dc;border-radius:12px;padding:20px;margin:24px 0"><div style="font-size:13px;text-transform:uppercase;letter-spacing:.08em">Voucher code</div><div style="font-size:28px;font-weight:700;letter-spacing:.08em;margin:6px 0 18px">${escapeHtml(voucher.code)}</div><div><strong>Package:</strong> ${escapeHtml(plan.name)}</div><div><strong>Payment:</strong> ${escapeHtml(money(payment.amount, payment.currency))}</div><div><strong>Data:</strong> ${escapeHtml(quota)}</div><div><strong>Devices:</strong> ${escapeHtml(voucher.deviceLimit)}</div><div><strong>Expires:</strong> ${escapeHtml(expiry)} (Africa/Douala)</div></div><p><a href="${escapeHtml(`${portalUrl}/login`)}" style="display:inline-block;background:#b4f228;color:#082d25;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Secure your account</a></p><p style="font-size:13px;color:#587069">Keep this voucher private. NDAHI Connect will never ask for your authenticator code by email.</p></div></body></html>`;
  return { subject, text, html };
}

export class ResendEmailAdapter {
  constructor({ apiUrl, apiKey, from, portalUrl, fetcher = fetch }) {
    this.apiUrl = String(apiUrl || "https://api.resend.com").replace(/\/$/, "");
    this.apiKey = apiKey;
    this.from = from;
    this.portalUrl = String(portalUrl || "http://localhost:8080").replace(/\/$/, "");
    this.fetcher = fetcher;
  }

  configured() {
    return Boolean(this.apiKey && this.from);
  }

  async sendVoucher({ customer, payment, plan, voucher }) {
    if (!this.configured()) throw new Error("Email provider is not configured.");
    if (!customer?.email) throw new Error("Customer email is missing.");
    const message = voucherMessage({ customer, payment, plan, voucher, portalUrl: this.portalUrl });
    const response = await this.fetcher(`${this.apiUrl}/emails`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `voucher-confirmation/${voucher.id}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: [customer.email],
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
    });
    let result = {};
    try { result = await response.json(); } catch { /* provider returned no JSON */ }
    if (!response.ok) throw new Error(`Email delivery failed: ${String(result.message || response.statusText || response.status).slice(0, 200)}`);
    return { messageId: result.id };
  }
}

export class MockEmailAdapter {
  configured() { return true; }
  async sendVoucher({ voucher }) { return { messageId: `mock-${voucher.id}` }; }
}

export function emailAdapter(env = process.env) {
  if (env.EMAIL_MODE === "mock" && env.NODE_ENV !== "production") return new MockEmailAdapter();
  return new ResendEmailAdapter({
    apiUrl: env.EMAIL_API_URL,
    apiKey: env.EMAIL_API_KEY,
    from: env.EMAIL_FROM,
    portalUrl: env.CUSTOMER_APP_URL,
  });
}
