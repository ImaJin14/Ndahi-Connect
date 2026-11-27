// Your saved voucher (#367, canvas: PhoneVoucherReady; owner 27 Nov: exactly as
// drawn). The voucher's own terms, its code (without NC-, as on the slip) and
// QR on the forest card, whether it's been used, "See what scanning opens",
// Copy code and Print slip, the note, and "Use it on this device now", which
// resumes this device's connection. The slip page has its own Download PDF.
import { escapeHtml as h } from '/shared/safe-html.js';
import { format, getPreferredLanguage } from '/shared/i18n.js';
import { requestJson } from './compat.js';
import { saveReturnPath, consumeReturnPath } from './errors.js';
import { withWifiHint, afterSignInPath } from './hotspot-path.js';
import { purchasedVoucher } from './voucher-delivery.js';
import { startUpdates } from './updates.js';
// The page follows the customer's language choice (served as English).
const lang = getPreferredLanguage();
document.documentElement.lang = lang;
const L = (key, values) => format(key, values || {}, lang);
const api = window.NDAHI_CONFIG.apiUrl, $ = s => document.querySelector(s), params = new URLSearchParams(location.search);
const requestedPayment = params.get('payment');
const day = (at) => new Date(at).toLocaleDateString(lang === 'fr' ? 'fr-FR' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
// "NC-QF83-ZK4M" shows as "QF83-ZK4M", as on the slip (#368); either form works.
const shown = (code) => String(code || '').replace(/^NC-(?=[0-9A-Z]{4}-[0-9A-Z]{4}$)/, '');
let voucher, loading = false, generation = 0, controller;

// "[PLAN 2] · Unlimited · 7 days · 2 devices"; a fixed-data voucher keeps "Weekly · 5 GB · 7 days".
function facts(v) {
  const plan = v.plan || {}, hours = Number(plan.validityHours), days = hours / 24;
  const length = !Number.isFinite(hours) || hours <= 0 ? '' : Number.isInteger(days) ? L(days === 1 ? 'vreadyOneDay' : 'vreadyDays', { count: days }) : L(hours === 1 ? 'vreadyOneHour' : 'vreadyHours', { count: hours });
  if (v.accessType === 'personal_unlimited' || v.accessType === 'home_wisp_unlimited') {
    const slots = Number(v.deviceSlots ?? v.deviceLimit);
    const what = v.accessType === 'home_wisp_unlimited' ? L('vreadyHousehold') : Number.isInteger(slots) ? L(slots === 1 ? 'vreadyOneDevice' : 'vreadyDevices', { count: slots }) : '';
    // The board's "[PLAN] · Unlimited · …"; a name that already says Unlimited isn't repeated.
    const name = plan.name || v.planId, word = /unlimited|illimit/i.test(name || '') ? '' : L('vreadyUnlimited');
    return [name, word, length, what].filter(Boolean).join(' · ');
  }
  return [plan.name || v.planId, plan.quotaGb === null ? L('vreadyUnlimited') : plan.quotaGb ? `${plan.quotaGb} GB` : '', length].filter(Boolean).join(' · ');
}
// Whether it's been used: "Not used yet · valid until 10 Feb 2027", or its run.
function usage(v) {
  if (v.status === 'available') { const until = v.useBy || v.startBy || v.expiresAt; return until ? L('vreadyNotUsedUntil', { date: day(until) }) : L('vreadyNotUsed'); }
  if (v.status === 'active') return v.expiresAt ? L('vreadyInUse', { date: day(v.expiresAt) }) : L('vreadyInUseOnly');
  return v.expiresAt ? L('vreadyEnded', { date: day(v.expiresAt) }) : L('vreadyEndedOnly');
}

async function load() {
  if (loading) return;
  loading = true; const ticket = ++generation; controller = typeof AbortController === 'function' ? new AbortController() : null; $('#retryVoucher').hidden = true;
  try {
    if (requestedPayment && !/^[A-Za-z0-9_-]{1,100}$/.test(requestedPayment)) throw Error(L('vreadyBadLink'));
    const { response, body } = await requestJson(api + '/api/account/dashboard', { credentials: 'include', cache: 'no-store', signal: controller?.signal });
    if (ticket !== generation) return;
    if (response.status === 401) {
      saveReturnPath(); location.replace(withWifiHint('/login?account=1&next=' + encodeURIComponent(location.pathname + (requestedPayment ? '?payment=' + encodeURIComponent(requestedPayment) : '')))); return;
    }
    if (!response.ok) throw Error(L('vreadyLoadFailed'));
    voucher = purchasedVoucher(body, requestedPayment);
    if (!voucher) throw Error(L('vreadyNotFound'));
    const code = shown(voucher.code);
    $('#voucherDetails').innerHTML = `<p class="vready__eyebrow">${h(facts(voucher))}</p><p class="vready__code" data-voucher-code>${h(code)}</p>`
      + `<img class="vready__qr" data-voucher-qr alt="${h(L('vreadyQrAlt', { code }))}" hidden><p class="vready__line" data-voucher-usage>${h(usage(voucher))}</p>`
      + `<a class="vready__scan" data-voucher-scan hidden>${h(L('vreadyScan'))}</a>`;
    requestJson(api + '/api/account/vouchers/' + encodeURIComponent(voucher.id) + '/qr', { credentials: 'include', cache: 'no-store' })
      .then(({ response: r, body: qr }) => {
        if (!r.ok) return;
        const img = $('[data-voucher-qr]'), link = $('[data-voucher-scan]');
        if (img && /^data:image\//.test(qr.qrCode || '')) { img.src = qr.qrCode; img.hidden = false; }
        // The page the QR opens, on this device.
        if (link && /^https?:\/\//.test(qr.redemptionUrl || '')) { link.href = qr.redemptionUrl; link.hidden = false; }
      })
      .catch(() => { /* The code itself is enough to use the voucher. */ });
    $('#voucherDetails').hidden = false; $('#voucherStatus').textContent = '';
    $('#copyVoucher').hidden = false;
    $('#printVoucher').href = '/voucher-print.html#ids=' + encodeURIComponent(voucher.id) + '&width=58'; $('#printVoucher').hidden = false;
    $('#voucherNote').hidden = false; $('#continueVoucher').hidden = false;
  } catch (error) { if (ticket !== generation) return; $('#voucherStatus').textContent = error.message || L('vreadyUnavailable'); $('#retryVoucher').hidden = false; }
  finally { if (ticket === generation) loading = false; }
}

function labels() {
  $('#voucherTitle').textContent = L('vreadyTitle'); $('#voucherBack').setAttribute('aria-label', L('vreadyBack'));
  $('#voucherStatus').textContent = L('vreadyChecking'); $('#copyVoucher').textContent = L('vreadyCopy'); $('#printVoucher').textContent = L('vreadyPrint');
  $('#retryVoucher').textContent = L('vreadyRetry'); $('#voucherNote').textContent = L('vreadyNote'); $('#continueVoucher').textContent = L('vreadyUseHere');
}
$('#copyVoucher').onclick = async () => {
  try { await navigator.clipboard.writeText(voucher.code); $('#copyVoucher').textContent = L('vreadyCopied'); $('#downloadStatus').textContent = ''; }
  catch { $('#downloadStatus').textContent = L('vreadyCopyFailed'); }
};
$('#retryVoucher').onclick = load;
$('#continueVoucher').onclick = async event => {
  event.preventDefault();
  // Only this explicit action resumes this device's connection: on NDAHI Wi-Fi
  // the sign-in starts the bundle here; elsewhere it opens Home.
  const button = event.currentTarget; if (button.getAttribute('aria-busy') === 'true') return;
  button.setAttribute('aria-busy', 'true');
  try { consumeReturnPath(null); history.replaceState(null, '', withWifiHint('/voucher-ready.html')); location.assign(await afterSignInPath(false)); }
  finally { button.removeAttribute('aria-busy'); }
};
window.addEventListener('pagehide', () => {
  generation++; controller?.abort(); loading = false; voucher = null;
  $('#voucherDetails').textContent = ''; $('#voucherDetails').hidden = true;
  for (const id of ['#copyVoucher', '#printVoucher', '#voucherNote', '#continueVoucher']) $(id).hidden = true;
  $('#voucherStatus').textContent = L('vreadySignIn');
});
window.addEventListener('pageshow', event => { if (event.persisted) void load(); });
labels();
startUpdates({ isBusy: () => loading });
void load();
