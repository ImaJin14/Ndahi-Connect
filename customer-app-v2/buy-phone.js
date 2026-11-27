// Buy a bundle on a phone (canvas: PhoneBuyBundle, #348). When the catalogue
// on sale is the Unlimited one (after the switch, #332), the phone page is the
// board's three steps and two outcomes:
//   1. plan: Personal Unlimited / Home WISP tabs, How long? and How many
//      devices? (combinations not offered are disabled), the selected bundle
//      card, the rule and "Continue · price";
//   2. pay: Review and pay, Pay with MTN MoMo / Orange Money, the Mobile Money
//      number, the price, fee and total, the wallet notice and Pay Now;
//   3. wait: Approve on your phone, Check status and "Payment didn't go
//      through?";
// then Payment received (activating) and You're online (done). The checkout
// form, its submit and the payment checks are onboarding.js's; this module
// only draws. Everything comes from GET /api/plans and the payment record.
// Owner decisions (26 Nov): signed-out exactly as drawn (no Customer login
// link), and after paying the customer stays in Buy a bundle:
// https://github.com/ImaJin14/Ndahi-Connect/issues/348#issuecomment-7202633144
// https://github.com/ImaJin14/Ndahi-Connect/issues/348#issuecomment-7204422528
// https://github.com/ImaJin14/Ndahi-Connect/issues/348#issuecomment-7204666631
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { xaf, validityLabel, planTitle, WALLET_NAMES } from "./buy-desktop.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const DEVICES = [1, 2, 3, 4, 5, 6];
const isPersonal = (plan) => plan.accessType === "personal_unlimited";
export const isHomePlan = (plan) => plan?.accessType === "home_wisp_unlimited";
const devicesLabel = (n) => L(n === 1 ? "deskBuyOneDevice" : "deskBuyDevices", { count: n });
const durationKey = (plan) => `${plan.validityValue}:${plan.validityUnit}:${plan.validityHours}`;

// Personal Unlimited by validity (shortest first), each with its offer per
// device count; and the Home WISP bundles.
export function phoneOffers(plans) {
  const rows = new Map();
  for (const plan of plans.filter(isPersonal)) {
    const key = durationKey(plan);
    if (!rows.has(key)) rows.set(key, { key, hours: Number(plan.validityHours), sample: plan, cells: new Map() });
    if (!rows.get(key).cells.has(plan.deviceSlots)) rows.get(key).cells.set(plan.deviceSlots, plan);
  }
  return { durations: [...rows.values()].sort((a, b) => a.hours - b.hours), home: plans.filter(isHomePlan) };
}

// The bundle shown first, as drawn: 7 days for 2 devices when on sale,
// otherwise the first Personal Unlimited offer, otherwise Home WISP.
export function defaultPhonePlan(plans) {
  const { durations, home } = phoneOffers(plans);
  const week = durations.find((row) => row.hours === 168);
  return week?.cells.get(2) || durations[0]?.cells.values().next().value || home[0] || plans[0];
}

// The same device count in another validity when it's offered there,
// otherwise that validity's smallest offer.
export function planForDuration(plans, key, devices) {
  const row = phoneOffers(plans).durations.find((item) => item.key === key);
  if (!row) return null;
  return row.cells.get(devices) || [...row.cells.entries()].sort((a, b) => a[0] - b[0])[0]?.[1] || null;
}
export function planForDevices(plans, selected, devices) {
  const row = phoneOffers(plans).durations.find((item) => item.key === durationKey(selected));
  return row?.cells.get(devices) || null;
}
export const phoneKindPlan = (plans, kind, lastPersonal) => kind === "wisp"
  ? phoneOffers(plans).home[0] || null
  : (lastPersonal && plans.some((plan) => plan.id === lastPersonal.id) ? lastPersonal : defaultPhonePlan(plans.filter(isPersonal)));

// "Unlimited data · 7 days · 2 registered devices",
// "Unlimited data · household sharing · 30 days".
export function phonePlanDetail(plan) {
  const validity = validityLabel(plan), n = Number(plan.deviceSlots) || 1;
  return isHomePlan(plan) ? L("phoneBuyHomeDetail", { validity })
    : L("phoneBuyDetail", { validity, devices: L(n === 1 ? "phoneBuyRegisteredOne" : "phoneBuyRegistered", { count: n }) });
}
function perks(plan) {
  const n = Number(plan.deviceSlots) || 1;
  return isHomePlan(plan)
    ? [L("phoneBuyPerkHomeData", { validity: validityLabel(plan) }), L("phoneBuyPerkHomeShare"), L("phoneBuyPerkHomeRegister"), L("phoneBuyPerkStarts")]
    : [L("phoneBuyPerkData"), L(n === 1 ? "phoneBuyPerkSlot" : "phoneBuyPerkSlots", { count: n }), L("phoneBuyPerkSharing"), L("phoneBuyPerkStarts")];
}

// Step 1. `continueLabel` and `disabled` say when buying isn't possible now.
export function phonePicker(plans, selected, { disabled = false, continueLabel } = {}) {
  const { durations, home } = phoneOffers(plans);
  const kind = isHomePlan(selected) ? "wisp" : "personal";
  const tabs = durations.length && home.length ? `<div class="buy-phone__tabs" role="tablist" aria-label="${h(L("phoneBuyKind"))}">${[["personal", "deskBuyPersonal"], ["wisp", "deskBuyHome"]].map(([id, key]) =>
    `<button type="button" role="tab" class="buy-phone__tab" data-phone-kind="${id}" aria-selected="${kind === id}" tabindex="${kind === id ? 0 : -1}">${h(L(key))}</button>`).join("")}</div>` : "";
  const row = durations.find((item) => item.key === durationKey(selected));
  const choices = kind === "personal" && row ? `<div class="buy-phone__choices">
  <fieldset class="buy-phone__set"><legend class="buy-phone__legend">${h(L("phoneBuyHowLong"))}</legend><div class="buy-phone__durations">${durations.map((item) =>
    `<button type="button" class="buy-phone__chip" data-phone-duration="${h(item.key)}" aria-pressed="${item === row}">${h(validityLabel(item.sample))}</button>`).join("")}</div></fieldset>
  <fieldset class="buy-phone__set"><legend class="buy-phone__legend">${h(L("phoneBuyHowMany"))}</legend><div class="buy-phone__devices">${DEVICES.map((n) => {
    const plan = row.cells.get(n), price = plan ? xaf(plan.price) : L("deskBuyNotOffered");
    return `<button type="button" class="buy-phone__device${plan ? "" : " buy-phone__device--none"}" data-phone-devices="${n}" aria-pressed="${plan?.id === selected.id}"${plan ? "" : ' aria-disabled="true" disabled'}
      aria-label="${h(L("phoneBuyDeviceChip", { devices: devicesLabel(n), price }))}"><strong>${h(devicesLabel(n))}</strong><span>${h(price)}</span></button>`;
  }).join("")}</div></fieldset>
</div>` : "";
  return `${tabs}${choices}
<section class="buy-phone__card" aria-label="${h(L("phoneBuySelected"))}">
  <div class="buy-phone__card-head"><strong>${h(planTitle(selected))}</strong><strong class="buy-phone__card-price">${h(xaf(selected.price))}</strong></div>
  <ul class="buy-phone__perks">${perks(selected).map((text) => `<li>${h(text)}</li>`).join("")}</ul>
</section>
<p class="buy-phone__rule">${h(L("deskBuyRule"))} <a href="/billing-terms.html">${h(L("phoneBuyRules"))}</a></p>
<div class="buy-phone__foot"><button type="button" class="buy-phone__btn" id="phoneContinue" data-plan="${h(selected.id)}"${disabled ? " disabled" : ""}>${h(continueLabel || L("phoneBuyContinue", { price: xaf(selected.price) }))}</button></div>`;
}

// Step 2: the plan under "Review and pay", Pay with, and what you'll pay.
export const phoneReviewSummary = (plan) => `<p class="buy-phone__summary"><strong>${h(planTitle(plan))}</strong><br><span>${h(phonePlanDetail(plan))}</span></p>`;
export const phoneNetworks = (network) => `<fieldset class="buy-phone__set" id="phoneNetworks"><legend class="buy-phone__legend">${h(L("deskBuyPayWith"))}</legend><div class="buy-phone__methods">${Object.entries(WALLET_NAMES).map(([id, label]) =>
  `<button type="button" class="buy-phone__method" data-phone-network="${id}" aria-pressed="${network === id}">${h(label)}</button>`).join("")}</div></fieldset>`;
export function phoneCost(plan, quote) {
  return `<section class="buy-phone__cost" aria-label="${h(L("phoneBuyWhatPay"))}">
  <div class="buy-phone__qrow"><span>${h(L("deskBuyPrice"))}</span><span>${h(xaf(plan.price))}</span></div>
  ${quote ? `<div class="buy-phone__qrow"><span>${h(L("deskBuyFee"))}</span><span>${h(xaf(quote.fee))}</span></div>
  <div class="buy-phone__total"><strong>${h(L("deskBuyTotal"))}</strong><strong>${h(xaf(quote.total))}</strong></div>`
    : `<p class="buy-phone__fee-note">${h(L("phoneBuyFeeInPrompt"))}</p>`}
</section>`;
}
// The wallet notice above Pay Now, its amount in bold.
export function phoneNotice(plan, network, quote) {
  const wallet = WALLET_NAMES[network];
  if (!wallet) return h(L("deskBuyChooseNetwork"));
  const amount = xaf(quote ? quote.total : plan.price);
  return h(L(quote ? "deskBuyNotice" : "phoneBuyNoticeNoFee", { amount: "\u0000", wallet })).replace("\u0000", `<strong>${h(amount)}</strong>`);
}

// The amount the request asked for: the total with a verified fee, otherwise the price.
const charged = (payment) => (Number.isFinite(payment.fee) && Number.isFinite(payment.total) ? { known: true, amount: xaf(payment.total) } : { known: false, amount: xaf(payment.amount) });
const walletOf = (payment) => WALLET_NAMES[payment.network] || "Mobile Money";
const FOOT = (inner) => `<div class="buy-phone__foot buy-phone__foot--stack">${inner}</div>`;
const SLOT = '<div data-message-slot></div>';

// Step 3: the request was sent. `extra` is the test-only approval button or
// the secure payment link; `problem` the "Payment didn't go through?" button.
export function phoneWait(payment, { number, extra = "", problem = "" } = {}) {
  const { known, amount } = charged(payment);
  return `<div class="buy-phone__stage buy-phone__stage--center">
  <div class="buy-phone__icon buy-phone__icon--wait"><svg width="38" height="38" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2h14v20H5ZM10 18h4M12 7v4l2 2"></path></svg></div>
  <h1 class="buy-phone__h1" id="phoneStageTitle" tabindex="-1">${h(L("phoneBuyApprove"))}</h1>
  <p class="buy-phone__line" id="paymentRequestSummary">${h(L("phoneBuyWaitLine", { wallet: walletOf(payment), amount, number: number || "" }))}</p>
  <ol class="buy-phone__steps"><li>${h(L("phoneBuyWait1"))}</li><li>${h(known ? L("phoneBuyWait2", { total: amount }) : L("phoneBuyWait2NoFee"))}</li><li>${h(L("phoneBuyWait3"))}</li></ol>
  ${extra}${SLOT}
</div>${FOOT(`<button type="button" class="buy-phone__btn" id="phoneCheck">${h(L("phoneBuyCheck"))}</button>${problem}`)}`;
}

// Paid: the confirmation and the Wi-Fi being activated.
export function phoneActivating(payment) {
  const { known, amount } = charged(payment);
  const at = new Date(Date.parse(payment.confirmedAt) || Date.now()).toLocaleTimeString(currentLanguage() === "fr" ? "fr-FR" : "en-GB", { hour: "2-digit", minute: "2-digit" });
  const reference = payment.reference || payment.providerReference || payment.id;
  return `<div class="buy-phone__stage buy-phone__stage--paid">
  <h1 class="buy-phone__h1" id="phoneStageTitle" tabindex="-1">${h(L("phoneBuyPaidTitle"))}</h1>
  <ol class="buy-phone__progress" aria-label="${h(L("phoneBuyProgress"))}">
    <li class="buy-phone__done-item"><span class="buy-phone__tick" aria-hidden="true">✓</span><span><strong>${h(L("phoneBuyConfirmed"))}</strong><span>${h(L("phoneBuyConfirmedLine", { wallet: walletOf(payment), amount: known ? amount : L("phoneBuyPlusFee", { price: amount }), time: at }))}</span></span></li>
    <li class="buy-phone__busy-item"><span class="buy-phone__spinner" aria-hidden="true"></span><span><strong>${h(L("phoneBuyActivating"))}</strong><span>${h(L("phoneBuyActivatingLine"))}</span></span></li>
  </ol>
  <p class="buy-phone__ref">${h(L("phoneBuyReference"))} <strong>${h(reference)}</strong></p>
  ${SLOT}
</div>${FOOT(`<a class="buy-phone__btn buy-phone__btn--secondary" href="/dashboard#activity">${h(L("phoneBuyReceipt"))}</a>`)}`;
}

// Done: online, the active bundle, and where to go next.
export function phoneDone(plan, { home = "/dashboard#home" } = {}) {
  return `<div class="buy-phone__stage buy-phone__stage--center">
  <div class="buy-phone__icon buy-phone__icon--done"><svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"></path></svg></div>
  <h1 class="buy-phone__h1" id="phoneStageTitle" tabindex="-1">${h(L("phoneBuyOnline"))}</h1>
  <p class="buy-phone__line"><strong>${h(planTitle(plan))}</strong> ${h(L("phoneBuyOnlineLine"))}</p>
  <div class="buy-phone__active"><p>${h(L("phoneBuyActiveBundle"))}</p><p>${h(phonePlanDetail(plan))}</p></div>
  ${SLOT}
</div>${FOOT(`<a class="buy-phone__btn" href="${h(home)}">${h(L("phoneBuyGoHome"))}</a><a class="buy-phone__btn buy-phone__btn--secondary" href="/dashboard#activity">${h(L("phoneBuyViewReceipt"))}</a>${isHomePlan(plan)
  ? `<a class="buy-phone__btn buy-phone__btn--secondary" href="/home-router.html">${h(L("phoneBuyRegister"))}</a>` : ""}`)}`;
}

// The bar's step: Step 1 of 3 … Paid, Done.
export const phoneStepLabel = (step) => step === "activating" ? L("phoneBuyPaid") : step === "done" ? L("phoneBuyDone")
  : L("phoneBuyStep", { n: { plan: 1, pay: 2, wait: 3 }[step] || 1 });
