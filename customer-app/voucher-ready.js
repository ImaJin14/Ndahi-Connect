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
let voucher, downloading = false, loading = false, offered = false;
async function download() {
  if (!voucher || downloading) return;
  downloading = true;
  try { await runButton($('#downloadVoucher'), 'Preparing PDF…', async () => { $('#downloadStatus').textContent = await downloadVoucherPdf({ api, id: voucher.id }); }); }
  catch (error) { $('#downloadStatus').textContent = error.message || 'Download failed. Your voucher remains in your account.'; }
  finally { downloading = false; }
}
async function load() {
  if (loading) return;
  loading = true; $('#retryVoucher').hidden = true;
  try {
    if (requestedPayment && !/^[A-Za-z0-9_-]{1,100}$/.test(requestedPayment)) throw Error('This purchase link is unavailable. Use your saved vouchers or payment history.');
    const { response, body } = await requestJson(api + '/api/account/dashboard', { credentials: 'include', cache: 'no-store' });
    if (response.status === 401) {
      saveReturnPath(); location.replace(withWifiHint('/login?account=1&next=' + encodeURIComponent(location.pathname + (requestedPayment ? '?payment=' + encodeURIComponent(requestedPayment) : '')))); return;
    }
    if (!response.ok) throw Error('Your account could not load. Try again or open Dashboard. Do not pay again.');
    voucher = purchasedVoucher(body, requestedPayment);
    if (!voucher) throw Error('No confirmed voucher was found for this purchase in this account. Check Payments or Vouchers; do not pay again to recover it.');
    $('#voucherDetails').innerHTML = `<h2>${h(voucher.plan?.name || voucher.planId)}</h2><label>Voucher code<input readonly value="${h(voucher.code)}"></label><p>Keep this code private. The voucher was saved before this page opened.</p>`;
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
  } catch (error) { $('#voucherStatus').textContent = error.message || 'Voucher delivery is unavailable. Your confirmed payment is unchanged.'; $('#retryVoucher').hidden = false; }
  finally { loading = false; }
}
$('#downloadVoucher').onclick = download;
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
startUpdates({ isBusy: () => loading || downloading });
void load();
