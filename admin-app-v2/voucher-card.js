// The voucher slip on screen, as drawn (canvas: VoucherSlip, #368; owner
// 26 Nov): the colour card in its page, in the print tray (canvas:
// AdminVoucherPrint) and the voucher page's print preview. Printing itself
// stays on the thermal slip (voucher-print.html).
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { voucherCardModel } from "../shared-app/voucher-card.js";

const L = (key, values) => format(key, values || {}, currentLanguage());

export function renderVoucherCard(voucher, plan = {}) {
  const m = voucherCardModel(voucher, voucher.plan || plan, L, { lang: currentLanguage() });
  return `<article class="voucher-card-page" data-voucher-card="${h(voucher.id || "")}"><div class="voucher-card">
  <div class="voucher-card__head"><span class="voucher-card__mark" aria-hidden="true">NC</span><span class="voucher-card__brand"><strong>${h(m.brand)}</strong><small>${h(m.kind)}</small></span><strong class="voucher-card__price">${h(m.price)}</strong></div>
  <div class="voucher-card__body">${m.qr ? `<img class="voucher-card__qr" src="${h(m.qr)}" alt="${h(m.qrLabel)}">` : `<div class="voucher-card__qr" role="img" aria-label="${h(m.qrLabel)}"></div>`}
    <div><p class="voucher-card__plan">${h(m.plan)}</p><p class="voucher-card__terms">${h(m.terms)}</p><p class="voucher-card__label">${h(m.codeLabel)}</p><p class="voucher-card__code">${h(m.code)}</p></div></div>
  <ol class="voucher-card__steps">${m.steps.map((s) => `<li>${h(s.before)}${s.strong ? `<strong>${h(s.strong)}</strong>` : ""}${h(s.after)}</li>`).join("")}</ol>
  <div class="voucher-card__foot"><span>${h(m.use)}</span>${m.batch ? `<span>${h(m.batch)}</span>` : ""}</div>
</div></article>`;
}

export const renderVoucherCards = (vouchers = [], plan = {}) => vouchers.map((v) => renderVoucherCard(v, plan)).join("");
