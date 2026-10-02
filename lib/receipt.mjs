import { palette as c, escapeHtml as h, money, doualaTime } from "./brand.mjs";

// Branded receipt for the portal download and the receipt email (BILL-002). One document
// serves both, so layout uses tables and inline styles that email clients keep; the <style>
// block only improves printing and small screens. It renders the frozen receipt snapshot
// and never recomputes package or payment details.
const providers = { mesomb: "MeSomb mobile money", flutterwave: "Flutterwave", live: "Flutterwave", mock: "Test payment" };

function allowances(plan = {}) {
  const hours = Number(plan.validityHours);
  return {
    data: plan.quotaGb === null ? "Unlimited (fair use applies)" : plan.quotaGb == null ? "Not recorded" : `${plan.quotaGb} GB`,
    validity: !Number.isFinite(hours) || hours <= 0 ? "Not recorded"
      : hours % 24 === 0 ? `${hours / 24} ${hours === 24 ? "day" : "days"}` : `${hours} hours`,
    devices: plan.deviceLimit == null ? "Not recorded" : `${plan.deviceLimit} ${Number(plan.deviceLimit) === 1 ? "device" : "devices"}`,
  };
}

function details(receipt) {
  return {
    amount: money(receipt.amount, receipt.currency || "XAF"),
    paidAt: doualaTime(receipt.paidAt),
    method: providers[receipt.provider] || receipt.provider || "Not recorded",
    reference: receipt.providerReference || "Not recorded for this historical payment",
    plan: receipt.plan?.name || "Package",
    ...allowances(receipt.plan),
  };
}

const label = `font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:${c.muted}`;
const row = (name, value, last = false) =>
  `<tr><th scope="row" style="text-align:left;font-weight:400;color:${c.muted};padding:10px 12px 10px 0;${last ? "" : `border-bottom:1px solid ${c.line};`}vertical-align:top">${h(name)}</th>` +
  `<td style="text-align:right;padding:10px 0;${last ? "" : `border-bottom:1px solid ${c.line};`}word-break:break-word">${h(value)}</td></tr>`;

export function receiptDocument(receipt) {
  const d = details(receipt);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light only">
<title>NDAHI Connect receipt ${h(receipt.number)}</title>
<style>
@page { size: A4; margin: 14mm; }
* { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
@media print { body, .page { background: #ffffff !important; } .page { padding: 0 !important; } .sheet { border: 0 !important; } .screen-only { display: none !important; } }
@media (max-width: 480px) { .pad { padding-left: 18px !important; padding-right: 18px !important; } .amount { font-size: 30px !important; } }
</style>
</head>
<body style="margin:0;padding:0;background:${c.page}">
<table role="presentation" class="page" width="100%" cellpadding="0" cellspacing="0" style="background:${c.page};padding:24px 12px">
<tr><td align="center">
<table role="presentation" class="sheet" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${c.line};border-radius:12px;overflow:hidden;font-family:Arial,Helvetica,sans-serif;color:${c.ink};line-height:1.5;text-align:left">
<tr><td class="pad" style="background:${c.ink};padding:20px 28px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
<td style="vertical-align:middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="width:34px;height:34px;border:2px solid ${c.lime};border-radius:50%;text-align:center;vertical-align:middle;color:${c.lime};font-size:12px;font-weight:700">NC</td>
<td style="padding-left:12px;vertical-align:middle"><div style="font-family:Georgia,'Times New Roman',serif;font-size:20px;font-weight:700;letter-spacing:.04em;line-height:1;color:#ffffff">NDAHI</div><div style="font-size:9px;letter-spacing:.32em;margin-top:4px;color:${c.lime}">CONNECT</div></td>
</tr></table></td>
<td align="right" style="vertical-align:middle"><h1 style="margin:0;font-size:12px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:${c.onInk}">Payment receipt</h1></td>
</tr></table>
</td></tr>
<tr><td class="pad" style="padding:28px 28px 6px">
<div style="${label}">Amount paid</div>
<div class="amount" style="font-size:36px;font-weight:700;letter-spacing:.02em;margin:4px 0 12px">${h(d.amount)}</div>
<span style="display:inline-block;background:${c.lime};color:${c.ink};font-size:12px;font-weight:700;padding:3px 10px;border-radius:999px">Paid</span>
<span style="font-size:14px;color:${c.muted};margin-left:8px">${h(d.paidAt)}</span>
</td></tr>
<tr><td class="pad" style="padding:18px 28px 8px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${c.card};border:1px solid ${c.line};border-radius:12px"><tr><td style="padding:18px 20px">
<div style="${label}">Package</div>
<div style="font-size:22px;font-weight:700;margin:2px 0 8px">${h(d.plan)}</div>
<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse">
${row("Data", d.data)}${row("Validity", d.validity)}${row("Devices", d.devices, true)}
</table>
</td></tr></table>
</td></tr>
<tr><td class="pad" style="padding:8px 28px 0">
<table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px;border-collapse:collapse">
<caption style="text-align:left;padding:10px 0 2px;${label}">Payment details</caption>
${row("Receipt number", receipt.number)}${row("Billed to", receipt.customerName || "Customer")}${row("Paid on", d.paidAt)}${row("Payment method", d.method)}${row("Provider reference", d.reference)}
<tr><th scope="row" style="text-align:left;padding:14px 12px 4px 0;border-top:2px solid ${c.ink};font-size:15px">Total paid</th><td style="text-align:right;padding:14px 0 4px;border-top:2px solid ${c.ink};font-size:18px;font-weight:700">${h(d.amount)}</td></tr>
</table>
</td></tr>
<tr><td class="pad" style="padding:18px 28px 24px;font-size:13px;color:${c.muted}">
<p style="margin:0 0 10px">Provider fees, if any, are shown separately by your payment provider. This receipt records the package payment; your dashboard shows current access and any refund.</p>
<p class="screen-only" style="margin:0">Keep this receipt for your records. You can print it or save it as a PDF from your browser.</p>
</td></tr>
<tr><td class="pad" style="background:${c.card};border-top:1px solid ${c.line};padding:14px 28px;font-size:12px;color:${c.muted}">NDAHI Connect · Managed public Wi-Fi${receipt.policyVersion ? ` · Billing rules ${h(receipt.policyVersion)}` : ""}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
}

export function receiptText(receipt, { portalUrl } = {}) {
  const d = details(receipt);
  return [
    "NDAHI CONNECT: PAYMENT RECEIPT",
    "",
    `Amount paid: ${d.amount}`,
    `Paid on: ${d.paidAt}`,
    "",
    `Package: ${d.plan}`,
    `Data: ${d.data}`,
    `Validity: ${d.validity}`,
    `Devices: ${d.devices}`,
    "",
    `Receipt number: ${receipt.number}`,
    `Billed to: ${receipt.customerName || "Customer"}`,
    `Payment method: ${d.method}`,
    `Provider reference: ${d.reference}`,
    "",
    "Provider fees, if any, are shown separately by your payment provider.",
    ...(portalUrl ? [`Download this receipt any time from ${portalUrl}/dashboard.`] : []),
  ].join("\n");
}
