// Store promotions in the portal (#302): a banner on Home that counts down to
// the offer's start, then to its end (owner, 21 Nov: "the Black Friday
// countdown should be included also in the customer portal"), and the offer
// in the Shop tab (canvas: PhonePromoBuy): badge, sale price, the free bundle,
// what is left, terms, the checkout line and the free bundle on the order.
// Everything comes from the store catalogue; the countdown runs on the
// server's clock (catalogue.serverTime).
//
// The free month (owner, 23 Nov, #423): given when the router is collected,
// it waits in the account until the customer presses Start, within its
// window (60 days). Account holders start it from Home or the order.
import { speedText } from "../shared-app/bundle-speed.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { clockOffset, remaining, keepTicking, pad } from "/shared/countdown.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const text = (value) => (value && typeof value === "object" ? value[currentLanguage()] || value.en || "" : value || "");
const money = (value) => `${Number(value).toLocaleString(currentLanguage() === "fr" ? "fr-CM" : "en-CM")} FCFA`;
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB"), ZONE = "Africa/Douala";
const day = (at) => new Date(at).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
const lastMinute = (at) => new Date(Date.parse(at) - 60000).toISOString();
let offset = 0;

// The free bundle's length in words: "1 month" ("a month" in a sentence) for
// 30 days, else its days; what it gives ("Unlimited" or its GB); and the
// noun for it ("free month" for a month, else "free bundle").
const months = (days) => (days > 0 && days % 30 === 0 ? days / 30 : 0);
function length(days, inSentence = false) {
  const m = months(days);
  return m === 1 ? L(inSentence ? "portalPromoMonthA" : "portalPromoMonth") : m ? L("portalPromoMonths", { count: m }) : L("portalPromoDays", { count: days });
}
const dataWord = (b) => (b.quotaGb == null ? L("portalPromoUnlimitedWord") : L("portalPromoData", { gb: b.quotaGb }));
const freeWord = (days) => L(months(days) === 1 ? "portalPromoFreeOne" : "portalPromoFreeMany");
const giftWord = (days, cap = false) => L(months(days) === 1 ? (cap ? "portalPromoGiftMonthCap" : "portalPromoGiftMonth") : (cap ? "portalPromoGiftBundleCap" : "portalPromoGiftBundle"));

export function setServerTime(serverTime) { offset = clockOffset(serverTime); }

// The offer to show: one that's live first, else the next to start.
export function announced(data) {
  const list = (data && data.promotions) || [];
  return list.find((p) => p.status === "live") || list[0] || null;
}

const cells = (target) => `<span class="portal-promo__count" data-countdown="${h(target)}" role="timer" aria-live="off">${["days", "hours", "minutes"].map((unit) =>
  `<span class="portal-promo__cell"><strong data-unit="${unit}">00</strong><span>${h(L(`portalPromo_${unit}`))}</span></span>`).join("")}</span>`;

// The Home banner (and the top of the Shop list).
export function banner(data, titleId = "portalPromoTitle") {
  const p = announced(data);
  if (!p) return "";
  const live = p.status === "live", first = p.productIds[0];
  const names = p.productIds.map((id) => (data.products || []).find((x) => x.id === id)).filter(Boolean).map((x) => text(x.name));
  const what = p.bonus ? L("portalPromoHeadline", { price: money(p.salePrice), length: length(p.bonus.days, true), data: dataWord(p.bonus), free: freeWord(p.bonus.days) })
    : L("portalPromoHeadlineNoBonus", { price: money(p.salePrice) });
  return `<section class="portal-promo" aria-labelledby="${titleId}"><div class="portal-promo__top"><span class="portal-promo__badge">${h(text(p.name))}</span>
      <span class="portal-promo__when">${h(L(live ? "portalPromoEndsIn" : "portalPromoStartsIn"))}</span></div>
    <h2 class="portal-promo__title" id="${titleId}">${h(what)}</h2>
    <p class="portal-promo__products">${h(names.join(L("portalPromoOr")))}</p>
    ${cells(live ? p.endsAt : p.startsAt)}
    <p class="portal-promo__fine">${h(live ? L("portalPromoEnds", { day: day(lastMinute(p.endsAt)) }) : L("portalPromoStarts", { day: day(p.startsAt) }))} · ${h(L("portalPromoLimit", { count: p.perNumberLimit }))}</p>
    <a class="nd-btn portal-promo__go" href="${live && first ? `/dashboard#product/${encodeURIComponent(first)}` : "/dashboard#shop"}">${h(L(live ? "portalPromoSee" : "portalPromoLook"))}</a></section>`;
}

// A list row's extras in the Shop.
export function listExtras(p) {
  const pr = p.promotion;
  if (!pr) return null;
  return { badge: `<span class="portal-promo__badge portal-promo__badge--small">${h(text(pr.name))}</span>`,
    chip: pr.bonus ? `<span class="portal-promo__chip">${h(L("portalPromoChip", { length: length(pr.bonus.days), data: dataWord(pr.bonus), free: freeWord(pr.bonus.days) }))}</span>` : "",
    stock: L("portalPromoLeft", { count: p.available }) };
}

// The product page's extras.
export function productExtras(p) {
  const pr = p.promotion;
  if (!pr) return null;
  const b = pr.bonus;
  return {
    top: `<div class="portal-promo__strip"><span class="portal-promo__badge">${h(text(pr.name))}</span><span>${h(L("portalPromoEnds", { day: day(lastMinute(pr.endsAt)) }))} · <strong data-countdown-inline="${h(pr.endsAt)}"></strong></span></div>`,
    stock: L("portalPromoLeft", { count: p.available }),
    bonus: b ? `<div class="portal-promo__gift"><span class="portal-promo__gift-icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7Zm0 0h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7Z"/></svg></span>
      <span><strong>${h(L("portalPromoGiftTitle", { length: length(b.days), data: dataWord(b), free: freeWord(b.days) }))}</strong><span>${h(L("portalPromoGiftHint", { facts: [b.planName,
        Number.isFinite(b.worth) ? L("portalPromoWorth", { price: money(b.worth) }) : "", speedText(b, { lang: currentLanguage(), devices: b.deviceLimit })].filter(Boolean).join(" · ") }))}</span></span></div>` : "",
    terms: `<details class="portal-rule"><summary><span>${h(L("portalPromoTerms"))}</span><span class="portal-rule__chevron" aria-hidden="true"></span></summary><p>${h(text(pr.terms))}</p></details>`,
    button: L("portalPromoDeal", { price: money(pr.salePrice) }), limit: L("portalPromoLimit", { count: pr.perNumberLimit }),
  };
}

// The deal on a phone (canvas: PhonePromoBuy, #411): the photo with the badge
// and the time left on it, the price with what's left at it, the free bundle,
// the description and terms; Get the deal and the limit at the foot.
export function buyProduct(p, { photo, closed }) {
  const pr = p.promotion, x = productExtras(p);
  const left = pr.unitsLeft == null ? p.available : Math.min(pr.unitsLeft, p.available);
  const regular = Number.isFinite(pr.regularPrice) ? `<s aria-label="${h(L("buyRegular", { price: money(pr.regularPrice) }))}">${h(Number(pr.regularPrice).toLocaleString(currentLanguage() === "fr" ? "fr-CM" : "en-CM"))}</s>` : "";
  return { top: `<div class="portal-buy__photo">${photo}<span class="portal-buy__badge">${h(text(pr.name))}</span><span class="portal-buy__strip"><span>${h(L("portalPromoEnds", { day: day(lastMinute(pr.endsAt)) }))}</span><strong data-countdown-inline="${h(pr.endsAt)}"></strong></span></div>`,
    price: `<div class="portal-buy__price"><p><strong>${h(money(pr.salePrice))}</strong>${regular}</p>${left > 0 && !closed ? `<span class="portal-buy__left">${h(L("portalPromoLeft", { count: left }))}</span>` : ""}</div>`,
    bonus: x.bonus, terms: x.terms.replace('class="portal-rule"', 'class="portal-rule portal-buy__terms"'), button: x.button,
    limit: L("buyLimit", { count: pr.perNumberLimit }), left };
}
// The deal's checkout (canvas: PhonePromoBuy, owner 27 Nov): the order with
// its free bundle, fee and total, how the free bundle arrives, where to collect.
export function buyOrderLines(p, quantity, quote) {
  const pr = p.promotion, b = pr.bonus, price = quote ? quote.price : pr.salePrice * quantity;
  return `<section class="portal-buy__order" id="shopCost" aria-label="${h(L("buyOrder"))}">
    <div class="portal-buy__ln"><span><strong>${h(text(p.name))}</strong>${quantity > 1 ? ` × ${quantity}` : ""} <span class="portal-buy__badge portal-buy__badge--small">${h(text(pr.name))}</span></span><span>${h(money(price))}</span></div>
    ${b ? `<div class="portal-buy__ln portal-buy__ln--free"><span>${h(L("portalPromoLine", { length: length(b.days), data: dataWord(b), plan: b.planName }))}</span><strong>${h(L("portalPromoFree"))}</strong></div>` : ""}
    <div class="portal-buy__ln portal-buy__ln--fee"><span>${h(L(quote ? "deskBuyFee" : "deskBuyFeePlain"))}</span><span>${h(quote ? money(quote.fee) : L("deskBuyFeeInPrompt"))}</span></div>
    ${quote ? `<div class="portal-buy__ln portal-buy__ln--total"><strong>${h(L("deskBuyTotal"))}</strong><strong>${h(money(quote.total))}</strong></div>` : ""}</section>`;
}
export function buyHow(p) {
  const b = p.promotion.bonus;
  if (!b) return "";
  return `<section class="portal-buy__how" aria-label="${h(L("buyFreeMonthLabel"))}"><strong>${h(L("portalPromoHowTitle", { gift: giftWord(b.days) }))}</strong>${h(L(b.givenAt === "payment" ? "buyDeliveryPayment" : "portalPromoDelivery"))}</section>`;
}
// Order placed for a deal: the timeline of the router and the free bundle.
export function buyDone(o, place) {
  const b = o.bonus, paid = Number.isFinite(o.total) ? o.total : o.amount;
  const steps = [[L("buyPaid"), money(paid), true], [L("buyCollect"), L("buyCollectHint", { place }), false],
    ...(b ? [[L("buyGet", { gift: giftWord(b.days) }), L(b.givenAt === "payment" ? "buyGetAccountPaid" : "buyGetAccount"), false],
      [L("buyStart"), L("buyStartHint", { within: b.startWithinDays || 60, days: b.days, data: b.planName && /unlimited/i.test(b.planName) ? L("portalPromoUnlimitedWord") : dataWord({ quotaGb: null }) }), false]] : [])];
  return `<section class="portal-buy__timeline" aria-labelledby="buyTimelineTitle"><h2 id="buyTimelineTitle">${h(L("buyTimeline", { gift: b ? giftWord(b.days) : L("portalPromoGiftBundle") }))}</h2>
    <ol class="portal-buy__tl">${steps.map(([title, line, done], i) => `<li><span class="portal-buy__dot${done ? " is-done" : ""}" aria-hidden="true"></span><strong>${h(title)}</strong>${i === 0 ? ` · ${h(line)}` : `<br><span>${h(line)}</span>`}</li>`).join("")}</ol></section>`;
}

// The checkout line and how the free days arrive (a signed-in account).
export function checkoutExtras(p) {
  const b = p.promotion && p.promotion.bonus;
  if (!b) return { line: "", note: "" };
  return { line: `<div class="portal-shop__cost-row portal-promo__line"><span>${h(L("portalPromoLine", { length: length(b.days), data: dataWord(b), plan: b.planName }))}</span><strong>${h(L("portalPromoFree"))}</strong></div>`,
    note: `<p class="portal-promo__note"><strong class="portal-promo__note-title">${h(L("portalPromoHowTitle", { gift: giftWord(b.days) }))}</strong> ${h(L("portalPromoDelivery"))}</p>` };
}

// The free bundle on an order. Under the 23 Nov rule (b.rule
// "customer_start") it is given at collection and started by the customer;
// orders placed under the 20 Nov rule keep their wording.
export function orderExtras(o) {
  const b = o.bonus;
  if (!b) return "";
  if (b.rule !== "customer_start") {
    const values = { days: b.days, plan: b.planName || "", day: b.endsAt ? day(b.endsAt) : "", phone: b.phone || "" };
    const key = { active: "portalPromoOrderActive", reserved: "portalPromoOrderReserved", ended: "portalPromoOrderEnded", not_given: "portalPromoOrderEnded",
      expired: "portalPromoOrderExpired", needs_review: "portalPromoOrderReview" }[b.status] || "portalPromoOrderPending";
    return `<section class="portal-promo__order" aria-label="${h(L("portalPromoGift"))}"><p>${h(L(key, values))}</p>${b.status === "reserved" && b.code
      ? `<p class="portal-promo__code"><span>${h(L("portalPromoCode"))}</span><strong>${h(b.code)}</strong></p>` : ""}</section>`;
  }
  const values = { Gift: giftWord(b.days, true), length: length(b.days), data: b.planName || "", phone: b.phone || "",
    day: day(b.status === "active" ? b.endsAt : b.startBy || b.endsAt || Date.now()) };
  const key = { given: "portalPromoOrderGiven", reserved: "portalPromoOrderReservedStart", active: "portalPromoOrderRunning", expired: "portalPromoOrderExpiredUnstarted",
    cancelled: "portalPromoOrderCancelled", not_given: "portalPromoOrderCancelled", ended: "portalPromoOrderEndedRefund", needs_review: "portalPromoOrderReview" }[b.status] || "portalPromoOrderCollect";
  return `<section class="portal-promo__order" aria-label="${h(giftWord(b.days, true))}"><p>${h(L(key, { ...values, days: b.days }))}</p>${b.status === "reserved" && b.code
    ? `<p class="portal-promo__code"><span>${h(L("portalPromoCode"))}</span><strong>${h(b.code)}</strong></p>` : ""}${b.status === "given" && b.voucherId
    ? `<button type="button" class="nd-btn nd-btn--block" data-free-month-start="${h(b.voucherId)}">${h(L("portalPromoStart", { gift: giftWord(b.days) }))}</button><p class="nd-meta" data-free-month-message role="status" aria-live="polite"></p>` : ""}</section>`;
}

// Home (#423): a free month waiting in the account, until its deadline.
// `vouchers` are the account's bundles from the dashboard; `running` is the
// bundle in use now, which starting the free month pauses.
export function freeMonthCard(vouchers, running) {
  const v = (vouchers || []).find((x) => x.status === "available" && x.promotion && x.promotion.rule === "customer_start" && Date.parse(x.promotion.startBy) > Date.now());
  if (!v) return "";
  const days = Math.round(v.promotion.validityHours / 24), plan = v.plan || {};
  const b = { quotaGb: v.quotaBytes == null ? null : Math.round(v.quotaBytes / 1e8) / 10 };
  return `<section class="portal-promo portal-promo--free-month" aria-labelledby="freeMonthTitle"><h2 class="portal-promo__title" id="freeMonthTitle">${h(L("portalPromoStart", { gift: giftWord(days) }))}</h2>
    <p class="portal-promo__products">${h(L("portalPromoHomeBody", { length: length(days), data: dataWord(b), plan: plan.name || "", day: day(v.promotion.startBy) }))}</p>
    ${running ? `<p class="portal-promo__fine">${h(L("portalPromoStartPauses"))}</p>` : ""}
    <button type="button" class="nd-btn portal-promo__go" data-free-month-start="${h(v.id)}">${h(L("portalPromoStartNow"))}</button>
    <p class="portal-promo__fine" data-free-month-message role="status" aria-live="polite"></p></section>`;
}

// Wires every Start button under `root`: POST, then `onStarted(result)`. A
// repeated press is safe (the server answers with the free month as it is).
export function bindFreeMonth(root, call, onStarted) {
  for (const button of root.querySelectorAll("[data-free-month-start]")) {
    button.onclick = async () => {
      const message = button.parentElement.querySelector("[data-free-month-message]"), label = button.textContent;
      button.disabled = true;
      button.textContent = L("portalPromoStarting");
      try {
        const result = await call("/api/account/store/bonus/start", { method: "POST", body: JSON.stringify({ voucherId: button.dataset.freeMonthStart }) });
        if (message) message.textContent = L("portalPromoStarted", { day: day(result.voucher.expiresAt) });
        button.remove();
        if (onStarted) onStarted(result);
      } catch (error) {
        button.disabled = false;
        button.textContent = label;
        if (message) message.textContent = error.message;
      }
    };
  }
}

// Fills the countdowns under `root` each second; `onEnd` when one reaches 0.
export function tick(root, onEnd) {
  const items = [...root.querySelectorAll("[data-countdown], [data-countdown-inline]")];
  if (!items.length) return;
  keepTicking(root, () => {
    let ended = false;
    for (const el of items) {
      const r = remaining(el.dataset.countdown || el.dataset.countdownInline, offset);
      if (r.ms <= 0) ended = true;
      if (el.dataset.countdown) for (const [unit, value] of [["days", r.days], ["hours", r.hours], ["minutes", r.minutes]]) el.querySelector(`[data-unit="${unit}"]`).textContent = pad(value);
      else el.textContent = L("portalPromoLeftTime", { left: r.days ? L("portalPromoDH", { days: r.days, hours: r.hours }) : L("portalPromoHM", { hours: r.hours, minutes: pad(r.minutes) }) });
    }
    if (ended) { onEnd && onEnd(); return false; }
    return true;
  });
}
