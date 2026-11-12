import { openVoucherPrintPreview } from "../shared-app/voucher-print-preview.js";
import { escapeVoucherHtml as h, VOUCHER_PRINT_LAYOUTS, renderThermalSlipsHtml, sanitizePrintableVoucher } from "./voucher-slip.js";
import { renderVoucherCardsHtml } from "../shared-app/voucher-card.js";
export { VOUCHER_PRINT_LAYOUTS, formatValidityLabel, formatAllowanceLabel, formatPriceFcfa, formatDeviceLabel, sanitizePrintableVoucher, renderQrBlockMarkup, renderThermalSlipsHtml } from "./voucher-slip.js";

export function renderVoucherPrintLayout(vouchers = [], plan = {}, layout = "thermal-58") {
  if (layout === "a6") return `<div class="voucher-print-sheet voucher-print-a6" data-print-surface="a6">${renderVoucherCardsHtml(vouchers.map((v) => sanitizePrintableVoucher(v, plan)))}</div>`;
  if (layout === "thermal-80") return renderThermalSlipsHtml(vouchers, plan, 80);
  return renderThermalSlipsHtml(vouchers, plan, 58);
}

let activePrintCleanup = null;

// v2: `toolbar` puts the format and print controls in the page head (canvas:
// AdminVoucherPrint) and `labels` localizes them; without them the v1 toolbar
// sits above the slips.
export function mountGeneratedVoucherPrint({
  container,
  toolbar = null,
  labels = null,
  vouchers = [],
  plan = {},
  layout = "thermal-58",
  printWindow = typeof window !== "undefined" ? window : null,
} = {}) {
  if (!container) return null;
  if (typeof activePrintCleanup === "function") {
    activePrintCleanup();
  }
  let currentLayout = VOUCHER_PRINT_LAYOUTS.includes(layout) ? layout : "thermal-58";
  const hostPanel = typeof container.closest === "function" ? container.closest(".tab-panel") : null;

  const applyBodyPrintLayout = (activeLayout) => {
    if (typeof document !== "undefined" && document.body) {
      if (activeLayout) document.body.dataset.voucherPrintLayout = activeLayout;
      else delete document.body.dataset.voucherPrintLayout;
    }
    if (activeLayout) {
      if (container.dataset) container.dataset.voucherPrintHost = "true";
      if (hostPanel?.dataset) hostPanel.dataset.voucherPrintHost = "true";
    } else {
      if (container.dataset) delete container.dataset.voucherPrintHost;
      if (hostPanel?.dataset) delete hostPanel.dataset.voucherPrintHost;
    }
  };

  const options = () => `<option value="a6"${currentLayout === "a6" ? " selected" : ""}>${h(labels?.a6 || "A6 cards, 4 per A4 page")}</option>
            <option value="thermal-58"${currentLayout === "thermal-58" ? " selected" : ""}>${h(labels ? labels.thermal58 : "Thermal POS slip (58mm)")}</option>
            <option value="thermal-80"${currentLayout === "thermal-80" ? " selected" : ""}>${h(labels ? labels.thermal80 : "Thermal POS slip (80mm)")}</option>`;
  const render = () => {
    applyBodyPrintLayout(currentLayout);
    if (toolbar) {
      toolbar.innerHTML = `<div class="voucher-print-toolbar admin-print__tools" role="region" aria-label="${h(labels.region)}">
      <label class="admin-print__format" for="voucherPrintLayout">${h(labels.format)}</label>
      <select class="nd-input nd-input--sm" id="voucherPrintLayout">${options()}</select>
      <button type="button" class="nd-btn" id="printVouchersNow">${h(labels.print)}</button>
    </div>`;
      container.innerHTML = `<div id="voucherPrintSurface" class="voucher-print-surface" data-active-print-layout="${h(currentLayout)}">
      ${renderVoucherPrintLayout(vouchers, plan, currentLayout)}
    </div>`;
    } else container.innerHTML = `<div class="voucher-print-toolbar" role="region" aria-label="Printable voucher layouts">
      <div class="voucher-print-controls">
        <label class="voucher-print-format-label">Print format
          <select id="voucherPrintLayout" aria-label="Print layout">
            <option value="a6"${currentLayout === "a6" ? " selected" : ""}>A6 cards, 4 per A4 page</option>
            <option value="thermal-58"${currentLayout === "thermal-58" ? " selected" : ""}>Thermal POS slip (58mm)</option>
            <option value="thermal-80"${currentLayout === "thermal-80" ? " selected" : ""}>Thermal POS slip (80mm)</option>
          </select>
        </label>
        <button type="button" id="printVouchersNow">Print vouchers</button>
      </div>
      <p class="form-help voucher-print-privacy-note">Customer names, phone numbers, and payment details are excluded from printed slips.</p>
    </div>
    <div id="voucherPrintSurface" class="voucher-print-surface" data-active-print-layout="${h(currentLayout)}">
      ${renderVoucherPrintLayout(vouchers, plan, currentLayout)}
    </div>`;

    const controls = toolbar || container;
    const select = controls.querySelector("#voucherPrintLayout");
    const printButton = controls.querySelector("#printVouchersNow");
    if (select) {
      select.onchange = () => {
        currentLayout = VOUCHER_PRINT_LAYOUTS.includes(select.value) ? select.value : "thermal-58";
        render();
      };
    }
    if (printButton) {
      printButton.onclick = () => {
        applyBodyPrintLayout(currentLayout);
        if (printWindow && typeof printWindow.open === "function") {
          const { url } = openVoucherPrintPreview({ voucherIds: vouchers.map(v => v.id), widthMm: currentLayout === "thermal-80" ? 80 : 58, layout: currentLayout === "a6" ? "a6" : undefined, target: printWindow });
          let fallback = controls.querySelector("[data-open-print-preview]");
          if (!fallback) { fallback = document.createElement("a"); fallback.dataset.openPrintPreview = "true"; fallback.textContent = labels ? labels.openHere : "Open print preview in this tab"; (controls.querySelector(".voucher-print-controls") || controls.querySelector(".voucher-print-toolbar")).appendChild(fallback); }
          fallback.href = url;
        }
      };
    }
  };

  const destroy = () => {
    if (activePrintCleanup === destroy) activePrintCleanup = null;
    applyBodyPrintLayout("");
    container.replaceChildren();
    if (toolbar) toolbar.replaceChildren();
  };
  activePrintCleanup = destroy;

  render();
  return {
    getLayout: () => currentLayout,
    setLayout: (nextLayout) => {
      if (VOUCHER_PRINT_LAYOUTS.includes(nextLayout)) {
        currentLayout = nextLayout;
        render();
      }
    },
    destroy,
  };
}

