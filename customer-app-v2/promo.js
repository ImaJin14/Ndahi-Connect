// Store promotions in the portal (#302): a banner on Home that counts down to
// the offer's start, then to its end (owner, 21 Nov: "the Black Friday
// countdown should be included also in the customer portal"), and the offer
// in the Shop tab (canvas: PhonePromoBuy): badge, sale price, the free bundle,
// what is left, terms, the checkout line and the free bundle on the order.
// Everything comes from the store catalogue; the countdown runs on the
// server's clock (catalogue.serverTime).
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
  const what = p.bonus ? L("portalPromoHeadline", { price: money(p.salePrice), days: p.bonus.days, plan: p.bonus.planName }) : L("portalPromoHeadlineNoBonus", { price: money(p.salePrice) });
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
    chip: pr.bonus ? `<span class="portal-promo__chip">${h(L("portalPromoChip", { days: pr.bonus.days, plan: pr.bonus.planName }))}</span>` : "",
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
      <span><strong>${h(L("portalPromoGiftTitle", { days: b.days, plan: b.planName }))}</strong><span>${h(L("portalPromoGiftHint", { data: b.quotaGb == null ? L("portalPromoUnlimited") : L("portalPromoData", { gb: b.quotaGb }), devices: b.deviceLimit }))}</span></span></div>` : "",
    terms: `<details class="portal-rule"><summary><span>${h(L("portalPromoTerms"))}</span><span class="portal-rule__chevron" aria-hidden="true"></span></summary><p>${h(text(pr.terms))}</p></details>`,
    button: L("portalPromoDeal", { price: money(pr.salePrice) }), limit: L("portalPromoLimit", { count: pr.perNumberLimit }),
  };
}

// The checkout line and how the free days arrive (a signed-in account).
export function checkoutExtras(p) {
  const b = p.promotion && p.promotion.bonus;
  if (!b) return { line: "", note: "" };
  return { line: `<div class="portal-shop__cost-row portal-promo__line"><span>${h(L("portalPromoLine", { days: b.days, plan: b.planName }))}</span><strong>${h(L("portalPromoFree"))}</strong></div>`,
    note: `<p class="portal-promo__note">${h(L("portalPromoDelivery", { days: b.days }))}</p>` };
}

// The free bundle on an order.
export function orderExtras(o) {
  const b = o.bonus;
  if (!b) return "";
  const values = { days: b.days, plan: b.planName || "", day: b.endsAt ? day(b.endsAt) : "", phone: b.phone || "" };
  const key = { active: "portalPromoOrderActive", reserved: "portalPromoOrderReserved", ended: "portalPromoOrderEnded", not_given: "portalPromoOrderEnded",
    expired: "portalPromoOrderExpired", needs_review: "portalPromoOrderReview" }[b.status] || "portalPromoOrderPending";
  return `<section class="portal-promo__order" aria-label="${h(L("portalPromoGift"))}"><p>${h(L(key, values))}</p>${b.status === "reserved" && b.code
    ? `<p class="portal-promo__code"><span>${h(L("portalPromoCode"))}</span><strong>${h(b.code)}</strong></p>` : ""}</section>`;
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
