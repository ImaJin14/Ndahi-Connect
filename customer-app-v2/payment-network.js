import { paymentNetworkSelection } from '/shared/cameroon-phone.js';

// Enhance checkout without changing payment submission or its recovery state.
export function mountPaymentNetwork(form) {
  if (!form || form.dataset.paymentNetworkReady) return;
  form.dataset.paymentNetworkReady = 'true';
  const network = form.elements.network, hint = form.querySelector('#paymentNetworkHint');
  if (!network || !hint) return;
  const choose = paymentNetworkSelection();
  const reconcile = (manual = false) => {
    // An account purchase uses its transaction-specific payer, never the disabled
    // account contact field. Saved requests keep their original provider intact.
    const payer = form.elements.payerPhone;
    const number = payer && !payer.disabled ? payer.value : form.elements.phone.value;
    const locked = network.matches(':disabled');
    const state = choose({ number, network: network.value, manual, locked });
    if (!locked && network.value !== state.network) network.value = state.network;
    const label = state.network === 'mtn' ? 'MTN Mobile Money' : 'Orange Money';
    const message = locked ? 'This saved payment keeps its original number and network. Recheck it before starting another payment.'
      : !state.number ? 'Enter the payment number to suggest its Mobile Money network. You can always choose it yourself.'
      : !state.valid ? 'Enter a nine-digit Cameroon phone number, optionally starting with +237.'
      : state.manual ? label + ' selected by you. This choice is kept for this payment number.'
      : state.suggestion ? label + ' suggested from the payment number. Change it if this number uses another network.'
      : 'The network could not be identified. Choose MTN or Orange if this number supports Mobile Money.';
    if (hint.textContent !== message) hint.textContent = message;
  };
  form.addEventListener('input', event => { if (['phone', 'payerPhone'].includes(event.target.name)) reconcile(); });
  form.addEventListener('change', event => { if (event.target === network) reconcile(true); else if (['phone', 'payerPhone'].includes(event.target.name)) reconcile(); });
  form.addEventListener('focusin', () => reconcile());
  // Programmatic account prefills and resumed checkout fields do not emit input.
  // Observe only attributes, never text/render changes, and never submit a charge.
  const checkout = form.closest('#checkout') || form;
  const observer = new MutationObserver(() => reconcile());
  observer.observe(checkout, { subtree: true, attributes: true, attributeFilter: ['hidden', 'disabled', 'class', 'open'] });
  reconcile();
  return () => observer.disconnect();
}
mountPaymentNetwork(document.getElementById('purchase'));
