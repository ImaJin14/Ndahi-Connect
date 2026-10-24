// A browser click offers a file; it cannot prove the customer saved it.
export function automaticVoucherDownload({ supported, standalone, apple, webView, captive } = {}) {
  return supported === true && standalone === true && !apple && !webView && !captive;
}
export function purchaseVoucherDestination(paymentId) {
  return '/voucher-ready.html' + (/^[A-Za-z0-9_-]{1,100}$/.test(paymentId || '') ? '?payment=' + encodeURIComponent(paymentId) : '');
}
export function purchasedVoucher(result, paymentId) {
  const payments = (result.payments || []).filter(p => p.status === 'paid' && p.confirmedAt && p.fulfillmentStatus !== 'needs_review' && (!paymentId || p.id === paymentId));
  const ids = new Set(payments.map(p => p.id));
  return (result.vouchers || []).filter(v => ids.has(v.paymentId) && /^NC-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(v.code || '') && ['active', 'expired', 'exhausted'].includes(v.status))
    .sort((a, b) => Date.parse(b.activatedAt) - Date.parse(a.activatedAt))[0] || null;
}
export async function downloadVoucherPdf({ api, id, fetcher = fetch, document: doc = document, urls = URL }) {
  const response = await fetcher(api + '/api/account/vouchers/' + encodeURIComponent(id) + '/download', { credentials: 'include', cache: 'no-store', headers: { accept: 'application/pdf' } });
  if (!response.ok) throw Error(response.status === 401 ? 'Sign in again to download your saved voucher.' : 'The PDF is temporarily unavailable. Your payment and saved voucher are unchanged. Try again or use Vouchers in Dashboard.');
  const blob = await response.blob();
  if (!(response.headers.get('content-type') || '').toLowerCase().startsWith('application/pdf') || await blob.slice(0, 5).text() !== '%PDF-') throw Error('The PDF is unavailable. Try again from your saved vouchers.');
  const url = urls.createObjectURL(blob), link = doc.createElement('a');
  link.href = url; link.download = 'ndahi-voucher-' + String(id).replace(/[^a-zA-Z0-9_-]/g, '_') + '.pdf';
  try { doc.body.appendChild(link); link.click(); } finally { link.remove(); const cleanup = setTimeout(() => urls.revokeObjectURL(url), 60000); if (cleanup && typeof cleanup.unref === "function") cleanup.unref(); }
  return 'Voucher PDF offered to your browser. If no file appears, try Download Voucher again or open Vouchers in your normal browser.';
}
