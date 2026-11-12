// The printed voucher card (canvas: VoucherSlip): an A6 card, four to an A4
// page. It renders a voucher already made print-safe by sanitizePrintableVoucher
// (no customer or payment details). Classes only, no inline styles: the print
// pages' CSP forbids them and the server strips them from preview HTML.
const h = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export const VOUCHER_CARD = Object.freeze({
  brand: "NDAHI Connect",
  subtitle: "WI-FI VOUCHER",
  codeLabel: "Voucher code",
  privacy: "Keep this code private",
  perPage: 4,
});

// "7 days (168 hours)" → "7 days"; "Unlimited data (fair use)" → "Unlimited data".
export const shortLabel = (label) => String(label || "").replace(/\s*\([^)]*\)\s*$/, "");

// Data · validity · devices, as the canvas's "5 GB · 7 days · 3 devices".
export function voucherCardFacts(item) {
  // Validity in days where the label gives them: "24 hours (1 day)" → "1 day".
  const days = /\((\d+ days?)\)$/.exec(String(item.validityLabel || ""));
  return [shortLabel(item.allowanceLabel), days ? days[1] : shortLabel(item.validityLabel), item.deviceLabel].filter(Boolean).join(" · ");
}

// How to connect, worded for a card that shows the code above the steps.
export function voucherCardSteps(item) {
  return [
    "Join the NDAHI Connect Wi-Fi",
    "Scan the QR code, or open portal.ndahiconnect.net",
    item.qrConnection ? "Authorize with your account PIN or passkey" : "Type the code above",
  ];
}

// Only an expired, used-up or otherwise unusable voucher names its status.
export const voucherCardStatus = (item) => (["available", "active"].includes(item.statusLabel) ? "" : String(item.statusLabel || ""));

const QR = /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/;

export function renderVoucherCard(item, { index = 0 } = {}) {
  const status = voucherCardStatus(item);
  const qr = QR.test(item.qrCode || "")
    ? `<img class="voucher-card__qr" src="${h(item.qrCode)}" alt="QR code for voucher ${h(item.code)}">`
    : '<p class="voucher-card__qr voucher-card__qr--none">QR unavailable — enter the voucher code.</p>';
  return `<article class="voucher-card" data-voucher-card="${index}" data-voucher-code="${h(item.code)}"><div class="voucher-card__frame">` +
    `<header class="voucher-card__head"><span class="voucher-card__mark" aria-hidden="true">NC</span><span class="voucher-card__brand"><strong>${VOUCHER_CARD.brand}</strong><small>${VOUCHER_CARD.subtitle}</small></span><strong class="voucher-card__price">${h(item.priceLabel)}</strong></header>` +
    `<div class="voucher-card__body">${qr}<div class="voucher-card__info"><p class="voucher-card__plan">${h(item.planName)}</p><p class="voucher-card__facts">${h(voucherCardFacts(item))}</p><p class="voucher-card__label">${VOUCHER_CARD.codeLabel}</p><p class="voucher-card__code">${h(item.code)}</p>${status ? `<p class="voucher-card__status">${h(item.statusHeading)}: ${h(status)}</p>` : ""}</div></div>` +
    `<ol class="voucher-card__steps">${voucherCardSteps(item).map((step) => `<li>${h(step)}</li>`).join("")}</ol>` +
    `<footer class="voucher-card__foot"><span>${h(item.expiryNote)}</span><span>${VOUCHER_CARD.privacy}</span></footer>` +
    `</div></article>`;
}

// Cards in A4 sheets of four; each sheet prints as one page.
export function renderVoucherCardsHtml(items = []) {
  const sheets = [];
  for (let start = 0; start < items.length; start += VOUCHER_CARD.perPage)
    sheets.push(`<div class="voucher-a4-sheet">${items.slice(start, start + VOUCHER_CARD.perPage).map((item, offset) => renderVoucherCard(item, { index: start + offset })).join("")}</div>`);
  return sheets.join("");
}
