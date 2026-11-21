import { speedText } from "../shared-app/bundle-speed.js";
// Store promotions on the public store (#302, canvas: StorePromo,
// PhonePromoBuy). Everything shown comes from the catalogue: the sale price,
// the free bundle, the window and the stock. Countdowns run on the server's
// clock (catalogue.serverTime). Black Friday rules (owner, 20 Nov): the free
// days start when the payment is confirmed; a guest's are reserved for the
// number that pays and claimed with the code on the order.
import { escapeHtml as h } from "/shared/safe-html.js";
import { clockOffset, remaining, keepTicking, pad } from "/shared/countdown.js";

const WORDS = {
  en: {
    upcoming: "Starts in", endsIn: "Ends in", days: "days", hours: "hours", minutes: "minutes",
    headline: "{price} + {days} days of {plan} free.", headlineNoBonus: "{price}, for a short time.",
    lede: "{products}, at a {name} price, with {days} days of {plan} internet free. The days start when your payment is confirmed.",
    ledeNoBonus: "{products}, at a {name} price.",
    or: " or ",
    getDeal: "Get the deal", startsOn: "Starts {day}", left: "{n} left at this price", limit: "{n} per phone number",
    fine: "Ends {day} at {time} or when stock runs out.",
    bonusChip: "+ {days} days {plan} free", bonusCardTitle: "+ {days} days of {plan}, free",
    bonusCardHint: "{data} · up to {devices} devices · starts when your payment is confirmed",
    unlimited: "Unlimited data, fair use", data: "{gb} GB",
    endsStrip: "Ends {day}", leftStrip: "{left} left",
    terms: "Offer terms", dealButton: "Get the deal · {price}",
    lineBonus: "+ {days} days {plan}", free: "Free",
    deliveryAccount: "The {days} days start on your NDAHI account when your payment is confirmed. A bundle already running pauses and carries on after them.",
    deliveryGuest: "The {days} days are reserved for the Mobile Money number that pays, and start when the payment is confirmed. Claim them in the NDAHI portal with that number and the code on your order.",
    orderActive: "{days} days of {plan}: running on your NDAHI account until {day}.",
    orderReserved: "{days} days of {plan}: reserved for {phone} until {day}.",
    orderReservedHow: "Claim them in the NDAHI portal with this number and code. The days are already counting.",
    orderClaim: "Claim my free days", orderCode: "Code",
    orderPending: "{days} days of {plan}: given when your payment is confirmed.",
    orderEnded: "The free {days} days ended with the refund.", orderExpired: "The free {days} days have ended.",
    orderReview: "The free {days} days are being checked by NDAHI. You'll be contacted.",
    gift: "Free bundle",
  },
  fr: {
    upcoming: "Commence dans", endsIn: "Se termine dans", days: "jours", hours: "heures", minutes: "minutes",
    headline: "{price} + {days} jours de {plan} offerts.", headlineNoBonus: "{price}, pour peu de temps.",
    lede: "{products}, à prix {name}, avec {days} jours d’internet {plan} offerts. Les jours commencent quand votre paiement est confirmé.",
    ledeNoBonus: "{products}, à prix {name}.",
    or: " ou ",
    getDeal: "J’en profite", startsOn: "Commence le {day}", left: "Plus que {n} à ce prix", limit: "{n} par numéro de téléphone",
    fine: "Se termine le {day} à {time} ou à épuisement du stock.",
    bonusChip: "+ {days} jours {plan} offerts", bonusCardTitle: "+ {days} jours de {plan}, offerts",
    bonusCardHint: "{data} · jusqu’à {devices} appareils · commence quand votre paiement est confirmé",
    unlimited: "Données illimitées, usage raisonnable", data: "{gb} Go",
    endsStrip: "Se termine le {day}", leftStrip: "encore {left}",
    terms: "Conditions de l’offre", dealButton: "J’en profite · {price}",
    lineBonus: "+ {days} jours {plan}", free: "Offert",
    deliveryAccount: "Les {days} jours commencent sur votre compte NDAHI quand votre paiement est confirmé. Un forfait déjà en cours est mis en pause et reprend après.",
    deliveryGuest: "Les {days} jours sont réservés au numéro Mobile Money qui paie, et commencent quand le paiement est confirmé. Réclamez-les dans le portail NDAHI avec ce numéro et le code de votre commande.",
    orderActive: "{days} jours de {plan} : en cours sur votre compte NDAHI jusqu’au {day}.",
    orderReserved: "{days} jours de {plan} : réservés pour le {phone} jusqu’au {day}.",
    orderReservedHow: "Réclamez-les dans le portail NDAHI avec ce numéro et ce code. Les jours sont déjà comptés.",
    orderClaim: "Réclamer mes jours offerts", orderCode: "Code",
    orderPending: "{days} jours de {plan} : donnés quand votre paiement est confirmé.",
    orderEnded: "Les {days} jours offerts ont pris fin avec le remboursement.", orderExpired: "Les {days} jours offerts sont terminés.",
    orderReview: "Les {days} jours offerts sont en cours de vérification par NDAHI. Vous serez contacté.",
    gift: "Forfait offert",
  },
};

export function createPromo({ lang, money, l }) {
  const w = (key, values = {}) => (WORDS[lang][key] || WORDS.en[key]).replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k]) : m));
  const locale = lang === "fr" ? "fr-FR" : "en-GB", ZONE = "Africa/Douala";
  const day = (at) => new Date(at).toLocaleDateString(locale, { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
  const time = (at) => new Date(at).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ZONE });
  // The last minute of the offer, as people read an end time ("23:59", not "00:00").
  const lastMinute = (at) => new Date(Date.parse(at) - 60000).toISOString();
  let offset = 0;
  const bonusData = (b) => (b.quotaGb == null ? w("unlimited") : w("data", { gb: b.quotaGb }));

  // The offer to count down to: one that's live first, else the next to start.
  const announced = (data) => (data.promotions || []).find((p) => p.status === "live") || (data.promotions || [])[0] || null;
  const productNames = (data, p) => {
    const names = p.productIds.map((id) => data.products.find((x) => x.id === id)).filter(Boolean).map((x) => l(x.name));
    return names.length > 2 ? `${names.slice(0, -1).join(", ")}${w("or")}${names.at(-1)}` : names.join(w("or"));
  };
  const blocks = (target) => `<div class="promo-count" data-countdown="${h(target)}" role="timer" aria-live="off">${["days", "hours", "minutes"].map((unit) =>
    `<div class="promo-count__cell"><strong data-unit="${unit}">00</strong><span>${h(w(unit))}</span></div>`).join("")}</div>`;

  return {
    setServerTime(serverTime) { offset = clockOffset(serverTime); },
    announced,
    // The shop's hero while an offer is live or about to start (canvas: StorePromo).
    hero(data) {
      const p = announced(data);
      if (!p) return "";
      const live = p.status === "live", first = data.products.find((x) => x.id === p.productIds[0]);
      const left = p.productIds.reduce((n, id) => n + (data.products.find((x) => x.id === id)?.available || 0), 0);
      const values = { price: money(p.salePrice), days: p.bonus?.days, plan: p.bonus?.planName, name: l(p.name), products: productNames(data, p) };
      return `<section class="promo-hero" aria-labelledby="promoHeroTitle"><div class="promo-hero__main"><span class="promo-badge">${h(l(p.name))} · ${h(`${new Date(p.startsAt).toLocaleDateString(locale, { day: "numeric", timeZone: ZONE })} – ${new Date(lastMinute(p.endsAt)).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: ZONE })}`)}</span>
        <h1 id="promoHeroTitle">${h(w(p.bonus ? "headline" : "headlineNoBonus", values))}</h1><p>${h(w(p.bonus ? "lede" : "ledeNoBonus", values))}</p>
        <div class="promo-hero__cta">${live ? `<a class="button promo-hero__go" href="#product/${h(encodeURIComponent(first?.id || ""))}">${h(w("getDeal"))}</a>` : `<span class="promo-hero__soon">${h(w("startsOn", { day: `${day(p.startsAt)} · ${time(p.startsAt)}` }))}</span>`}
          <span class="promo-hero__left">${h([live ? w("left", { n: left }) : "", w("limit", { n: p.perNumberLimit })].filter(Boolean).join(" · "))}</span></div></div>
        <div class="promo-hero__side"><p class="promo-hero__when">${h(w(live ? "endsIn" : "upcoming"))}</p>${blocks(live ? p.endsAt : p.startsAt)}
          <p class="promo-hero__fine">${h(w("fine", { day: day(lastMinute(p.endsAt)), time: time(lastMinute(p.endsAt)) }))} ${h(l(p.terms))}</p></div></section>`;
    },
    // A product card's extras: the badge on the photo, the free-bundle chip and
    // what is left at the price.
    card(p) {
      if (!p.promotion) return null;
      return { badge: `<span class="promo-badge promo-badge--photo">${h(l(p.promotion.name))}</span>`,
        // Phone rows show the name here; cards show it on the photo.
        chip: `<span class="promo-badge narrow">${h(l(p.promotion.name))}</span>${p.promotion.bonus ? `<p class="promo-chip">${h(w("bonusChip", { days: p.promotion.bonus.days, plan: p.promotion.bonus.planName }))}</p>` : ""}`,
        stock: w("left", { n: p.available }), button: w("getDeal") };
    },
    // Product page (canvas: PhonePromoBuy, product).
    product(p) {
      const pr = p.promotion;
      if (!pr) return null;
      const b = pr.bonus;
      return {
        badge: `<span class="promo-badge promo-badge--photo">${h(l(pr.name))}</span>`,
        strip: `<div class="promo-strip"><span>${h(w("endsStrip", { day: day(lastMinute(pr.endsAt)) }))}</span><strong data-countdown-inline="${h(pr.endsAt)}"></strong></div>`,
        stock: w("left", { n: p.available }),
        bonus: b ? `<div class="promo-gift"><span class="promo-gift__icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7Zm0 0h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7Z"/></svg></span>
          <div><strong>${h(w("bonusCardTitle", { days: b.days, plan: b.planName }))}</strong><span>${h(w("bonusCardHint", { data: [bonusData(b), speedText(b, { lang, devices: b.deviceLimit })].filter(Boolean).join(" · "), devices: b.deviceLimit }))}</span></div></div>` : "",
        terms: `<details class="policy promo-terms"><summary>${h(w("terms"))}</summary><p>${h(l(pr.terms))}</p></details>`,
        button: w("dealButton", { price: money(pr.salePrice) }), limit: w("limit", { n: pr.perNumberLimit }),
      };
    },
    // Checkout lines under the price (canvas: PhonePromoBuy, checkout).
    checkout(p, signedIn) {
      const b = p.promotion?.bonus;
      if (!b) return { line: "", note: "" };
      return { line: `<div class="checkout-cost__row promo-line"><span>${h(w("lineBonus", { days: b.days, plan: b.planName }))}</span><strong>${h(w("free"))}</strong></div>`,
        note: `<p class="form-help promo-note">${h(w(signedIn ? "deliveryAccount" : "deliveryGuest", { days: b.days }))}</p>` };
    },
    // The free bundle on the order page.
    order(o, portalUrl) {
      const b = o.bonus;
      if (!b) return "";
      const values = { days: b.days, plan: b.planName || "", day: b.endsAt ? day(b.endsAt) : "", phone: b.phone || "" };
      const key = { active: "orderActive", reserved: "orderReserved", ended: "orderEnded", expired: "orderExpired", needs_review: "orderReview", not_given: "orderEnded" }[b.status] || "orderPending";
      return `<section class="promo-order" aria-label="${h(w("gift"))}"><p>${h(w(key, values))}</p>${b.status === "reserved" && b.code
        ? `<p class="promo-order__code"><span>${h(w("orderCode"))}</span><strong>${h(b.code)}</strong></p><p class="form-help">${h(w("orderReservedHow"))}</p><a class="button" href="${h(portalUrl)}/login?claim=${h(encodeURIComponent(b.code))}" target="_blank" rel="noopener">${h(w("orderClaim"))}</a>` : ""}</section>`;
    },
    // Fills every countdown under `root` each second; reloads when one ends.
    tick(root, onEnd) {
      const items = [...root.querySelectorAll("[data-countdown], [data-countdown-inline]")];
      if (!items.length) return;
      keepTicking(root, () => {
        let ended = false;
        for (const el of items) {
          const r = remaining(el.dataset.countdown || el.dataset.countdownInline, offset);
          if (r.ms <= 0) ended = true;
          if (el.dataset.countdown) for (const [unit, value] of [["days", r.days], ["hours", r.hours], ["minutes", r.minutes]]) el.querySelector(`[data-unit="${unit}"]`).textContent = pad(value);
          else el.textContent = w("leftStrip", { left: r.days ? `${r.days} d ${r.hours} h` : `${r.hours} h ${pad(r.minutes)} min` });
        }
        if (ended) { onEnd?.(); return false; }
        return true;
      });
    },
  };
}
