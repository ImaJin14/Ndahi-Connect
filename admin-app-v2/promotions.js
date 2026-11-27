// Promotions (#302, #345; canvas: AdminPromotions) at #promotions, owner and
// operator. Two tabs in the page head, as drawn:
//   Set up         the offer (one name, one product, the sale price and the
//                  crossed-out regular price), the free bundle (an Unlimited
//                  catalogue bundle, must be started within, given at
//                  collection or at payment), when and how many (start, end,
//                  units at this price, per customer, terms in English and
//                  French); Schedule promotion or Save as draft; the preview
//   While it runs  the offer with End early, the drawn figures and its orders
// All promotions closes both; a promotion's name opens it, and "New
// promotion" starts one (owner decisions, 27 Nov). Every number comes from
// /api/admin/store; the server checks every save.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { maskPhone } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB"), ZONE = "Africa/Douala";
const fcfa = (n) => `${Number(n || 0).toLocaleString(locale())} FCFA`;
// A product photo: a path on the API, or an older photo's data URL.
const photoSrc = (image) => (image?.src?.startsWith("/") ? String(window.NDAHI_CONFIG.apiUrl).replace(/\/$/, "") + image.src : image?.src || "");
const day = (at) => new Date(at).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
const shortDay = (at) => new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE });
const clock = (at) => new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: ZONE });
// datetime-local values are Douala time (UTC+1, no daylight saving).
const localInput = (at) => new Date(Date.parse(at) + 3600000).toISOString().slice(0, 16);
const fromLocal = (value) => new Date(Date.parse(value + ":00Z") - 3600000).toISOString();
const name = (value) => (value && typeof value === "object" ? value[currentLanguage()] || value.en : value) || "";
const left = (ms) => {
  const hours = Math.max(0, Math.floor(ms / 3600000)), days = Math.floor(hours / 24);
  return days ? L("adminPromoDaysHours", { days, hours: hours % 24 }) : L("adminPromoHours", { hours });
};
// "Amina N.", as drawn.
const shortName = (value) => { const parts = String(value || "").trim().split(/\s+/).filter(Boolean); return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : parts[0] || ""; };
const PILL = { live: "admin-promo__pill--live", scheduled: "admin-promo__pill--scheduled", draft: "admin-promo__pill--draft", ended: "admin-promo__pill--quiet" };
// The free bundle's length in words: "1 month" for 30 days, else its days.
const months = (days) => (days > 0 && days % 30 === 0 ? days / 30 : 0);
const length = (days) => { const m = months(days); return m === 1 ? L("adminPromoMonth") : m ? L("adminPromoMonths", { count: m }) : L("adminPromoDays", { days }); };
const freeWord = (days) => L(months(days) === 1 ? "adminPromoFreeOne" : "adminPromoFreeMany");
// How long the customer has to start it, and how many each number may buy ("No limit" is the server's most, 10).
const START_WITHIN = [30, 60, 90], PER_NUMBER = [1, 2, 10];
const days = (hours) => Math.round((hours || 0) / 24);
// The Bundle select: "[PLAN 4] · Unlimited · 30 days · 1 device", or a Home WISP bundle with no device count.
const bundleLabel = (b) => {
  const d = days(b.validityHours), span = d === 1 ? L("adminPromoOneDay") : L("adminPromoDays", { days: d });
  return b.accessType === "personal_unlimited"
    ? [name(b.name), L("adminPromoUnlimited"), span, b.deviceSlots === 1 ? L("adminPromoOneDevice") : L("adminPromoDevices", { count: b.deviceSlots })].join(" · ")
    : [name(b.name), span].join(" · ");
};

export async function showPromotions(host, context) {
  host.innerHTML = `<p class="nd-meta">${h(L("adminLoading"))}</p>`;
  let store, plans;
  // Plans name the free bundle of promotions saved before #345.
  try { [store, plans] = await Promise.all([context.call("/api/admin/store"), context.call("/api/plans").then((r) => r.plans || []).catch(() => [])]); }
  catch (error) { host.innerHTML = `<p class="nd-callout nd-callout--warning" role="status">${h(error.message)}</p>`; return; }
  const promotions = store.promotions || [];
  const newest = [...promotions].sort((a, b) => Date.parse(b.createdAt || 0) - Date.parse(a.createdAt || 0));
  const selected = context.selectedId === "new" ? null
    : promotions.find((p) => p.id === context.selectedId) || promotions.find((p) => p.status === "live") || promotions.find((p) => p.status === "scheduled") || newest.find((p) => p.status === "draft") || null;
  const tab = context.tab || "edit";
  render(host, { store, plans, promotions, selected, loadedAt: Date.now(), tab }, context);
}

// The free bundle as the catalogue describes it: an Unlimited bundle (#345) or an earlier plan.
function bonusOf(data, bonus) {
  if (!bonus) return null;
  const b = bonus.bundleId ? (data.store.promotionBundles || []).find((x) => x.id === bonus.bundleId) : null;
  if (b) return { name: name(b.name), days: days(b.validityHours) };
  const plan = data.plans.find((x) => x.id === bonus.planId);
  return { name: plan?.name || "", days: days(bonus.validityHours) };
}

function render(host, data, context) {
  const { store, promotions, selected: p, tab } = data, products = store.products || [];
  // The server's time now, whatever the browser's clock says.
  const now = Date.now() + (Date.parse(store.serverTime) - (data.loadedAt || Date.now()) || 0);
  const draft = context.draft || formValues(p, store);
  const product = products.find((x) => x.id === draft.productId);
  const bundles = store.promotionBundles || [], bundle = bundles.find((x) => x.id === draft.bundleId);
  const legacyBonus = p?.bonus && !p.bonus.bundleId ? bonusOf(data, p.bonus) : null;
  const stock = product?.available || 0;
  renderTabs(host, data, context);
  const check = (field, on, label, hint) => `<label class="admin-promo__check"><input type="checkbox" name="${field}"${on ? " checked" : ""}><span><strong>${h(label)}</strong>${hint ? `<span class="admin-promo__hint admin-promo__hint--block">${h(hint)}</span>` : ""}</span></label>`;
  const form = `<form class="admin-promo__form" id="promoForm" novalidate>
    <section class="nd-panel admin-promo__panel" aria-labelledby="promoOfferTitle"><h2 class="admin-promo__h2" id="promoOfferTitle">${h(L("adminPromoOffer"))}</h2>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoName">${h(L("adminPromoName"))}</label><input class="admin-promo__in" id="promoName" name="name" value="${h(draft.name)}" maxlength="120" required></div>
        <div><label class="admin-promo__label" for="promoProduct">${h(L("adminPromoProduct"))}</label><select class="admin-promo__in" id="promoProduct" name="productId">${products.length
          ? `${product ? "" : `<option value="">${h(L("adminPromoChooseProduct"))}</option>`}${products.filter((x) => x.status !== "archived" || x.id === draft.productId).map((x) => `<option value="${h(x.id)}"${x.id === draft.productId ? " selected" : ""}>${h(name(x.name))}</option>`).join("")}`
          : `<option value="">${h(L("adminPromoNoProducts"))}</option>`}</select></div></div>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoPrice">${h(L("adminPromoSalePrice"))}</label><input class="admin-promo__in" id="promoPrice" name="salePrice" inputmode="numeric" value="${h(draft.salePrice)}" required>
        ${product && Number.isSafeInteger(product.price) ? `<p class="admin-promo__hint">${h(L("adminPromoRegular", { price: fcfa(product.price) }))}</p>` : ""}</div>
        <div class="admin-promo__was">${check("showWas", draft.showWas, L("adminPromoShowWas"), L("adminPromoShowWasHint"))}</div></div>
    </section>
    <section class="nd-panel admin-promo__panel" aria-labelledby="promoBonusTitle"><h2 class="admin-promo__h2" id="promoBonusTitle">${h(L("adminPromoBonus"))}</h2>
      <label class="admin-promo__check admin-promo__check--strong"><input type="checkbox" name="hasBonus"${draft.hasBonus ? " checked" : ""}>${h(L("adminPromoIncludeBonus"))}</label>
      <div class="admin-promo__bonus"${draft.hasBonus ? "" : " hidden"} data-bonus-fields>
        <div class="admin-promo__grid">
          <div><label class="admin-promo__label" for="promoBundle">${h(L("adminPromoBundle"))}</label><select class="admin-promo__in" id="promoBundle" name="bundleId">${legacyBonus && !draft.bundleId ? `<option value="" selected>${h(legacyBonus.name)}</option>` : ""}${bundles.map((x) => `<option value="${h(x.id)}"${x.id === draft.bundleId ? " selected" : ""}>${h(bundleLabel(x))}</option>`).join("")}</select></div>
          <div><label class="admin-promo__label" for="promoWithin">${h(L("adminPromoStartWithin"))}</label><select class="admin-promo__in" id="promoWithin" name="within">${START_WITHIN.map((n) => `<option value="${n}"${n === draft.within ? " selected" : ""}>${h(L("adminPromoDays", { days: n }))}</option>`).join("")}</select>
            <p class="admin-promo__hint">${h(L("adminPromoStartWithinHint", { days: bundle ? days(bundle.validityHours) : legacyBonus?.days || 30, data: L("adminPromoUnlimited") }))}</p></div>
        </div>
        <fieldset class="admin-promo__when"><legend class="admin-promo__label">${h(L("adminPromoGiveIt"))}</legend>
          ${[["collection", "adminPromoGiveCollection", "adminPromoGiveCollectionHint"], ["payment", "adminPromoGivePayment", "adminPromoGivePaymentHint"]].map(([id, label, hint]) =>
            `<label class="admin-promo__radio"><input type="radio" name="givenAt" value="${id}"${draft.givenAt === id ? " checked" : ""}><span><strong>${h(L(label))}</strong><span>${h(L(hint))}</span></span></label>`).join("")}
        </fieldset>
        <p class="admin-promo__note">${h(L("adminPromoBonusNote"))}</p>
      </div>
    </section>
    <section class="nd-panel admin-promo__panel" aria-labelledby="promoWhenTitle"><h2 class="admin-promo__h2" id="promoWhenTitle">${h(L("adminPromoWhen"))}</h2>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoStart">${h(L("adminPromoStarts"))}</label><input class="admin-promo__in" id="promoStart" name="startsAt" type="datetime-local" value="${h(draft.startsAt)}" required></div>
        <div><label class="admin-promo__label" for="promoEnd">${h(L("adminPromoEnds"))}</label><input class="admin-promo__in" id="promoEnd" name="endsAt" type="datetime-local" value="${h(draft.endsAt)}" required></div>
        <div><label class="admin-promo__label" for="promoUnits">${h(L("adminPromoUnits"))}</label><input class="admin-promo__in" id="promoUnits" name="units" type="number" min="1" step="1" inputmode="numeric" value="${h(draft.units)}">
          <p class="admin-promo__hint">${h(L("adminPromoUnitsHint", { count: stock }))}</p></div>
        <div><label class="admin-promo__label" for="promoLimit">${h(L("adminPromoPerCustomer"))}</label><select class="admin-promo__in" id="promoLimit" name="perNumberLimit">${PER_NUMBER.map((n) => `<option value="${n}"${n === draft.perNumberLimit ? " selected" : ""}>${h(n === 10 ? L("adminPromoNoLimit") : L("adminPromoPerNumber", { count: n }))}</option>`).join("")}</select></div></div>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoTermsEn">${h(L("adminPromoTermsEn"))}</label><textarea class="admin-promo__in" id="promoTermsEn" name="termsEn" maxlength="4000" required>${h(draft.termsEn)}</textarea></div>
        <div><label class="admin-promo__label" for="promoTermsFr">${h(L("adminPromoTermsFr"))}</label><textarea class="admin-promo__in" id="promoTermsFr" name="termsFr" maxlength="4000" required>${h(draft.termsFr)}</textarea></div></div>
    </section>
    <div class="admin-promo__buttons"><button type="submit" class="admin-promo__go" value="schedule">${h(L(p && ["live", "scheduled"].includes(p.status) ? "adminPromoSaveChanges" : "adminPromoScheduleDrawn"))}</button>
      <button type="submit" class="admin-promo__go2" value="draft">${h(L("adminPromoSaveDraft"))}</button>
      <button type="button" class="admin-promo__go2" data-promo-new>${h(L("adminPromoNew"))}</button>
      <span class="admin-promo__message" role="status" aria-live="polite">${h(context.notice || "")}</span></div>
  </form>`;
  // The crossed-out price shows only if ticked AND it really sold at it (#345).
  const was = draft.showWas && product?.soldAtRegular30d && Number.isSafeInteger(product.price);
  const at = draft.units ? Math.min(Number(draft.units), stock) : stock;
  const preview = `<aside class="admin-promo__aside" aria-labelledby="promoPreviewTitle"><h2 class="admin-promo__aside-title" id="promoPreviewTitle">${h(L("adminPromoPreview"))}</h2>
    <div class="admin-promo__card"><div class="admin-promo__photo">${photoSrc(product?.images?.[0]) ? `<img src="${h(photoSrc(product.images[0]))}" alt="">` : `<span>${h(L("adminPromoPhoto"))}</span>`}<span class="admin-promo__badge">${h(draft.name || L("adminPromoOffer"))}</span></div>
      <div class="admin-promo__card-body"><strong class="admin-promo__card-name">${h(product ? name(product.name) : L("adminPromoChooseProduct"))}</strong>
        <p class="admin-promo__card-price"><strong>${h(fcfa(draft.salePrice))}</strong>${was ? `<s>${h(fcfa(product.price).replace(" FCFA", ""))}</s>` : ""}</p>
        ${draft.hasBonus && (bundle || legacyBonus) ? `<p class="admin-promo__card-bonus">${h(L("adminPromoCardBonus", { length: length(bundle ? days(bundle.validityHours) : legacyBonus.days), data: L("adminPromoUnlimited"), free: freeWord(bundle ? days(bundle.validityHours) : legacyBonus.days) }))}</p>` : ""}
        ${draft.endsAt ? `<p class="admin-promo__card-ends">${h(L("adminPromoCardEnds", { day: day(fromLocal(draft.endsAt)), count: at }))}</p>` : ""}</div></div>
    <p class="admin-promo__hint">${h(L("adminPromoPreviewHint"))}</p></aside>`;
  const all = promotions.length ? `<section class="nd-panel admin-promo__panel admin-promo__panel--table" aria-labelledby="promoAllTitle"><h2 class="admin-promo__h2" id="promoAllTitle">${h(L("adminPromoAll"))}</h2>
    <div class="admin-promo__table"><table><thead><tr><th scope="col">${h(L("adminPromoColName"))}</th><th scope="col">${h(L("adminPromoColOffer"))}</th><th scope="col">${h(L("adminPromoColWhen"))}</th><th scope="col">${h(L("adminPromoColSold"))}</th><th scope="col">${h(L("adminPromoColStatus"))}</th></tr></thead><tbody>
      ${promotions.map((x) => `<tr${x.id === p?.id ? ' aria-current="true"' : ""}><td><button type="button" class="admin-promo__name" data-promo-open="${h(x.id)}">${h(name(x.name))}</button></td><td>${h(tableOffer(data, x))}</td><td>${h(`${shortDay(x.startsAt)} – ${shortDay(x.endedEarlyAt || x.endsAt)}`)}</td>
        <td>${h(sold(x))}</td><td><span class="admin-promo__pill ${PILL[x.status]}">${h(statusText(x))}</span></td></tr>`).join("")}</tbody></table></div></section>` : "";
  const body = tab === "live" && p ? `${context.notice ? `<p class="admin-promo__message" role="status">${h(context.notice)}</p>` : ""}${liveView(data, p, now)}` : `<div class="admin-promo__layout">${form}${preview}</div>`;
  host.innerHTML = `<div class="admin-promo">${body}${all}</div>`;
  bind(host, data, context);
}

// The head's tabs: Set up and While it runs (only once there is an offer to watch).
function renderTabs(host, data, context) {
  const tabs = document.getElementById("promotionsTabs");
  if (!tabs) return;
  tabs.innerHTML = `<div class="admin-kits__tabs" role="tablist" aria-label="${h(L("adminPromoView"))}">${[["edit", "adminPromoTabSetUp"], ["live", "adminPromoTabLive"]].map(([id, key]) =>
    `<button type="button" role="tab" class="admin-kits__tab" data-promo-tab="${id}" aria-selected="${data.tab === id}" tabindex="${data.tab === id ? 0 : -1}"${id === "live" && !data.selected ? " disabled" : ""}>${h(L(key))}</button>`).join("")}</div>`;
  tabs.querySelectorAll("[data-promo-tab]").forEach((b) => (b.onclick = () => {
    data.tab = b.dataset.promoTab;
    render(host, data, { ...context, draft: undefined, notice: "" });
    tabs.querySelector(`[data-promo-tab="${data.tab}"]`)?.focus();
  }));
}

const what = (data, p) => {
  const product = (data.store.products || []).find((x) => x.id === p.productIds[0]);
  const label = product ? product.sku || name(product.name) : "—";
  return p.productIds.length > 1 ? L("adminPromoProductsCount", { count: p.productIds.length }) : label;
};
// "AX1500 for 100,000 FCFA + 1 month Unlimited free" on the live card.
function liveLine(data, p) {
  const offer = L("adminPromoSummary", { what: what(data, p), price: fcfa(p.salePrice) }), b = bonusOf(data, p.bonus);
  return b ? `${offer} ${L("adminPromoSummaryBonus", { length: length(b.days), plan: L("adminPromoUnlimited"), free: freeWord(b.days) })}` : offer;
}
// "AX1500 · 100,000 FCFA + [PLAN 4] free" in All promotions.
function tableOffer(data, p) {
  const offer = `${what(data, p)} · ${fcfa(p.salePrice)}`, b = bonusOf(data, p.bonus);
  return b ? `${offer} ${L("adminPromoTableBonus", { plan: b.name })}` : offer;
}
const sold = (p) => (p.figures.units ? `${p.figures.unitsSold} / ${p.figures.units}` : String(p.figures.unitsSold));
const statusText = (p) => (p.status === "scheduled" ? L("adminPromoScheduledOn", { day: shortDay(p.startsAt) }) : L(`adminPromoStatus_${p.status}`));

// While it runs (canvas: view = live): the offer and End early, the figures and its orders.
function liveView(data, p, now) {
  const f = p.figures, running = ["live", "scheduled"].includes(p.status);
  const pill = p.status === "live" ? L("adminPromoLiveEnds", { left: left(Date.parse(p.endedEarlyAt || p.endsAt) - now) })
    : p.status === "scheduled" ? L("adminPromoScheduledStarts", { day: day(p.startsAt), time: clock(p.startsAt) }) : L(`adminPromoStatus_${p.status}`);
  return `<section class="nd-panel admin-promo__live" aria-label="${h(name(p.name))}"><span class="admin-promo__badge">${h(name(p.name))}</span>
      <strong class="admin-promo__live-line">${h(liveLine(data, p))}</strong>
      <span class="admin-promo__pill ${PILL[p.status]}">${h(pill)}</span>
      ${running ? `<button type="button" class="admin-promo__end" data-promo-end="${h(p.id)}">${h(L("adminPromoEndEarly"))}</button>` : ""}</section>
    <div class="admin-promo__metrics">${[[sold(p), "adminPromoUnitsSold"], [fcfa(f.revenue), "adminPromoRevenue"], [f.freeGiven ?? 0, "adminPromoFreeGiven"],
      [f.freeStarted ?? 0, "adminPromoFreeStarted"], [f.newCustomers ?? 0, "adminPromoNewCustomers"]]
      .map(([value, key]) => `<div class="nd-panel admin-promo__metric"><b>${h(value)}</b><span>${h(L(key))}</span></div>`).join("")}</div>
    <section class="nd-panel admin-promo__panel admin-promo__panel--table" aria-labelledby="promoOrdersTitle"><h2 class="admin-promo__h2" id="promoOrdersTitle">${h(L("adminPromoOrders"))}</h2>
      ${p.orders.length ? `<div class="admin-promo__table"><table><thead><tr><th scope="col">${h(L("adminPromoColOrder"))}</th><th scope="col">${h(L("adminPromoColBuyer"))}</th><th scope="col">${h(L("adminPromoColOrderStatus"))}</th><th scope="col">${h(L("adminPromoColFreeMonth"))}</th></tr></thead><tbody>
        ${[...p.orders].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)).map((o) => `<tr><td><a href="/dashboard#store/${encodeURIComponent(o.id)}">${h(o.reference)}</a></td><td>${h(o.account && o.name ? shortName(o.name) : L("adminPromoBuyerGuest", { phone: o.payer }))}</td>
          <td>${orderPill(o)}</td><td>${bonusPill(o)}</td></tr>`).join("")}</tbody></table></div>`
        : `<p class="admin-promo__hint">${h(L("adminPromoNoOrders"))}</p>`}</section>`;
}
// An order's state as drawn: collected grey, ready blue, refunded red.
function orderPill(o) {
  const refunded = o.refundStatus && o.refundStatus !== "failed";
  const key = refunded ? "adminPromoOrder_refunded" : `adminPromoOrder_${o.status}`, text = L(key);
  const tone = refunded ? "danger" : o.status === "ready" ? "scheduled" : o.status === "collected" ? "quiet" : o.status === "review" ? "danger" : "draft";
  return `<span class="admin-promo__pill admin-promo__pill--${tone}">${h(text === key ? String(o.status).replaceAll("_", " ") : text)}</span>`;
}
// The free month as drawn: started, waiting for claim, given at collection, cancelled · never given.
function bonusPill(o) {
  const started = o.bonusStartedAt || (o.bonus === "active" && o.bonusRule !== "payment_confirmation");
  if (started && o.bonusStartedAt) return `<span class="admin-promo__pill admin-promo__pill--live">${h(L("adminPromoBonusStarted", { day: shortDay(o.bonusStartedAt) }))}</span>`;
  if (o.bonus === "active") return `<span class="admin-promo__pill admin-promo__pill--live">${h(o.bonusEndsAt ? L("adminPromoBonus_activeUntil", { day: shortDay(o.bonusEndsAt) }) : L("adminPromoBonus_active"))}</span>`;
  if (o.bonus === "reserved") return `<span class="admin-promo__pill admin-promo__pill--waiting">${h(L("adminPromoBonus_reserved"))}</span>`;
  if (o.bonus === "pending") return `<span class="admin-promo__pill admin-promo__pill--draft">${h(L(o.bonusGivenAt === "payment" || o.bonusRule === "payment_confirmation" ? "adminPromoBonus_pendingPaid" : "adminPromoBonus_pending"))}</span>`;
  if (o.bonus === "given") return `<span class="admin-promo__pill admin-promo__pill--waiting">${h(L("adminPromoBonus_given", { day: shortDay(o.bonusStartBy) }))}</span>`;
  if (["cancelled", "not_given"].includes(o.bonus)) return `<span class="admin-promo__pill admin-promo__pill--quiet">${h(L("adminPromoBonusNeverGiven"))}</span>`;
  if (o.bonus === "expired" && o.bonusRule !== "payment_confirmation") return `<span class="admin-promo__pill admin-promo__pill--quiet">${h(L("adminPromoBonus_expiredUnstarted"))}</span>`;
  return `<span class="admin-promo__pill ${o.bonus === "needs_review" || o.bonus === "ended" ? "admin-promo__pill--danger" : "admin-promo__pill--quiet"}">${h(L(`adminPromoBonus_${o.bonus}`))}</span>`;
}

function formValues(p, store) {
  const bundles = store.promotionBundles || [];
  // A month of Personal Unlimited for one device, else the first Unlimited bundle.
  const fallback = bundles.find((b) => b.accessType === "personal_unlimited" && days(b.validityHours) === 30 && b.deviceSlots === 1) || bundles[0];
  if (!p) return { name: "", productId: "", salePrice: "", showWas: false, hasBonus: true, bundleId: fallback?.id || "", within: 60, givenAt: "collection",
    startsAt: "", endsAt: "", units: "", perNumberLimit: 1, termsEn: "", termsFr: "" };
  return { name: name(p.name), productId: p.productIds[0] || "", salePrice: p.salePrice, showWas: p.showWas === true, hasBonus: Boolean(p.bonus),
    bundleId: p.bonus ? p.bonus.bundleId || "" : fallback?.id || "", within: START_WITHIN.includes(p.bonus?.startWithinDays) ? p.bonus.startWithinDays : 60,
    givenAt: p.bonus?.givenAt === "payment" ? "payment" : "collection", startsAt: localInput(p.startsAt), endsAt: localInput(p.endsAt),
    units: p.units ?? "", perNumberLimit: PER_NUMBER.includes(p.perNumberLimit) ? p.perNumberLimit : p.perNumberLimit > 2 ? 10 : 1, termsEn: p.terms.en, termsFr: p.terms.fr };
}

function read(form) {
  const f = form.elements;
  return { name: f.name.value.trim(), productId: f.productId.value, salePrice: f.salePrice.value.trim() === "" ? "" : Number(f.salePrice.value), showWas: f.showWas.checked,
    hasBonus: f.hasBonus.checked, bundleId: f.bundleId?.value || "", within: Number(f.within?.value || 60), givenAt: form.querySelector("input[name=givenAt]:checked")?.value || "collection",
    startsAt: f.startsAt.value, endsAt: f.endsAt.value, units: f.units.value.trim(), perNumberLimit: Number(f.perNumberLimit.value),
    termsEn: f.termsEn.value.trim(), termsFr: f.termsFr.value.trim() };
}

function bind(host, data, context) {
  const p = data.selected;
  host.querySelectorAll("[data-promo-open]").forEach((button) => button.addEventListener("click", () => {
    const chosen = data.promotions.find((x) => x.id === button.dataset.promoOpen);
    void showPromotions(host, { ...context, selectedId: chosen.id, tab: ["live", "ended"].includes(chosen.status) ? "live" : "edit", notice: "" })
      .then(() => document.querySelector("[data-promo-tab][aria-selected=true]")?.focus());
  }));
  host.querySelector("[data-promo-end]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!window.confirm(L("adminPromoEndConfirm"))) return;
    button.disabled = true;
    try {
      await context.call("/api/admin/store/promotions/end", { method: "POST", body: JSON.stringify({ id: button.dataset.promoEnd }) });
      await showPromotions(host, { ...context, selectedId: button.dataset.promoEnd, tab: "live", notice: L("adminPromoEnded") });
    } catch (error) { button.disabled = false; window.alert(error.message); }
  });
  const form = host.querySelector("#promoForm");
  if (!form) return;
  const message = form.querySelector(".admin-promo__message");
  // The preview and the stock follow the form as it is filled in.
  form.oninput = (event) => {
    if (event.target.matches("textarea")) return;
    const focusId = document.activeElement?.id, draft = read(form);
    render(host, data, { ...context, draft, notice: "" });
    if (focusId) host.querySelector("#" + CSS.escape(focusId))?.focus();
  };
  form.onsubmit = async (event) => {
    event.preventDefault();
    const draft = read(form), enabled = event.submitter?.value !== "draft";
    if (!draft.startsAt || !draft.endsAt) { message.textContent = L("adminPromoNeedDates"); return; }
    const buttons = form.querySelectorAll("button");
    buttons.forEach((b) => { b.disabled = true; });
    try {
      // One name for both languages (owner, 27 Nov, #345).
      const legacy = p?.bonus && !p.bonus.bundleId && !draft.bundleId ? p.bonus : null;
      const result = await context.call("/api/admin/store/promotions/save", { method: "POST", body: JSON.stringify({
        ...(p ? { id: p.id, version: p.version } : {}), enabled, name: { en: draft.name, fr: draft.name }, terms: { en: draft.termsEn, fr: draft.termsFr },
        productIds: draft.productId ? [draft.productId] : [], salePrice: draft.salePrice, perNumberLimit: draft.perNumberLimit, showWas: draft.showWas,
        units: draft.units === "" ? null : Number(draft.units), startsAt: fromLocal(draft.startsAt), endsAt: fromLocal(draft.endsAt),
        bonus: !draft.hasBonus ? null : legacy ? { ...legacy, startWithinDays: draft.within } : { bundleId: draft.bundleId, givenAt: draft.givenAt, startWithinDays: draft.within } }) });
      const saved = (result.promotions || []).find((x) => name(x.name) === draft.name && x.startsAt === fromLocal(draft.startsAt)) || null;
      await showPromotions(host, { ...context, selectedId: saved?.id || p?.id, tab: "edit",
        notice: !enabled ? L("adminPromoDraftSaved") : saved?.status === "scheduled" ? L("adminPromoScheduledLine", { day: day(saved.startsAt), time: clock(saved.startsAt) }) : L("adminPromoScheduled") });
    } catch (error) {
      message.textContent = error.message;
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  host.querySelector("[data-promo-new]")?.addEventListener("click", () => void showPromotions(host, { ...context, selectedId: "new", tab: "edit", notice: "" }).then(() => host.querySelector("#promoName")?.focus()));
}
