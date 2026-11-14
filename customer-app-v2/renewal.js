// Renewal moments on Home (#252, canvas: PhoneRenew): running low, ending
// soon, ended. The card is active-bundle.js; this sets the Home title, the
// card's next step (a reminder switch, or buy the same bundle again with the
// same Mobile Money number), the tip and the link to why buying waits.
// Phones show the moment instead of Home's shortcuts (portal-home.css).
import { escapeHtml as h } from '/shared/safe-html.js';
import { format } from '/shared/i18n.js';
import { currentLanguage } from '/shared/ui/dom.js';
import { bundlePurchaseContent, renewalMoment } from './active-bundle.js';
import { setHomeTitle } from './portal-nav.js';

const L = (key, values) => format(key, values || {}, currentLanguage());
const TIPS = { lowData: ['homeRenewTipLowTitle', 'homeRenewTipLow'], endsSoon: ['homeRenewTipSoonTitle', 'homeRenewTipSoon'], ended: ['homeRenewTipEndedTitle', 'homeRenewTipEnded'] };
const METHODS = { mtn: 'homeRenewMtn', orange: 'orangeMoney' };

// Placed after the bundle card, one block so desktop keeps the tip and the
// link together; shown by showRenewal.
export function renewalExtras() {
  return `<div class="home-renew-more" id="renewMore" hidden><section class="home-renew-tip" id="renewTip" aria-labelledby="renewTipTitle" hidden><h2 id="renewTipTitle"></h2><p></p></section>
    <a class="home-renew-why" href="/billing-terms.html">${h(L('homeRenewWhy'))}</a></div>`;
}

// "6•• •• 12 45", as the canvas masks a payment number.
export function maskedPayer(phone) {
  const d = String(phone || '').replace(/\D/g, '').replace(/^237(?=\d{9}$)/, '');
  return d.length === 9 ? `${d[0]}•• •• ${d.slice(5, 7)} ${d.slice(7)}` : '';
}

// The number the customer last paid with, offered again for the next bundle.
function lastPayment(payments) {
  const at = (p) => Date.parse(p.confirmedAt || p.createdAt) || 0;
  return (payments || []).filter((p) => p.status === 'paid' && p.payerPhone && METHODS[p.network]).sort((a, b) => at(b) - at(a))[0];
}

function buyAgain(snapshot, payments) {
  const plan = snapshot.bundle.plan;
  if (snapshot.purchase.allowed !== true || !plan || plan.discontinued || !Number.isFinite(plan.price)) return bundlePurchaseContent(snapshot);
  const paid = lastPayment(payments), price = L('homeRenewPrice', { price: plan.price.toLocaleString(currentLanguage() === 'fr' ? 'fr-FR' : 'en-GB') });
  const sub = paid ? L('homeRenewBuySub', { price, method: L(METHODS[paid.network]), number: maskedPayer(paid.payerPhone) }) : price;
  return `<button type="button" class="home-renew__buy" data-quick-renew="${h(plan.id)}"${paid ? ` data-renew-payer="${h(paid.id)}"` : ''}>${h(L('homeRenewBuyAgain', { plan: plan.name }))}<span>${h(sub)}</span></button>
    <a class="home-renew__other" href="/dashboard#bundles">${h(L('homeRenewOtherPlan'))}</a>`;
}

// The switch is the customer's bundle-updates preference, which sends both the
// day-before reminder and the "has ended" notice.
async function mountRemind(input, call) {
  try {
    const { preferences } = await call('/api/account/notifications?view=all&limit=1');
    if (!input.isConnected) return;
    input.checked = preferences?.subscriptionUpdates !== false;
    input.disabled = false;
    input.onchange = async () => {
      const on = input.checked;
      input.disabled = true;
      try { await call('/api/account/notifications', { method: 'POST', body: JSON.stringify({ action: 'preferences', subscriptionUpdates: on }) }); }
      catch (_) { input.checked = !on; } // back to the last saved position
      input.disabled = false;
    };
  } catch (_) { /* Without the preference the switch stays disabled. */ }
}

// What each actions box last drew (a fresh Home render starts a new box).
const drawn = new WeakMap();
// Called with each new bundle snapshot. null (updates paused or failing) keeps
// the moment on screen but takes away buying until the bundle is confirmed again.
export function showRenewal(snapshot, { payments, call, now = Date.now() } = {}) {
  const actions = document.getElementById('renewActions');
  if (!actions) return;
  if (snapshot === null) {
    if (actions.querySelector('[data-quick-renew]')) { actions.innerHTML = ''; drawn.delete(actions); }
    return;
  }
  const moment = renewalMoment(snapshot, now), v = snapshot && snapshot.bundle;
  if (moment) document.body.dataset.renewMoment = moment; else delete document.body.dataset.renewMoment;
  const today = moment === 'endsSoon' && new Date(v.expiresAt).toDateString() === new Date(now).toDateString();
  setHomeTitle(moment ? L(moment === 'lowData' ? 'homeRenewHelloLow' : moment === 'ended' ? 'homeRenewHelloEnded' : today ? 'homeRenewHelloToday' : 'homeRenewHelloTomorrow') : '');
  const tip = document.getElementById('renewTip'), more = document.getElementById('renewMore');
  if (tip) {
    const limit = v && v.devices && v.devices.limit;
    // "A bundle covers up to 3 devices" says nothing for a one-device bundle.
    const [title, body] = TIPS[moment] || [];
    tip.hidden = !moment || (moment === 'ended' && !(limit > 1));
    if (!tip.hidden) {
      tip.querySelector('h2').textContent = L(title);
      tip.querySelector('p').textContent = L(body, { plan: v.plan.name, count: limit });
    }
  }
  if (more) more.hidden = !moment;
  const markup = moment === 'ended' ? buyAgain(snapshot, payments)
    : moment ? `<label class="home-renew__remind"><input type="checkbox" data-renew-remind checked disabled><span>${h(L('homeRenewRemind'))}</span></label>` : '';
  // The switch is drawn once per moment so a poll never undoes a change.
  const key = moment === 'ended' ? markup : moment;
  if (drawn.get(actions) === key) return;
  drawn.set(actions, key);
  actions.innerHTML = markup;
  const remind = actions.querySelector('[data-renew-remind]');
  if (remind && call) void mountRemind(remind, call);
}
