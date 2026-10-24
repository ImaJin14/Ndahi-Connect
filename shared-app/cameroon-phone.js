// Verified numbering blocks: Cameroon ART's 2014 plan published by the ITU.
// Deliberately a suggestion: portability and later allocations need manual choice.
export function normalizeCameroonPhone(value) {
  return String(value == null ? '' : value).replace(/[\s()-]/g, '').replace(/^(?:\+237|00237|237)(?=6)/, '');
}
export function validCameroonPhone(value) {
  return /^6\d{8}$/.test(normalizeCameroonPhone(value));
}
export function suggestedPaymentNetwork(value) {
  const number = normalizeCameroonPhone(value);
  if (!validCameroonPhone(number)) return null;
  if (/^(67|65[0-4])/.test(number)) return 'mtn';
  if (/^(69|65[5-9])/.test(number)) return 'orange';
  return null;
}
export function paymentNetworkSelection() {
  const corrections = new Map();
  return function select({ number, network = '', manual = false, locked = false }) {
    const normalized = normalizeCameroonPhone(number), valid = validCameroonPhone(normalized);
    const supported = network === 'mtn' || network === 'orange';
    if (valid && supported && (manual || locked)) corrections.set(normalized, network);
    const suggestion = suggestedPaymentNetwork(normalized), correction = corrections.get(normalized);
    return { number: normalized, valid, suggestion, manual: Boolean(correction), locked,
      network: locked ? network : correction || suggestion || '' };
  };
}
