const h = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char],
  );

export { h as escapeVoucherHtml };

export const VOUCHER_PRINT_LAYOUTS = Object.freeze([
  "thermal-58",
  "thermal-80",
]);

const FORBIDDEN_PII_KEYS = new Set([
  "customer",
  "customerId",
  "customerName",
  "name",
  "phone",
  "phoneE164",
  "accountPhone",
  "payerPhone",
  "email",
  "ownership",
  "payment",
  "paymentId",
]);

export function formatValidityLabel(validityHours) {
  const hours = Number(validityHours);
  if (!Number.isFinite(hours) || hours <= 0) return "Valid on redemption";
  if (hours === 24) return "24 hours (1 day)";
  if (hours === 168) return "7 days (168 hours)";
  if (hours === 720) return "30 days (720 hours)";
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} day${days === 1 ? "" : "s"} (${hours} hours)`;
  }
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

export function formatAllowanceLabel(quotaGb, quotaBytes) {
  if (quotaGb === null || (quotaGb === undefined && quotaBytes === null)) {
    return "Unlimited data (fair use)";
  }
  if (Number.isFinite(Number(quotaGb)) && Number(quotaGb) > 0) {
    return `${Number(quotaGb)} GB`;
  }
  if (Number.isFinite(Number(quotaBytes)) && Number(quotaBytes) > 0) {
    const gb = Math.round((Number(quotaBytes) / 1e9) * 10) / 10;
    return `${gb} GB`;
  }
  return "Unlimited data (fair use)";
}

export function formatPriceFcfa(price) {
  const amount = Number(price ?? 0);
  if (!Number.isFinite(amount) || amount < 0) return "0 FCFA";
  return `${amount.toLocaleString("en-US")} FCFA`;
}

export function formatDeviceLabel(deviceLimit, accessMode) {
  if (accessMode === "home") return "All home devices";
  const count = Number(deviceLimit);
  if (!Number.isInteger(count) || count < 1) return "1 device";
  return `${count} device${count === 1 ? "" : "s"}`;
}

/**
 * Strips any personal customer or payment identifiers and returns a strictly
 * anonymous, print-safe voucher model suitable for resale slips.
 */
export function sanitizePrintableVoucher(
  voucher = {},
  fallbackPlan = {},
  { issued = false, now = Date.now() } = {},
) {
  const plan =
    voucher.plan && typeof voucher.plan === "object"
      ? voucher.plan
      : fallbackPlan || {};
  const code = String(voucher.code || "").trim();
  const planName = String(
    plan.name || fallbackPlan?.name || voucher.planId || "NDAHI Bundle",
  )
    .trim()
    .slice(0, 80);
  const price = Number.isFinite(Number(plan.price))
    ? Number(plan.price)
    : Number.isFinite(Number(fallbackPlan?.price))
      ? Number(fallbackPlan.price)
      : Number(voucher.faceValue ?? 0);
  const quotaGb =
    plan.quotaGb !== undefined
      ? plan.quotaGb
      : fallbackPlan?.quotaGb !== undefined
        ? fallbackPlan.quotaGb
        : undefined;
  const validityHours = Number(
    plan.validityHours ?? fallbackPlan?.validityHours ?? 0,
  );
  const deviceLimit = Number(
    voucher.deviceLimit ?? plan.deviceLimit ?? fallbackPlan?.deviceLimit ?? 1,
  );
  const status =
    voucher.status === "available"
      ? "available"
      : String(voucher.status || (voucher.expiresAt ? "active" : "available"));
  const expiresAt = status === "available" ? null : voucher.expiresAt || null;
  const qrCode =
    typeof voucher.qrCode === "string" &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(voucher.qrCode)
      ? voucher.qrCode
      : "";

  const timestamp = Date.parse(expiresAt);
  const statusLabel =
    !issued &&
    status === "active" &&
    Number.isFinite(timestamp) &&
    timestamp <= now
      ? "expired"
      : !issued &&
          status === "active" &&
          voucher.quotaBytes != null &&
          Number(voucher.usedBytes || 0) >= Number(voucher.quotaBytes)
        ? "exhausted"
        : status;
  const safe = {
    code,
    planName,
    priceLabel: formatPriceFcfa(price),
    allowanceLabel: formatAllowanceLabel(quotaGb, voucher.quotaBytes),
    validityLabel: formatValidityLabel(validityHours),
    deviceLabel: formatDeviceLabel(deviceLimit, voucher.accessMode),
    expiryNote:
      status === "available"
        ? "Starts on first redemption"
        : !expiresAt
          ? "Expiry not recorded"
          : Number.isFinite(timestamp)
            ? `Expires ${new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: "Africa/Douala" }).format(new Date(timestamp)) + " " + new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Douala" }).format(new Date(timestamp))} (Africa/Douala)`
            : "Expiry not recorded",
    qrConnection: voucher.qrConnection === true || String(voucher.qrRedemptionUrl || "").includes("/voucher-connect.html"),
    statusLabel,
    statusHeading: issued ? "Status at issue" : "Current status",
    notice:
      "Keep this code private. Printing or emailing does not reactivate expired, replaced or refunded access. Check your portal for current status.",
    qrCode,
  };
  for (const key of Object.keys(safe)) {
    if (FORBIDDEN_PII_KEYS.has(key)) delete safe[key];
  }
  return Object.freeze(safe);
}

/** Only render the server's encoded PNG; never insert supplied SVG markup. */
export function renderQrBlockMarkup(item) {
  if (
    typeof item.qrCode === "string" &&
    /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(item.qrCode)
  ) {
    return `<div class="voucher-qr-box"><img src="${h(item.qrCode)}" alt="QR code for voucher ${h(item.code)}" class="voucher-qr-img"></div>`;
  }
  return '<p class="voucher-qr-unavailable">QR unavailable — enter the voucher code.</p>';
}

export const VOUCHER_SLIP_DESIGN = Object.freeze({
  brand: "NDAHI CONNECT",
  subtitle: "WI-FI VOUCHER SLIP",
  codeLabel: "VOUCHER CODE",
  font: "monospace",
  widths: Object.freeze([58, 80]),
  qrPx: 92,
});

export function voucherSlipRows(item) {
  return [
    ["Data", item.allowanceLabel],
    ["Validity", item.validityLabel],
    [
      item.deviceLabel === "All home devices" ? "Home access" : "Devices",
      item.deviceLabel,
    ],
    ["Activation", item.expiryNote],
    [item.statusHeading, item.statusLabel],
  ];
}

export function voucherSlipInstructions(item) {
  return [
    "Join NDAHI Connect Wi-Fi",
    "Scan the QR code or open portal.ndahiconnect.net",
    item.qrConnection ? "Authorize with your account PIN or passkey" : `Enter code ${item.code}`,
  ];
}

// Inline styles and table rows survive email clients as well as browser printing.
export function renderVoucherSlip(
  item,
  { widthMm = 58, index = 0, email = false } = {},
) {
  const width = widthMm === 80 ? 80 : 58;
  const qrSrc = email && item.qrCode ? "cid:ndahi-voucher-qr" : item.qrCode;
  return `<article class="thermal-slip" data-voucher-slip="${index}" ${email ? "" : `data-voucher-code="${h(item.code)}"`} style="width:${width}mm;max-width:100%;box-sizing:border-box;background:#fff;color:#000;border:1px dashed #222;padding:10px 8px;font-family:monospace;font-size:11px;line-height:1.35;overflow-wrap:anywhere;">
  <header class="thermal-header" style="text-align:center;border-bottom:2px solid #000;padding:0 0 6px;margin:0 0 6px;background:#fff;color:#000;display:block;height:auto;position:static;">
    <p class="thermal-brand" style="margin:0;font-size:14px;font-weight:800;letter-spacing:.08em;">${VOUCHER_SLIP_DESIGN.brand}</p>
    <p class="thermal-subtitle" style="margin:2px 0 0;font-size:9px;font-weight:700;letter-spacing:.12em;">${VOUCHER_SLIP_DESIGN.subtitle}</p>
  </header>
  <table role="presentation" style="width:100%;border-collapse:collapse;border-bottom:1px dashed #000;margin-bottom:6px;font-size:12px;"><tr><td class="thermal-plan-name" style="font-weight:bold;padding:0 4px 5px 0;overflow-wrap:anywhere;border:0;font-size:inherit;">${h(item.planName)}</td><td class="thermal-plan-price" style="text-align:right;font-weight:bold;padding:0 0 5px;border:0;font-size:inherit;">${h(item.priceLabel)}</td></tr></table>
  <div class="thermal-code-block" style="border:2px solid #000;padding:6px 4px;text-align:center;margin-bottom:6px;background:#fff;">
    <span class="thermal-code-label" style="display:block;font-size:9px;font-weight:700;letter-spacing:.1em;">${VOUCHER_SLIP_DESIGN.codeLabel}</span>
    <code class="thermal-voucher-code" style="display:block;margin-top:2px;font-size:15px;font-weight:800;letter-spacing:.06em;color:#000;overflow-wrap:anywhere;">${h(item.code)}</code>
  </div>
  ${qrSrc ? `<div class="voucher-qr-box" style="width:92px;height:92px;margin:6px auto;"><img src="${h(qrSrc)}" width="92" height="92" alt="QR code for voucher ${h(item.code)}" class="voucher-qr-img" style="display:block;width:92px;height:92px;"></div>` : renderQrBlockMarkup(item)}
  <table class="thermal-meta" role="presentation" style="width:100%;border-collapse:collapse;margin:6px 0;border-top:1px dashed #000;border-bottom:1px dashed #000;font-size:11px;">${voucherSlipRows(
    item,
  )
    .map(
      ([label, value]) =>
        `<tr><td style="font-weight:bold;vertical-align:top;padding:2px 4px 2px 0;border:0;font-size:inherit;">${h(label)}</td><td style="text-align:right;padding:2px 0;overflow-wrap:anywhere;border:0;font-size:inherit;">${h(value)}</td></tr>`,
    )
    .join("")}</table>
  <footer class="thermal-instructions" style="font-size:10px;"><p style="margin:0 0 3px;"><strong>How to connect:</strong></p><ol style="margin:0;padding-left:15px;">${voucherSlipInstructions(
    item,
  )
    .map((line) => `<li>${h(line)}</li>`)
    .join(
      "",
    )}</ol><p style="margin:6px 0 0;font-size:9px;">${h(item.notice)}</p></footer>
</article>`;
}

export function renderThermalSlipsHtml(vouchers = [], plan = {}, widthMm = 58) {
  const width = widthMm === 80 ? 80 : 58;
  return `<div class="voucher-print-sheet voucher-print-thermal voucher-print-thermal-${width}" data-print-surface="thermal-${width}" data-paper-width="${width}mm">${vouchers.map((v, index) => renderVoucherSlip(sanitizePrintableVoucher(v, plan), { widthMm: width, index })).join("")}</div>`;
}
