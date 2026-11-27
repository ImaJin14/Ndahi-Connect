import { speedText } from "../shared-app/bundle-speed.js";
// Store promotions on the public store (#302, canvas: StorePromo,
// PhonePromoBuy). Everything shown comes from the catalogue: the sale price,
// the free bundle, the window and the stock. Countdowns run on the server's
// clock (catalogue.serverTime). The free month (owner, 23 Nov, #423): given
// when the router is collected, started by the customer whenever they like
// within 60 days; a guest's is reserved for the number that pays and claimed
// with the code on the collection slip. Orders placed under the 20 Nov rule
// (days from payment) keep their wording.
import { escapeHtml as h } from "/shared/safe-html.js";
import { clockOffset, remaining, keepTicking, pad } from "/shared/countdown.js";

const WORDS = {
  en: {
    upcoming: "Starts in", endsIn: "Ends in", days: "days", hours: "hours", minutes: "minutes",
    headline: "{products} + {length} of {data}, for {price}.", headlineNoBonus: "{price}, for a short time.",
    lede: "Get the router at a {name} price, plus {length} of {data} internet ({plan}) {free}. Start the {gift} whenever you like.",
    ledeNoBonus: "{products}, at a {name} price.",
    or: " or ",
    getDeal: "Get the deal", startsOn: "Starts {day}", left: "{n} left at this price", limit: "{n} per phone number",
    fine: "Ends {day} at {time} or when stock runs out.", fineBonus: "{Gift} given when you collect the router; start within {within} days.",
    bonusChip: "+ {length} {data} {free}", bonusCardTitle: "+ {length} {data} internet, {free}",
    bonusCardHint: "{facts} · start it when you like", worth: "worth {price}",
    unlimited: "Unlimited data, fair use", data: "{gb} GB",
    endsStrip: "Ends {day}", leftStrip: "{left} left",
    terms: "Offer terms", dealButton: "Get the deal · {price}",
    lineBonus: "+ {length} {data} ({plan})", free: "Free",
    howTitle: "How you get your {gift}",
    deliveryAccount: "It's added to your account when you collect the router. It waits there until you press Start — even if you still have a bundle running.",
    deliveryGuest: "It's reserved for the Mobile Money number that pays. When you collect the router you get a slip with a code — claim it with that number and the code.",
    month: "1 month", monthA: "a month", monthOne: "one month", months: "{count} months", daysN: "{count} days", unlimitedWord: "Unlimited",
    freeOne: "free", freeMany: "free", giftMonth: "free month", giftMonthCap: "Free month", giftBundle: "free bundle", giftBundleCap: "Free bundle",
    orderCollect: "{Gift}: given when you collect.",
    orderGiven: "{Gift}: in your NDAHI account. Start it in the portal by {day} — {length} of {data} from then.",
    orderOpenPortal: "Open the NDAHI portal",
    orderReservedStart: "{Gift}: reserved for {phone}. Start it by {day}.",
    orderReservedStartHow: "Claim it in the NDAHI portal with this number and the code, then start it whenever you like.",
    orderClaimGift: "Claim my {gift}",
    orderRunning: "{Gift}: running on your NDAHI account until {day}.",
    orderExpiredUnstarted: "{Gift}: not started by {day}, so it has expired.",
    orderCancelled: "{Gift}: cancelled with the refund.", orderEndedRefund: "{Gift}: ended with the refund.",
    orderActive: "{days} days of {plan}: running on your NDAHI account until {day}.",
    orderReserved: "{days} days of {plan}: reserved for {phone} until {day}.",
    orderReservedHow: "Claim them in the NDAHI portal with this number and code. The days are already counting.",
    orderClaim: "Claim my free days", orderCode: "Code",
    orderPending: "{days} days of {plan}: given when your payment is confirmed.",
    orderEnded: "The free {days} days ended with the refund.", orderExpired: "The free {days} days have ended.",
    orderReview: "The free {days} days are being checked by NDAHI. You'll be contacted.",
    gift: "Free bundle", deliveryGuestPaidPlain: "It's reserved for the Mobile Money number that pays as soon as the payment is confirmed. Claim it with that number and the code on your order.",
    limitCustomer: "Limit {n} per customer", regular: "Regular price {price}", yourOrder: "Your order",
    deliveryGuestNumber: "It's reserved for the Mobile Money number that pays ({number}). When you collect the router you get a slip with a code — claim it with that number and the code.",
    deliveryGuestPaid: "It's reserved for the Mobile Money number that pays ({number}) as soon as the payment is confirmed. Claim it with that number and the code on your order.",
    whoGuest: "{name} · {number} · guest", placedBody: "Order {ref} is paid. We'll let you know when it's ready to collect.",
    timeline: "Your router and {gift}", paid: "Paid", collectRouter: "Collect your router", collectHint: "Show your collection code at {place}",
    getGift: "Get your {gift}", getGuest: "On a slip with your router · reserved for {number}", getGuestPaid: "Reserved for {number} when your payment is confirmed",
    startGift: "Start it when you're ready", startHint: "Within {within} days · {days} days of {data} from then",
    track: "Track my order", keepTogether: "Create an account to keep it together",
  },
  fr: {
    upcoming: "Commence dans", endsIn: "Se termine dans", days: "jours", hours: "heures", minutes: "minutes",
    headline: "{products} + {length} d’internet {data}, pour {price}.", headlineNoBonus: "{price}, pour peu de temps.",
    lede: "Le routeur à prix {name}, plus {length} d’internet {data} ({plan}) {free}. Démarrez votre {gift} quand vous voulez.",
    ledeNoBonus: "{products}, à prix {name}.",
    or: " ou ",
    getDeal: "J’en profite", startsOn: "Commence le {day}", left: "Plus que {n} à ce prix", limit: "{n} par numéro de téléphone",
    fine: "Se termine le {day} à {time} ou à épuisement du stock.", fineBonus: "{Gift} donné au retrait du routeur ; à démarrer dans les {within} jours.",
    bonusChip: "+ {length} {data} {free}", bonusCardTitle: "+ {length} d’internet {data}, {free}",
    bonusCardHint: "{facts} · à démarrer quand vous voulez", worth: "d’une valeur de {price}",
    unlimited: "Données illimitées, usage raisonnable", data: "{gb} Go",
    endsStrip: "Se termine le {day}", leftStrip: "encore {left}",
    terms: "Conditions de l’offre", dealButton: "J’en profite · {price}",
    lineBonus: "+ {length} {data} ({plan})", free: "Offert",
    howTitle: "Comment obtenir votre {gift}",
    deliveryAccount: "Il est ajouté à votre compte quand vous récupérez le routeur. Il y attend jusqu’à ce que vous appuyiez sur Démarrer — même si un forfait est encore en cours.",
    deliveryGuest: "Il est réservé au numéro Mobile Money qui paie. Au retrait du routeur, vous recevez un ticket avec un code — réclamez-le avec ce numéro et ce code.",
    month: "1 mois", monthA: "un mois", monthOne: "un mois", months: "{count} mois", daysN: "{count} jours", unlimitedWord: "Illimité",
    freeOne: "offert", freeMany: "offerts", giftMonth: "mois offert", giftMonthCap: "Mois offert", giftBundle: "forfait offert", giftBundleCap: "Forfait offert",
    orderCollect: "{Gift} : donné quand vous récupérez le routeur.",
    orderGiven: "{Gift} : dans votre compte NDAHI. Démarrez-le dans le portail avant le {day} — {length} d’internet {data} à partir de là.",
    orderOpenPortal: "Ouvrir le portail NDAHI",
    orderReservedStart: "{Gift} : réservé pour le {phone}. Démarrez-le avant le {day}.",
    orderReservedStartHow: "Réclamez-le dans le portail NDAHI avec ce numéro et ce code, puis démarrez-le quand vous voulez.",
    orderClaimGift: "Réclamer mon {gift}",
    orderRunning: "{Gift} : en cours sur votre compte NDAHI jusqu’au {day}.",
    orderExpiredUnstarted: "{Gift} : non démarré avant le {day}, il a expiré.",
    orderCancelled: "{Gift} : annulé avec le remboursement.", orderEndedRefund: "{Gift} : terminé avec le remboursement.",
    orderActive: "{days} jours de {plan} : en cours sur votre compte NDAHI jusqu’au {day}.",
    orderReserved: "{days} jours de {plan} : réservés pour le {phone} jusqu’au {day}.",
    orderReservedHow: "Réclamez-les dans le portail NDAHI avec ce numéro et ce code. Les jours sont déjà comptés.",
    orderClaim: "Réclamer mes jours offerts", orderCode: "Code",
    orderPending: "{days} jours de {plan} : donnés quand votre paiement est confirmé.",
    orderEnded: "Les {days} jours offerts ont pris fin avec le remboursement.", orderExpired: "Les {days} jours offerts sont terminés.",
    orderReview: "Les {days} jours offerts sont en cours de vérification par NDAHI. Vous serez contacté.",
    gift: "Forfait offert", deliveryGuestPaidPlain: "Il est réservé au numéro Mobile Money qui paie dès que le paiement est confirmé. Réclamez-le avec ce numéro et le code de votre commande.",
    limitCustomer: "Limite : {n} par client", regular: "Prix normal {price}", yourOrder: "Votre commande",
    deliveryGuestNumber: "Il est réservé au numéro Mobile Money qui paie ({number}). Au retrait du routeur, vous recevez un bon avec un code — réclamez-le avec ce numéro et le code.",
    deliveryGuestPaid: "Il est réservé au numéro Mobile Money qui paie ({number}) dès que le paiement est confirmé. Réclamez-le avec ce numéro et le code de votre commande.",
    whoGuest: "{name} · {number} · invité", placedBody: "La commande {ref} est payée. Nous vous préviendrons quand elle sera prête à retirer.",
    timeline: "Votre routeur et votre {gift}", paid: "Payé", collectRouter: "Retirez votre routeur", collectHint: "Montrez votre code de retrait à {place}",
    getGift: "Recevez votre {gift}", getGuest: "Sur un bon avec votre routeur · réservé pour {number}", getGuestPaid: "Réservé pour {number} dès que le paiement est confirmé",
    startGift: "Démarrez-le quand vous voulez", startHint: "Dans les {within} jours · {days} jours d'internet {data} à partir de là",
    track: "Suivre ma commande", keepTogether: "Créer un compte pour tout garder ensemble",
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
  // The free bundle's length in words ("1 month", "a month" or "one month" in
  // a sentence, else its days), what it gives, and its noun ("free month").
  const monthsOf = (days) => (days > 0 && days % 30 === 0 ? days / 30 : 0);
  const length = (days, form = "month") => { const m = monthsOf(days); return m === 1 ? w(form) : m ? w("months", { count: m }) : w("daysN", { count: days }); };
  const dataWord = (b) => (b.quotaGb == null ? w("unlimitedWord") : w("data", { gb: b.quotaGb }));
  const freeWord = (days) => w(monthsOf(days) === 1 ? "freeOne" : "freeMany");
  const giftWord = (days, cap = false) => w(monthsOf(days) === 1 ? (cap ? "giftMonthCap" : "giftMonth") : (cap ? "giftBundleCap" : "giftBundle"));

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
      const b = p.bonus, values = { price: money(p.salePrice), name: l(p.name), products: productNames(data, p),
        ...(b ? { plan: b.planName, data: dataWord(b), free: freeWord(b.days), gift: giftWord(b.days) } : {}) };
      const headline = b ? w("headline", { ...values, length: length(b.days, "monthA") }) : w("headlineNoBonus", values);
      const lede = b ? w("lede", { ...values, length: length(b.days, "monthOne") }) : w("ledeNoBonus", values);
      return `<section class="promo-hero" aria-labelledby="promoHeroTitle"><div class="promo-hero__main"><span class="promo-badge">${h(l(p.name))} · ${h(`${new Date(p.startsAt).toLocaleDateString(locale, { day: "numeric", timeZone: ZONE })} – ${new Date(lastMinute(p.endsAt)).toLocaleDateString(locale, { day: "numeric", month: "short", timeZone: ZONE })}`)}</span>
        <h1 id="promoHeroTitle">${h(headline)}</h1><p>${h(lede)}</p>
        <div class="promo-hero__cta">${live ? `<a class="button promo-hero__go" href="#product/${h(encodeURIComponent(first?.id || ""))}">${h(w("getDeal"))}</a>` : `<span class="promo-hero__soon">${h(w("startsOn", { day: `${day(p.startsAt)} · ${time(p.startsAt)}` }))}</span>`}
          <span class="promo-hero__left">${h([live ? w("left", { n: left }) : "", w("limit", { n: p.perNumberLimit })].filter(Boolean).join(" · "))}</span></div></div>
        <div class="promo-hero__side"><p class="promo-hero__when">${h(w(live ? "endsIn" : "upcoming"))}</p>${blocks(live ? p.endsAt : p.startsAt)}
          <p class="promo-hero__fine">${h([w("fine", { day: day(lastMinute(p.endsAt)), time: time(lastMinute(p.endsAt)) }),
            b && b.startsAt === "customer_start" ? w("fineBonus", { Gift: giftWord(b.days, true), within: b.startWithinDays }) : "", l(p.terms)].filter(Boolean).join(" "))}</p></div></section>`;
    },
    // A product card's extras: the badge on the photo, the free-bundle chip and
    // what is left at the price.
    card(p) {
      if (!p.promotion) return null;
      return { badge: `<span class="promo-badge promo-badge--photo">${h(l(p.promotion.name))}</span>`,
        // Phone rows show the name here; cards show it on the photo.
        chip: `<span class="promo-badge narrow">${h(l(p.promotion.name))}</span>${p.promotion.bonus ? `<p class="promo-chip">${h(w("bonusChip", { length: length(p.promotion.bonus.days), data: dataWord(p.promotion.bonus), free: freeWord(p.promotion.bonus.days) }))}</p>` : ""}`,
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
        stock: w("left", { n: pr.unitsLeft == null ? p.available : Math.min(pr.unitsLeft, p.available) }),
        // The regular price crossed out only after real sales at it (#345).
        regular: Number.isFinite(pr.regularPrice) ? `<s class="promo-was" aria-label="${h(w("regular", { price: money(pr.regularPrice) }))}">${h(money(pr.regularPrice).replace(/\s*FCFA$/, ""))}</s>` : "",
        bonus: b ? `<div class="promo-gift"><span class="promo-gift__icon" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v9H4v-9M2 7h20v5H2zM12 21V7M12 7H7.5a2.5 2.5 0 1 1 0-5C11 2 12 7 12 7Zm0 0h4.5a2.5 2.5 0 1 0 0-5C13 2 12 7 12 7Z"/></svg></span>
          <div><strong>${h(w("bonusCardTitle", { length: length(b.days), data: dataWord(b), free: freeWord(b.days) }))}</strong><span>${h(w("bonusCardHint", { facts: [b.planName,
            Number.isFinite(b.worth) ? w("worth", { price: money(b.worth) }) : "", speedText(b, { lang, devices: b.deviceLimit })].filter(Boolean).join(" · ") }))}</span></div></div>` : "",
        terms: `<details class="policy promo-terms"><summary>${h(w("terms"))}</summary><p>${h(l(pr.terms))}</p></details>`,
        button: w("dealButton", { price: money(pr.salePrice) }), limit: w("limit", { n: pr.perNumberLimit }), limitCustomer: w("limitCustomer", { n: pr.perNumberLimit }),
      };
    },
    // The deal's checkout for a guest (canvas: PhonePromoBuy, guest; owner 27
    // Nov, #411): the order with its free bundle, fee and total, then how the
    // free bundle arrives, for the number that pays.
    buyLines(p, count, quote, labels) {
      const pr = p.promotion, b = pr.bonus, price = quote ? quote.price : pr.salePrice * count;
      return `<section class="buy-order" id="checkoutCost" aria-label="${h(w("yourOrder"))}">
        <div class="buy-ln"><span><strong>${h(l(p.name))}</strong>${count > 1 ? ` × ${count}` : ""} <span class="promo-badge promo-badge--small">${h(l(pr.name))}</span></span><span>${h(money(price))}</span></div>
        ${b ? `<div class="buy-ln buy-ln--free"><span>${h(w("lineBonus", { length: length(b.days), data: dataWord(b), plan: b.planName }))}</span><strong>${h(w("free"))}</strong></div>` : ""}
        <div class="buy-ln buy-ln--fee"><span>${h(quote ? labels.fee : labels.feePlain)}</span><span>${h(quote ? money(quote.fee) : labels.inPrompt)}</span></div>
        ${quote ? `<div class="buy-ln buy-ln--total"><strong>${h(labels.total)}</strong><strong>${h(money(quote.total))}</strong></div>` : ""}</section>`;
    },
    buyHow(p, number, signedIn = false) {
      const b = p.promotion.bonus;
      if (!b) return "";
      return `<section class="buy-how" aria-label="${h(giftWord(b.days, true))}"><strong>${h(w("howTitle", { gift: giftWord(b.days) }))}</strong><span id="buyHowText">${h(signedIn ? w("deliveryAccount") : this.howText(p, number))}</span></section>`;
    },
    // Before a number is typed, the words without it.
    howText(p, number) { const b = p.promotion?.bonus; return !b ? "" : number ? w(b.givenAt === "payment" ? "deliveryGuestPaid" : "deliveryGuestNumber", { number }) : w(b.givenAt === "payment" ? "deliveryGuestPaidPlain" : "deliveryGuest"); },
    // Order placed for a guest's deal: the router and its free bundle.
    buyDone(o, place, number) {
      const b = o.bonus, paid = Number.isFinite(o.total) ? o.total : o.amount;
      const steps = [[w("paid"), money(paid), true], [w("collectRouter"), w("collectHint", { place }), false],
        ...(b ? [[w("getGift", { gift: giftWord(b.days) }), w(b.givenAt === "payment" ? "getGuestPaid" : "getGuest", { number }), false],
          [w("startGift"), w("startHint", { within: b.startWithinDays || 60, days: b.days, data: w("unlimitedWord") }), false]] : [])];
      return `<section class="buy-timeline" aria-labelledby="buyTimelineTitle"><h2 id="buyTimelineTitle">${h(w("timeline", { gift: b ? giftWord(b.days) : giftWord(30) }))}</h2>
        <ol class="buy-tl">${steps.map(([title, line, done], i) => `<li><span class="buy-dot${done ? " is-done" : ""}" aria-hidden="true"></span><strong>${h(title)}</strong>${i === 0 ? ` · ${h(line)}` : `<br><span>${h(line)}</span>`}</li>`).join("")}</ol></section>`;
    },
    words: (key, values) => w(key, values),
    // Checkout lines under the price (canvas: PhonePromoBuy, checkout).
    checkout(p, signedIn) {
      const b = p.promotion?.bonus;
      if (!b) return { line: "", note: "" };
      return { line: `<div class="checkout-cost__row promo-line"><span>${h(w("lineBonus", { length: length(b.days), data: dataWord(b), plan: b.planName }))}</span><strong>${h(w("free"))}</strong></div>`,
        note: `<p class="form-help promo-note"><strong class="promo-note__title">${h(w("howTitle", { gift: giftWord(b.days) }))}</strong> ${h(w(signedIn ? "deliveryAccount" : "deliveryGuest"))}</p>` };
    },
    // The free bundle on the order page. Under the 23 Nov rule it is given at
    // collection and started in the portal; 20 Nov orders keep their wording.
    order(o, portalUrl) {
      const b = o.bonus;
      if (!b) return "";
      if (b.rule !== "customer_start") {
        const values = { days: b.days, plan: b.planName || "", day: b.endsAt ? day(b.endsAt) : "", phone: b.phone || "" };
        const key = { active: "orderActive", reserved: "orderReserved", ended: "orderEnded", expired: "orderExpired", needs_review: "orderReview", not_given: "orderEnded" }[b.status] || "orderPending";
        return `<section class="promo-order" aria-label="${h(w("gift"))}"><p>${h(w(key, values))}</p>${b.status === "reserved" && b.code
          ? `<p class="promo-order__code"><span>${h(w("orderCode"))}</span><strong>${h(b.code)}</strong></p><p class="form-help">${h(w("orderReservedHow"))}</p><a class="button" href="${h(portalUrl)}/login?claim=${h(encodeURIComponent(b.code))}" target="_blank" rel="noopener">${h(w("orderClaim"))}</a>` : ""}</section>`;
      }
      const values = { Gift: giftWord(b.days, true), gift: giftWord(b.days), length: length(b.days), data: b.planName || "", phone: b.phone || "", days: b.days,
        day: day(b.status === "active" ? b.endsAt : b.startBy || b.endsAt || Date.now()) };
      const key = { given: "orderGiven", reserved: "orderReservedStart", active: "orderRunning", expired: "orderExpiredUnstarted", cancelled: "orderCancelled",
        not_given: "orderCancelled", ended: "orderEndedRefund", needs_review: "orderReview" }[b.status] || "orderCollect";
      return `<section class="promo-order" aria-label="${h(values.Gift)}"><p>${h(w(key, values))}</p>${b.status === "reserved" && b.code
        ? `<p class="promo-order__code"><span>${h(w("orderCode"))}</span><strong>${h(b.code)}</strong></p><p class="form-help">${h(w("orderReservedStartHow"))}</p><a class="button" href="${h(portalUrl)}/login?claim=${h(encodeURIComponent(b.code))}" target="_blank" rel="noopener">${h(w("orderClaimGift", values))}</a>`
        : b.status === "given" ? `<a class="button" href="${h(portalUrl)}/dashboard#home" target="_blank" rel="noopener">${h(w("orderOpenPortal"))}</a>` : ""}</section>`;
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
