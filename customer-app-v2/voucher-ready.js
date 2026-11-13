import { escapeHtml as h } from '/shared/safe-html.js';
import { requestJson } from './compat.js';
import { saveReturnPath, consumeReturnPath } from './errors.js';
import { runButton } from '/shared/pending.js';
import { mountInstallCard, installed, iPhone, webView } from './install.js';
import { withWifiHint, afterSignInPath } from './hotspot-path.js';
import { wifiHint } from './wifi-pairing.js';
import { automaticVoucherDownload, purchasedVoucher, downloadVoucherPdf } from './voucher-delivery.js';
import { startUpdates } from './updates.js';
const api = window.NDAHI_CONFIG.apiUrl, $ = s => document.querySelector(s), params = new URLSearchParams(location.search);
const requestedPayment = params.get('payment');
let voucher, downloading = false, loading = false, offered = false, generation = 0, controller;
async function download() {
  if (!voucher || downloading) return;
  downloading = true;
  try { await runButton($('#downloadVoucher'), 'Preparing PDF…', async () => { $('#downloadStatus').textContent = await downloadVoucherPdf({ api, id: voucher.id }); }); }
  catch (error) { $('#downloadStatus').textContent = error.message || 'Download failed. Your voucher remains in your account.'; }
  finally { downloading = false; }
}
async function load() {
  if (loading) return;
  loading = true; const ticket = ++generation; controller = typeof AbortController === 'function' ? new AbortController() : null; $('#retryVoucher').hidden = true;
  try {
    if (requestedPayment && !/^[A-Za-z0-9_-]{1,100}$/.test(requestedPayment)) throw Error('This purchase link is unavailable. Use your saved vouchers or payment history.');
    const { response, body } = await requestJson(api + '/api/account/dashboard', { credentials: 'include', cache: 'no-store', signal: controller?.signal });
    if (ticket !== generation) return;
    if (response.status === 401) {
      saveReturnPath(); location.replace(withWifiHint('/login?account=1&next=' + encodeURIComponent(location.pathname + (requestedPayment ? '?payment=' + encodeURIComponent(requestedPayment) : '')))); return;
    }
    if (!response.ok) throw Error('Your account could not load. Try again or open Dashboard. Do not pay again.');
    voucher = purchasedVoucher(body, requestedPayment);
    if (!voucher) throw Error('No confirmed voucher was found for this purchase in this account. Check Payments or Vouchers; do not pay again to recover it.');
    // Canvas (PhoneVoucherReady): plan and its facts, the code, its QR and validity on a forest card.
    const plan = voucher.plan || {}, facts = [plan.name || voucher.planId, plan.quotaGb === null ? 'Unlimited' : plan.quotaGb ? `${plan.quotaGb} GB` : '', plan.validityHours ? (plan.validityHours === 24 ? '1 day' : `${Math.round(plan.validityHours / 24)} days`) : ''].filter(Boolean).join(' · ');
    $('#voucherDetails').innerHTML = `<h2>${h(facts)}</h2><label><span class="nd-visually-hidden">Voucher code</span><input readonly value="${h(voucher.code)}"></label><img class="voucher-ready__qr" data-voucher-qr alt="QR code for voucher ${h(voucher.code)}" hidden><p>${voucher.expiresAt ? `Valid until ${h(new Date(voucher.expiresAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }))}` : 'Saved in your account'}. Keep this code private.</p>`;
    $('#copyVoucher').hidden = false;
    $('#voucherStatus').classList.add('nd-visually-hidden');
    requestJson(api + '/api/account/vouchers/' + encodeURIComponent(voucher.id) + '/qr', { credentials: 'include', cache: 'no-store' })
      .then(({ response, body }) => { const img = $('[data-voucher-qr]'); if (response.ok && body.qrCode && img && /^data:image\//.test(body.qrCode)) { img.src = body.qrCode; img.hidden = false; } })
      .catch(() => { /* The code itself is enough to use the voucher. */ });
    $('#voucherDetails').hidden = false; $('#downloadVoucher').hidden = false;
    $('#voucherStatus').textContent = 'Your payment is confirmed and your voucher is saved. Download a copy now, or retrieve it later in Dashboard → Vouchers.';
    mountInstallCard($('#installApp'));
    if (!offered && automaticVoucherDownload({ supported: 'download' in document.createElement('a'), standalone: installed(), apple: iPhone(), webView: webView(), captive: Boolean(wifiHint()) })) {
      // No private document data is stored. Without reliable optional storage,
      // keep the explicit action rather than re-offer a file on every reload.
      try {
        const key = 'ndahi-voucher-download-offer:' + voucher.id;
        if (!sessionStorage.getItem(key)) { sessionStorage.setItem(key, 'offered'); offered = true; void download(); }
      } catch { /* Manual download remains available. */ }
    }
  } catch (error) { if (ticket !== generation) return; $('#voucherStatus').textContent = error.message || 'Voucher delivery is unavailable. Your confirmed payment is unchanged.'; $('#retryVoucher').hidden = false; }
  finally { if (ticket === generation) loading = false; }
}
$('#downloadVoucher').onclick = download;
$('#copyVoucher').onclick = async () => {
  try { await navigator.clipboard.writeText(voucher.code); $('#downloadStatus').textContent = 'Code copied. Keep it private.'; }
  catch { $('#downloadStatus').textContent = 'Copy the code from the card above.'; }
};
$('#retryVoucher').onclick = load;
$('#continueVoucher').onclick = async event => {
  event.preventDefault();
  // Only this explicit action resumes connection. Never close the captive window
  // or treat a file click as evidence that a download finished.
  const button = event.currentTarget; if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  try { consumeReturnPath(null); history.replaceState(null, '', withWifiHint('/voucher-ready.html')); location.assign(await afterSignInPath(false)); }
  finally { button.removeAttribute('aria-busy'); }
};
window.addEventListener('pagehide', () => {
  generation++; controller?.abort(); loading = false; voucher = null;
  $('#voucherDetails').textContent = ''; $('#voucherDetails').hidden = true; $('#downloadVoucher').hidden = true;
  $('#voucherStatus').textContent = 'Sign in to retrieve your saved voucher.';
});
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
startUpdates({ isBusy: () => loading || downloading });
void load();
