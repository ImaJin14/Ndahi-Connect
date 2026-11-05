const h = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (char) =>
    ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    })[char],
  );

export const VOUCHER_PRINT_LAYOUTS = Object.freeze(["thermal-58", "thermal-80", "a4-sheet"]);
export const A4_CARDS_PER_PAGE = 21;

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
 * anonymous, print-safe voucher model suitable for resale slips and A4 sheets.
 */
export function sanitizePrintableVoucher(voucher = {}, fallbackPlan = {}) {
  const plan = voucher.plan && typeof voucher.plan === "object" ? voucher.plan : fallbackPlan || {};
  const code = String(voucher.code || "").trim();
  const planName = String(plan.name || fallbackPlan?.name || voucher.planId || "NDAHI Bundle")
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
  const validityHours = Number(plan.validityHours ?? fallbackPlan?.validityHours ?? 0);
  const deviceLimit = Number(voucher.deviceLimit ?? plan.deviceLimit ?? fallbackPlan?.deviceLimit ?? 1);
  const status = voucher.status === "available" ? "available" : String(voucher.status || "available");
  const expiresAt = status === "available" ? null : voucher.expiresAt || null;
  const qrCode =
    typeof voucher.qrCode === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(voucher.qrCode)
      ? voucher.qrCode
      : "";

  const safe = {
    code,
    planName,
    priceLabel: formatPriceFcfa(price),
    allowanceLabel: formatAllowanceLabel(quotaGb, voucher.quotaBytes),
    validityLabel: formatValidityLabel(validityHours),
    deviceLabel: formatDeviceLabel(deviceLimit, voucher.accessMode),
    expiryNote:
      status === "available" || !expiresAt
        ? "Starts on first redemption"
        : `Expires ${new Date(expiresAt).toISOString().slice(0, 10)}`,
    qrCode,
  };
  for (const key of Object.keys(safe)) {
    if (FORBIDDEN_PII_KEYS.has(key)) delete safe[key];
  }
  return Object.freeze(safe);
}

/** Only render the server's encoded PNG; never insert supplied SVG markup. */
export function renderQrBlockMarkup(item) {
  if (typeof item.qrCode === "string" && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(item.qrCode)) {
    return `<div class="voucher-qr-box"><img src="${h(item.qrCode)}" alt="QR code for voucher ${h(item.code)}" class="voucher-qr-img"></div>`;
  }
  return '<p class="voucher-qr-unavailable">QR unavailable — enter the voucher code.</p>';
}

export function renderThermalSlipsHtml(vouchers = [], plan = {}, widthMm = 58) {
  const width = widthMm === 80 ? 80 : 58;
  const items = vouchers.map((v) => sanitizePrintableVoucher(v, plan));
  return `<div class="voucher-print-sheet voucher-print-thermal voucher-print-thermal-${width}" data-print-surface="thermal-${width}" data-paper-width="${width}mm">${items
    .map(
      (item, index) => `<article class="thermal-slip" data-voucher-slip="${index}" data-voucher-code="${h(item.code)}">
  <header class="thermal-header">
    <p class="thermal-brand">NDAHI CONNECT</p>
    <p class="thermal-subtitle">WI-FI VOUCHER SLIP</p>
  </header>
  <div class="thermal-plan-row">
    <strong class="thermal-plan-name">${h(item.planName)}</strong>
    <span class="thermal-plan-price">${h(item.priceLabel)}</span>
  </div>
  <div class="thermal-code-block" aria-label="Voucher code">
    <span class="thermal-code-label">VOUCHER CODE</span>
    <code class="thermal-voucher-code">${h(item.code)}</code>
  </div>
  ${renderQrBlockMarkup(item)}
  <dl class="thermal-meta">
    <div><dt>Data</dt><dd>${h(item.allowanceLabel)}</dd></div>
    <div><dt>Validity</dt><dd>${h(item.validityLabel)}</dd></div>
    <div><dt>Devices</dt><dd>${h(item.deviceLabel)}</dd></div>
    <div><dt>Activation</dt><dd>${h(item.expiryNote)}</dd></div>
  </dl>
  <footer class="thermal-instructions">
    <p><strong>How to connect:</strong></p>
    <ol>
      <li>Join <strong>NDAHI Connect</strong> Wi-Fi</li>
      <li>Scan the QR code or open portal.ndahiconnect.net</li>
      <li>Enter code <strong>${h(item.code)}</strong></li>
    </ol>
  </footer>
</article>`,
    )
    .join("")}</div>`;
}

export function renderBulkA4SheetHtml(vouchers = [], plan = {}) {
  const items = vouchers.map((v) => sanitizePrintableVoucher(v, plan));
  const pages = [];
  for (let i = 0; i < items.length; i += A4_CARDS_PER_PAGE) {
    pages.push(items.slice(i, i + A4_CARDS_PER_PAGE));
  }
  if (!pages.length) pages.push([]);
  return `<div class="voucher-print-sheet voucher-print-a4" data-print-surface="a4-sheet" data-cards-per-page="${A4_CARDS_PER_PAGE}">${pages
    .map(
      (pageItems, pageIndex) => `<section class="a4-voucher-page" data-a4-page="${pageIndex + 1}" aria-label="Printable voucher sheet page ${pageIndex + 1}">
  <div class="a4-voucher-grid">${pageItems
    .map(
      (item, cardIndex) => `<article class="a4-voucher-card" data-voucher-card="${pageIndex * A4_CARDS_PER_PAGE + cardIndex}" data-voucher-code="${h(item.code)}">
      <div class="a4-card-top">
        <span class="a4-brand">NDAHI CONNECT</span>
        <strong class="a4-price">${h(item.priceLabel)}</strong>
      </div>
      <div class="a4-card-body">
        <div class="a4-card-main">
          <p class="a4-plan">${h(item.planName)}</p>
          <code class="a4-code">${h(item.code)}</code>
          <p class="a4-specs">${h(item.allowanceLabel)} · ${h(item.validityLabel)} · ${h(item.deviceLabel)}</p>
          <p class="a4-connect">Join <strong>NDAHI Connect</strong> Wi-Fi → Enter code or scan QR · ${h(item.expiryNote)}</p>
        </div>
        ${renderQrBlockMarkup(item)}
      </div>
    </article>`,
    )
    .join("")}</div>
</section>`,
    )
    .join("")}</div>`;
}

export function renderVoucherPrintLayout(vouchers = [], plan = {}, layout = "thermal-58") {
  if (layout === "thermal-80") return renderThermalSlipsHtml(vouchers, plan, 80);
  if (layout === "a4-sheet") return renderBulkA4SheetHtml(vouchers, plan);
  return renderThermalSlipsHtml(vouchers, plan, 58);
}

export function mountGeneratedVoucherPrint({
  container,
  vouchers = [],
  plan = {},
  layout = "thermal-58",
  printWindow = typeof window !== "undefined" ? window : null,
} = {}) {
  if (!container) return null;
  let currentLayout = VOUCHER_PRINT_LAYOUTS.includes(layout) ? layout : "thermal-58";

  const applyBodyPrintLayout = (activeLayout) => {
    if (typeof document !== "undefined" && document.body) {
      if (activeLayout) document.body.dataset.voucherPrintLayout = activeLayout;
      else delete document.body.dataset.voucherPrintLayout;
    }
  };

  const render = () => {
    applyBodyPrintLayout(currentLayout);
    container.innerHTML = `<div class="voucher-print-toolbar" role="region" aria-label="Printable voucher layouts">
      <div class="voucher-print-controls">
        <label class="voucher-print-format-label">Print format
          <select id="voucherPrintLayout" aria-label="Print layout">
            <option value="thermal-58"${currentLayout === "thermal-58" ? " selected" : ""}>Thermal POS slip (58mm)</option>
            <option value="thermal-80"${currentLayout === "thermal-80" ? " selected" : ""}>Thermal POS slip (80mm)</option>
            <option value="a4-sheet"${currentLayout === "a4-sheet" ? " selected" : ""}>Bulk A4 cuttable sheet (3×7 grid)</option>
          </select>
        </label>
        <button type="button" id="printVouchersNow">Print vouchers</button>
      </div>
      <p class="form-help voucher-print-privacy-note">Customer names, phone numbers, and payment details are excluded from printed slips.</p>
    </div>
    <div id="voucherPrintSurface" class="voucher-print-surface" data-active-print-layout="${h(currentLayout)}">
      ${renderVoucherPrintLayout(vouchers, plan, currentLayout)}
    </div>`;

    const select = container.querySelector("#voucherPrintLayout");
    const printButton = container.querySelector("#printVouchersNow");
    if (select) {
      select.onchange = () => {
        currentLayout = VOUCHER_PRINT_LAYOUTS.includes(select.value) ? select.value : "thermal-58";
        render();
      };
    }
    if (printButton) {
      printButton.onclick = () => {
        applyBodyPrintLayout(currentLayout);
        if (printWindow && typeof printWindow.print === "function") {
          printWindow.print();
        }
      };
    }
  };

  render();
  return {
    getLayout: () => currentLayout,
    setLayout: (nextLayout) => {
      if (VOUCHER_PRINT_LAYOUTS.includes(nextLayout)) {
        currentLayout = nextLayout;
        render();
      }
    },
    destroy: () => {
      applyBodyPrintLayout("");
      container.replaceChildren();
    },
  };
}

