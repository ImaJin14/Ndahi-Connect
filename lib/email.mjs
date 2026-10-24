import { receiptDocument, receiptText } from "./receipt.mjs";
import { receiptPdf, receiptFilename } from "./receipt-pdf.mjs";
import { voucherPdf, voucherFilename } from "./voucher-pdf.mjs";
import { escapeHtml, money } from "./brand.mjs";
import { createHash } from "node:crypto";
import { notificationTarget } from "../shared-app/notification-target.js";

const hashForIdempotency = (value) =>
  createHash("sha256").update(String(value)).digest("hex").slice(0, 32);

function emailFrame(title, content) {
  return `<!doctype html><html><body style="margin:0;background:#eef3ee;font-family:Arial,sans-serif;color:#082d25;line-height:1.5"><div style="max-width:560px;margin:auto;padding:28px"><div style="background:#082d25;color:#b4f228;padding:20px;font-weight:bold;letter-spacing:.12em">NDAHI CONNECT</div><main style="background:white;padding:24px"><h1 style="font-size:24px">${escapeHtml(title)}</h1>${content}</main><p style="font-size:12px;color:#587069">NDAHI Connect · Keep your account details private. Never share your PIN or a recovery code.</p></div></body></html>`;
}

function voucherMessage({ customer, payment, plan, voucher, portalUrl }) {
  const name = customer.name || "Customer",
    expiry = new Intl.DateTimeFormat("en-GB", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Africa/Douala",
    }).format(new Date(voucher.expiresAt)),
    quota = plan.quotaGb == null ? "Unlimited (fair use applies)" : `${plan.quotaGb} GB`,
    subject = "Your NDAHI Connect voucher",
    text = [
      `Hello ${name},`,
      "",
      "Your payment was confirmed and your bundle was activated. Open your portal for current connection status.",
      `Voucher code: ${voucher.code}`,
      `Package: ${plan.name}`,
      `Payment: ${money(payment.amount, payment.currency)}`,
      `Data: ${quota}`,
      `Devices: ${voucher.deviceLimit}`,
      `Expires: ${expiry} (Africa/Douala)`,
      "",
      `Sign in and finish securing your account: ${portalUrl}/login`,
      "Keep this voucher private. Never share your PIN or a recovery code.",
    ].join("\n"),
    html = `<p>Hello ${escapeHtml(name)},</p><h1 style="font-size:24px">Your voucher is ready</h1><p>Your payment was confirmed successfully.</p><div style="background:#f4f8f4;border:1px solid #d8e3dc;border-radius:12px;padding:20px;margin:24px 0"><div style="font-size:13px;text-transform:uppercase;letter-spacing:.08em">Voucher code</div><div style="font-size:28px;font-weight:700;letter-spacing:.08em;margin:6px 0 18px">${escapeHtml(voucher.code)}</div><div><strong>Package:</strong> ${escapeHtml(plan.name)}</div><div><strong>Payment:</strong> ${escapeHtml(money(payment.amount, payment.currency))}</div><div><strong>Data:</strong> ${escapeHtml(quota)}</div><div><strong>Devices:</strong> ${escapeHtml(voucher.deviceLimit)}</div><div><strong>Expires:</strong> ${escapeHtml(expiry)} (Africa/Douala)</div></div><p><a href="${escapeHtml(`${portalUrl}/login`)}" style="display:inline-block;background:#b4f228;color:#082d25;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Secure your account</a></p><p style="font-size:13px;color:#587069">Keep this voucher private. Never share your PIN or a recovery code.</p></div></body></html>`;
  return { subject, text, html: emailFrame("Your voucher is ready", html) };
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

  async sendVerification({ to, code, requestId, deliveryKey }) {
    if (!this.configured()) throw Error("Email provider is not configured.");
    const subject = "Confirm your NDAHI Connect email", portal = `${this.portalUrl}/dashboard#account`;
    const text = `Your NDAHI Connect email confirmation code is ${code}. It expires in 10 minutes. Enter it in Account in your portal. If you did not request this, ignore this email.\n${portal}`;
    const response = await this.fetcher(`${this.apiUrl}/emails`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": deliveryKey || `email-verification/${requestId}` },
      body: JSON.stringify({ from: this.from, to: [to], subject, text,
        html: emailFrame("Confirm your email", `<p>Your NDAHI Connect confirmation code:</p><p style="font-size:28px;font-weight:bold">${escapeHtml(code)}</p><p>Enter this code in Account within 10 minutes to enable email notifications. If you did not request this, ignore this email.</p><p><a href="${escapeHtml(portal)}">Open your portal</a></p>`) }),
    });
    if (!response.ok) throw Error("Verification email delivery failed.");
    return { messageId: (await response.json()).id };
  }

  async sendVoucher({ customer, payment, plan, voucher, deliveryKey }) {
    if (!this.configured()) throw new Error("Email provider is not configured.");
    if (!customer?.email) throw new Error("Customer email is missing.");
    const message = voucherMessage({ customer, payment, plan, voucher, portalUrl: this.portalUrl });
    const response = await this.fetcher(`${this.apiUrl}/emails`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": deliveryKey || `voucher-confirmation/${voucher.id}`,
      },
      body: JSON.stringify({
        from: this.from,
        to: [customer.email],
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: [{ filename: voucherFilename(voucher), content: (await voucherPdf({voucher, plan, phone: customer.phone, issued: true})).toString("base64") }],
      }),
    });
    let result = {};
    try { result = await response.json(); } catch { /* provider returned no JSON */ }
    if (!response.ok) throw new Error("Email delivery failed. Check provider configuration or try again later.");
    return { messageId: result.id };
  }

  async sendReceipt({ to, receipt, deliveryKey }) {
    if (!this.configured() || !to) throw Error("Receipt email delivery is not configured.");
    const attachment = { filename: receiptFilename(receipt), content: (await receiptPdf(receipt)).toString("base64") };
    const response = await this.fetcher(`${this.apiUrl}/emails`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json",
        "idempotency-key": deliveryKey || `payment-receipt/${receipt.paymentId}` },
      body: JSON.stringify({ from: this.from, to: [to], subject: `Your NDAHI Connect receipt ${receipt.number}`,
        html: receiptDocument(receipt), text: receiptText(receipt, { portalUrl: this.portalUrl }),
        attachments: [attachment] }),
    });
    if (!response.ok) throw Error("Receipt email delivery failed.");
    const result = await response.json();
    return { messageId: result.id };
  }

  async sendSecurityAlert({ to, alert, deliveryKey }) {
    if (!this.configured() || !to) throw Error("Security alert email delivery is not configured.");
    const subject = alert.subject,
      text = [`Hello,`, "", ...alert.lines, "", "If this wasn't you, sign in and review your account security, or contact support."].join("\n"),
      html = `<h1 style="font-size:22px">${escapeHtml(subject)}</h1>${alert.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join("")}<p style="font-size:13px;color:#587069">If this wasn't you, sign in and review your account security, or contact support.</p>`;
    const response = await this.fetcher(`${this.apiUrl}/emails`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json",
        "idempotency-key": deliveryKey || `security-alert/${alert.id}` },
      body: JSON.stringify({ from: this.from, to: [to], subject, html: emailFrame(subject, html), text }),
    });
    if (!response.ok) throw Error("Security alert email delivery failed.");
    const result = await response.json();
    return { messageId: result.id };
  }

  async sendAccountMessage({ to, subject, lines, deliveryKey, path }) {
    const target = notificationTarget(path) || "/dashboard#account";
    if (!this.configured() || !to) throw Error("Email delivery is not configured.");
    const response = await this.fetcher(`${this.apiUrl}/emails`, {
      method: "POST", signal: AbortSignal.timeout(10000),
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json", "idempotency-key": deliveryKey },
      body: JSON.stringify({ from: this.from, to: [to], subject,
        text: ["NDAHI CONNECT", "", ...lines, "", `Open your account: ${this.portalUrl}${target}`].join("\n"),
        html: emailFrame(subject, lines.map(line => `<p>${escapeHtml(line)}</p>`).join("") + `<p><a href="${escapeHtml(this.portalUrl + target)}">Open your account</a></p>`) }),
    });
    if (!response.ok) throw Error("Email delivery failed. Check provider configuration or try again later.");
    return { messageId: (await response.json()).id };
  }

  async sendWelcome({ to, name, customerId, deliveryKey }) {
    return this.sendAccountMessage({to, deliveryKey: deliveryKey || `account-welcome/${customerId}`, subject: "Welcome to NDAHI Connect",
      lines: [`Hello ${name || 'Customer'},`, "Your email is confirmed and linked to your account.", "Use your portal to check your bundle, download receipts and vouchers, and manage notification settings.", "Email is optional; your account and connection remain available if email delivery is interrupted."]});
  }

  async sendActivation({ to, voucherId, planName, expiresAt, deliveryKey }) {
    return this.sendAccountMessage({to, deliveryKey: deliveryKey || `subscription-activation/${voucherId}`, subject: "Your NDAHI Connect bundle is active",
      lines: [`Your ${planName} bundle was activated.`, `Bundle validity ends: ${expiresAt} (UTC).`, "Open your portal for the current bundle and connection status. Email delivery does not establish a Wi-Fi connection."]});
  }

  async sendPinReset({ customer, token }) {
    if (!this.configured()) throw new Error("Email provider is not configured.");
    if (!customer?.email) throw new Error("Customer email is missing.");
    const resetUrl = `${this.portalUrl}/forgot-pin?token=${encodeURIComponent(token)}`,
      subject = "Reset your NDAHI Connect PIN",
      text = `Hello ${customer.name || "Customer"},\n\nUse this secure link within 15 minutes to reset your NDAHI Connect PIN:\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      html = `<p>Hello ${escapeHtml(customer.name || "Customer")},</p><h1 style="font-size:24px">Reset your PIN</h1><p>This secure link expires in 15 minutes and can only be used once.</p><p><a href="${escapeHtml(resetUrl)}" style="display:inline-block;background:#b4f228;color:#082d25;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Reset PIN</a></p><p>If you did not request this, you can ignore this email.</p>`;
    const response = await this.fetcher(`${this.apiUrl}/emails`, {
      method: "POST",
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": `pin-reset/${hashForIdempotency(token)}`,
      },
      body: JSON.stringify({ from: this.from, to: [customer.email], subject, html: emailFrame(subject, html), text }),
    });
    let result = {};
    try { result = await response.json(); } catch { /* provider returned no JSON */ }
    if (!response.ok) throw new Error("Email delivery failed. Check provider configuration or try again later.");
    return { messageId: result.id };
  }
}

export class MockEmailAdapter {
  async sendAccountMessage({ deliveryKey }) { return { messageId: `notification-${deliveryKey}` }; }
  async sendWelcome({ customerId }) { return { messageId: `welcome-${customerId}` }; }
  async sendActivation({ voucherId }) { return { messageId: `activation-${voucherId}` }; }
  async sendVerification({ requestId }) { return { messageId: `mock-verification-${requestId}` }; }
  async sendReceipt({ receipt }) { return { messageId: `receipt-${receipt.paymentId}` }; }
  configured() { return true; }
  async sendVoucher({ voucher }) { return { messageId: `mock-${voucher.id}` }; }
  async sendPinReset() { return { messageId: "mock-pin-reset" }; }
  async sendSecurityAlert({ alert }) { return { messageId: `mock-alert-${alert.id}` }; }
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
