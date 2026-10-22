import { escapeHtml as h } from "/shared/safe-html.js";
import { formatDataBalance } from "/shared/data-usage.js";
import { voucherHistory } from "/shared/voucher-history.js";
import { formatWhatsAppVoucherShare } from "/shared/i18n.js";

let stopPrevious, filter = "active", page = 1;
export function vouchersCard() {
  return '<section class="surface full" data-portal-view="vouchers" id="voucherHistory"><p class="eyebrow">My vouchers</p><h2>Your voucher codes</h2><p>Keep your codes private. Your current code appears first; expired and used-up codes remain in history for downloads and support.</p><div class="voucher-history-tools"><label>Show vouchers<select data-voucher-filter aria-label="Voucher status"><option value="active">Active</option><option value="expired">Expired</option><option value="exhausted">Exhausted</option><option value="all">All</option></select></label><button type="button" data-voucher-history>View voucher history</button></div><div class="voucher-grid" data-voucher-list></div><nav class="voucher-history-tools" aria-label="Voucher history pages"><button type="button" data-voucher-previous>Previous vouchers</button><span data-voucher-page role="status" aria-live="polite"></span><button type="button" data-voucher-next>Next vouchers</button></nav><p><a href="/dashboard#bundles">Renew or choose a package</a></p></section>';
}
function card(v, currentId) {
  const whatsAppUrl = v.code ? formatWhatsAppVoucherShare(v) : "";
  return `<article class="voucher-card" data-voucher-id="${h(v.id)}"><div class="section-head"><h3>${h(v.plan?.name || v.planId)}</h3><span class="voucher-status">${v.id === currentId ? "Current active code" : h(v.displayStatus)}</span></div><label>Voucher code<input class="voucher-code" data-voucher-code readonly value="${h(v.code || "")}" aria-label="${h(v.plan?.name || v.planId)} voucher code"></label><p>Remaining: <strong>${h(formatDataBalance(v.remainingBytes === undefined ? v.quotaBytes === null ? null : Math.max(0, v.quotaBytes - v.usedBytes) : v.remainingBytes))}</strong><br>Activated: ${h(v.activatedAt ? new Date(v.activatedAt).toLocaleString() : "Not activated")}<br>Expires: ${h(v.expiresAt ? new Date(v.expiresAt).toLocaleString() : "Not activated")}</p>${v.displayStatus !== "active" ? "<p>Viewing or downloading this code does not reactivate its bundle.</p>" : ""}<div class="plan-actions"><button type="button" data-copy-voucher ${v.code ? "" : "disabled"}>Copy code</button><button type="button" class="secondary-action" data-download-voucher="${h(v.id)}" ${v.code ? "" : "disabled"}>Download PDF</button><button type="button" class="secondary-action" data-show-qr="${h(v.id)}" ${v.code ? "" : "disabled"}>Show QR</button>${v.code ? `<a class="button secondary-action whatsapp-share-btn" href="${h(whatsAppUrl)}" target="_blank" rel="noopener noreferrer" data-share-whatsapp="${h(v.id)}">WhatsApp</a>` : ""}</div><p data-voucher-message role="status" aria-live="polite"></p></article>`;
}
export function mountVoucherHistory({ vouchers, activeId }) {
  stopPrevious?.();
  const root = document.getElementById("voucherHistory"); if (!root) return;
  const select = root.querySelector("[data-voucher-filter]"), list = root.querySelector("[data-voucher-list]"), summary = root.querySelector("[data-voucher-page]"), previous = root.querySelector("[data-voucher-previous]"), next = root.querySelector("[data-voucher-next]");
  let signature, model;
  function render(force = false) {
    model = voucherHistory(vouchers, { filter, page, activeId }); page = model.page;
    const value = JSON.stringify([filter, page, model.total, model.currentId, model.items.map((v) => [v.id, v.displayStatus])]);
    if (!force && value === signature) return;
    const restore = list.contains(document.activeElement); signature = value; select.value = filter;
    list.innerHTML = model.items.length ? model.items.map((v) => card(v, model.currentId)).join("") : `<p>${filter === "active" ? "No current active voucher. View your voucher history or choose a package." : "No vouchers match this view."}</p>`;
    summary.textContent = `${model.total} voucher(s) · Page ${page} of ${model.pages}`; previous.disabled = page <= 1; next.disabled = page >= model.pages;
    if (restore) select.focus();
  }
  select.onchange = () => { filter = select.value; page = 1; render(true); };
  root.querySelector("[data-voucher-history]").onclick = () => { filter = "all"; page = 1; render(true); select.focus(); };
  previous.onclick = () => { if (!previous.disabled) { page--; render(true); } };
  next.onclick = () => { if (!next.disabled) { page++; render(true); } };
  const refresh = () => { if (!document.hidden) render(); }; let timer;
  const pause = () => clearInterval(timer);
  const resume = () => { pause(); refresh(); timer = setInterval(refresh, 15000); };
  window.addEventListener("hashchange", refresh); document.addEventListener("visibilitychange", refresh);
  window.addEventListener("pagehide", pause); window.addEventListener("pageshow", resume);
  stopPrevious = () => { pause(); window.removeEventListener("hashchange", refresh); document.removeEventListener("visibilitychange", refresh); window.removeEventListener("pagehide", pause); window.removeEventListener("pageshow", resume); };
  resume();
  render(true);
}
