// Promotions (#302, canvas: AdminPromotions) at #promotions, owner and
// operator. Set up an offer (products, sale price, one per number, a free
// bundle and its length, the window, terms in English and French) with a
// preview of what customers see; then, while it runs, its figures, its orders
// with each free bundle's status, and End early. Black Friday rules (owner,
// 20 Nov): the free bundle's days start when the payment is confirmed, so the
// design's "must be started within" and "give it at collection" choices are
// replaced by how long it lasts. Every number comes from /api/admin/store.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

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
const name = (value) => (value && (value[currentLanguage()] || value.en)) || "";
const left = (ms) => {
  const hours = Math.max(0, Math.floor(ms / 3600000)), days = Math.floor(hours / 24);
  return days ? L("adminPromoDaysHours", { days, hours: hours % 24 }) : L("adminPromoHours", { hours });
};
const PILL = { live: "admin-promo__pill--live", scheduled: "admin-promo__pill--scheduled", draft: "admin-promo__pill--quiet", ended: "admin-promo__pill--quiet" };
const BONUS_PILL = { active: "admin-promo__pill--live", reserved: "admin-promo__pill--waiting", pending: "admin-promo__pill--quiet",
  ended: "admin-promo__pill--danger", not_given: "admin-promo__pill--quiet", expired: "admin-promo__pill--quiet", needs_review: "admin-promo__pill--danger" };

export async function showPromotions(host, context) {
  host.innerHTML = `<p class="nd-meta">${h(L("adminLoading"))}</p>`;
  let store, plans;
  try { [store, plans] = await Promise.all([context.call("/api/admin/store"), context.call("/api/plans").then((r) => r.plans || []).catch(() => [])]); }
  catch (error) { host.innerHTML = `<p class="nd-callout nd-callout--warning" role="status">${h(error.message)}</p>`; return; }
  const promotions = store.promotions || [];
  const selected = context.selectedId === "new" ? null
    : promotions.find((p) => p.id === context.selectedId) || promotions.find((p) => p.status === "live") || promotions.find((p) => p.status === "scheduled") || null;
  render(host, { store, plans, promotions, selected, loadedAt: Date.now() }, context);
}

function planLabel(p) {
  const data = p.quotaGb == null ? L("adminPromoUnlimited") : `${p.quotaGb} GB`;
  const days = Math.round(p.validityHours / 24);
  return [p.name, data, days === 1 ? L("adminPromoOneDay") : L("adminPromoDays", { days }), p.fairUse ? L("adminPromoFairUse") : ""].filter(Boolean).join(" · ");
}

function render(host, data, context) {
  const { store, plans, promotions, selected: p } = data, products = store.products || [];
  // The server's time now, whatever the browser's clock says.
  const now = Date.now() + (Date.parse(store.serverTime) - (data.loadedAt || Date.now()) || 0);
  const draft = context.draft || formValues(p, plans);
  const productOf = (id) => products.find((x) => x.id === id);
  const stock = draft.productIds.reduce((n, id) => n + (productOf(id)?.available || 0), 0);
  const firstProduct = productOf(draft.productIds[0]);
  const plan = plans.find((x) => x.id === draft.planId);
  const form = `<form class="admin-promo__form" id="promoForm" novalidate>
    <section class="nd-panel admin-promo__panel" aria-labelledby="promoOfferTitle"><h2 class="admin-promo__h2" id="promoOfferTitle">${h(L("adminPromoOffer"))}</h2>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoNameEn">${h(L("adminPromoNameEn"))}</label><input class="admin-promo__in" id="promoNameEn" name="nameEn" value="${h(draft.nameEn)}" maxlength="120" required></div>
        <div><label class="admin-promo__label" for="promoNameFr">${h(L("adminPromoNameFr"))}</label><input class="admin-promo__in" id="promoNameFr" name="nameFr" value="${h(draft.nameFr)}" maxlength="120" required></div></div>
      <fieldset class="admin-promo__products"><legend class="admin-promo__label">${h(L("adminPromoProducts"))}</legend>
        ${products.length ? products.map((x) => `<label class="admin-promo__check"><input type="checkbox" name="productIds" value="${h(x.id)}"${draft.productIds.includes(x.id) ? " checked" : ""}><span>${h(name(x.name))} <span class="admin-promo__muted">· ${h(x.sku)} · ${h(L("adminPromoInStock", { count: x.available ?? 0 }))}</span></span></label>`).join("") : `<p class="admin-promo__hint">${h(L("adminPromoNoProducts"))}</p>`}
        <p class="admin-promo__hint">${h(L("adminPromoProductsHint"))}</p></fieldset>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoPrice">${h(L("adminPromoSalePrice"))}</label><input class="admin-promo__in" id="promoPrice" name="salePrice" type="number" min="1" step="1" inputmode="numeric" value="${h(draft.salePrice)}" required>
        ${firstProduct && Number.isSafeInteger(firstProduct.price) ? `<p class="admin-promo__hint">${h(L("adminPromoRegular", { price: fcfa(firstProduct.price) }))}</p>` : ""}</div></div>
    </section>
    <section class="nd-panel admin-promo__panel" aria-labelledby="promoBonusTitle"><h2 class="admin-promo__h2" id="promoBonusTitle">${h(L("adminPromoBonus"))}</h2>
      <label class="admin-promo__check admin-promo__check--strong"><input type="checkbox" name="hasBonus"${draft.hasBonus ? " checked" : ""}>${h(L("adminPromoIncludeBonus"))}</label>
      <div class="admin-promo__grid"${draft.hasBonus ? "" : " hidden"} data-bonus-fields>
        <div><label class="admin-promo__label" for="promoPlan">${h(L("adminPromoBundle"))}</label><select class="admin-promo__in" id="promoPlan" name="planId">${plans.map((x) => `<option value="${h(x.id)}"${x.id === draft.planId ? " selected" : ""}>${h(planLabel(x))}</option>`).join("")}</select></div>
        <div><label class="admin-promo__label" for="promoDays">${h(L("adminPromoLasts"))}</label><input class="admin-promo__in" id="promoDays" name="days" type="number" min="1" max="365" step="1" inputmode="numeric" value="${h(draft.days)}">
          <p class="admin-promo__hint">${h(L("adminPromoLastsHint"))}</p></div></div>
      <p class="admin-promo__note"${draft.hasBonus ? "" : " hidden"} data-bonus-fields>${h(L("adminPromoBonusNote"))}</p>
    </section>
    <section class="nd-panel admin-promo__panel" aria-labelledby="promoWhenTitle"><h2 class="admin-promo__h2" id="promoWhenTitle">${h(L("adminPromoWhen"))}</h2>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoStart">${h(L("adminPromoStarts"))}</label><input class="admin-promo__in" id="promoStart" name="startsAt" type="datetime-local" value="${h(draft.startsAt)}" required></div>
        <div><label class="admin-promo__label" for="promoEnd">${h(L("adminPromoEnds"))}</label><input class="admin-promo__in" id="promoEnd" name="endsAt" type="datetime-local" value="${h(draft.endsAt)}" required></div>
        <div><label class="admin-promo__label" for="promoLimit">${h(L("adminPromoPerCustomer"))}</label><select class="admin-promo__in" id="promoLimit" name="perNumberLimit">${[1, 2, 3, 5].map((n) => `<option value="${n}"${n === draft.perNumberLimit ? " selected" : ""}>${h(L("adminPromoPerNumber", { count: n }))}</option>`).join("")}</select>
          <p class="admin-promo__hint">${h(L("adminPromoStockHint", { count: stock }))}</p></div></div>
      <div class="admin-promo__grid"><div><label class="admin-promo__label" for="promoTermsEn">${h(L("adminPromoTermsEn"))}</label><textarea class="admin-promo__in" id="promoTermsEn" name="termsEn" maxlength="4000" required>${h(draft.termsEn)}</textarea></div>
        <div><label class="admin-promo__label" for="promoTermsFr">${h(L("adminPromoTermsFr"))}</label><textarea class="admin-promo__in" id="promoTermsFr" name="termsFr" maxlength="4000" required>${h(draft.termsFr)}</textarea></div></div>
    </section>
    <div class="admin-promo__buttons"><button type="submit" class="admin-promo__go" value="schedule">${h(L(p?.enabled ? "adminPromoSaveChanges" : "adminPromoSchedule"))}</button>
      <button type="submit" class="admin-promo__go2" value="draft">${h(L("adminPromoSaveDraft"))}</button>
      ${p ? `<button type="button" class="admin-promo__go2" data-promo-new>${h(L("adminPromoNew"))}</button>` : ""}</div>
    <p class="admin-promo__message" role="status" aria-live="polite">${h(context.notice || "")}</p>
  </form>`;
  const preview = `<aside class="admin-promo__aside" aria-labelledby="promoPreviewTitle"><h2 class="admin-promo__aside-title" id="promoPreviewTitle">${h(L("adminPromoPreview"))}</h2>
    <div class="admin-promo__card"><div class="admin-promo__photo">${photoSrc(firstProduct?.images?.[0]) ? `<img src="${h(photoSrc(firstProduct.images[0]))}" alt="">` : `<span>${h(L("adminPromoPhoto"))}</span>`}<span class="admin-promo__badge">${h(draft.nameEn || L("adminPromoOffer"))}</span></div>
      <div class="admin-promo__card-body"><strong class="admin-promo__card-name">${h(firstProduct ? name(firstProduct.name) : L("adminPromoChooseProduct"))}</strong>
        <p class="admin-promo__card-price"><strong>${h(fcfa(draft.salePrice))}</strong></p>
        ${draft.hasBonus && plan ? `<p class="admin-promo__card-bonus">${h(L("adminPromoCardBonus", { days: draft.days, plan: plan.name }))}</p>` : ""}
        ${draft.endsAt ? `<p class="admin-promo__card-ends">${h(L("adminPromoCardEnds", { day: day(fromLocal(draft.endsAt)), count: stock }))}</p>` : ""}</div></div>
    <p class="admin-promo__hint">${h(L("adminPromoPreviewHint"))}</p></aside>`;
  const running = p && ["live", "scheduled"].includes(p.status) ? p : null;
  const live = running ? `<section class="nd-panel admin-promo__live" aria-label="${h(name(running.name))}"><span class="admin-promo__badge">${h(name(running.name))}</span>
      <strong class="admin-promo__live-line">${h(summary(running, products, plans))}</strong>
      <span class="admin-promo__pill ${PILL[running.status]}">${h(running.status === "live" ? L("adminPromoLiveEnds", { left: left(Date.parse(running.endedEarlyAt || running.endsAt) - now) }) : L("adminPromoScheduledStarts", { day: day(running.startsAt), time: clock(running.startsAt) }))}</span>
      <button type="button" class="admin-promo__end" data-promo-end="${h(running.id)}">${h(L("adminPromoEndEarly"))}</button></section>` : "";
  const figures = p ? `<div class="admin-promo__metrics">${[[p.figures.unitsSold, "adminPromoUnitsSold"], [fcfa(p.figures.revenue), "adminPromoRevenue"],
    [p.figures.bonusActive, "adminPromoBonusRunning"], [p.figures.bonusReserved, "adminPromoBonusWaiting"], [p.figures.bonusEnded, "adminPromoBonusEnded"]]
    .map(([value, key]) => `<div class="nd-panel admin-promo__metric"><b>${h(value)}</b><span>${h(L(key))}</span></div>`).join("")}</div>
    <section class="nd-panel admin-promo__panel" aria-labelledby="promoOrdersTitle"><h2 class="admin-promo__h2" id="promoOrdersTitle">${h(L("adminPromoOrders"))}</h2>
      ${p.orders.length ? `<div class="admin-promo__table"><table><thead><tr><th scope="col">${h(L("adminPromoColOrder"))}</th><th scope="col">${h(L("adminPromoColBuyer"))}</th><th scope="col">${h(L("adminPromoColStatus"))}</th><th scope="col">${h(L("adminPromoColBonus"))}</th></tr></thead><tbody>
        ${p.orders.map((o) => `<tr><td><a href="/dashboard#store">${h(o.reference)}</a></td><td>${h(o.account ? L("adminPromoBuyerAccount", { phone: o.payer }) : L("adminPromoBuyerGuest", { phone: o.payer }))}</td>
          <td><span class="admin-promo__pill admin-promo__pill--quiet">${h(orderStatus(o.status))}</span></td>
          <td><span class="admin-promo__pill ${BONUS_PILL[o.bonus] || "admin-promo__pill--quiet"}">${h(bonusText(o))}</span></td></tr>`).join("")}</tbody></table></div>`
        : `<p class="admin-promo__hint">${h(L("adminPromoNoOrders"))}</p>`}</section>` : "";
  const all = promotions.length ? `<section class="nd-panel admin-promo__panel" aria-labelledby="promoAllTitle"><h2 class="admin-promo__h2" id="promoAllTitle">${h(L("adminPromoAll"))}</h2>
    <div class="admin-promo__table"><table><thead><tr><th scope="col">${h(L("adminPromoColName"))}</th><th scope="col">${h(L("adminPromoColOffer"))}</th><th scope="col">${h(L("adminPromoColWhen"))}</th><th scope="col">${h(L("adminPromoColSold"))}</th><th scope="col">${h(L("adminPromoColStatus"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminPromoColEdit"))}</span></th></tr></thead><tbody>
      ${promotions.map((x) => `<tr${x.id === p?.id ? ' aria-current="true"' : ""}><td><strong>${h(name(x.name))}</strong></td><td>${h(summary(x, products, plans))}</td><td>${h(`${shortDay(x.startsAt)} – ${shortDay(x.endedEarlyAt || x.endsAt)}`)}</td>
        <td>${h(x.figures.unitsSold)}</td><td><span class="admin-promo__pill ${PILL[x.status]}">${h(L(`adminPromoStatus_${x.status}`))}</span></td>
        <td><button type="button" class="admin-promo__link" data-promo-edit="${h(x.id)}">${h(L("adminPromoEdit"))}</button></td></tr>`).join("")}</tbody></table></div></section>` : "";
  host.innerHTML = `<div class="admin-promo"><div class="admin-promo__layout">${form}${preview}</div>${live}${figures}${all}</div>`;
  bind(host, data, context);
}

function summary(p, products, plans) {
  const names = p.productIds.map((id) => products.find((x) => x.id === id)).filter(Boolean).map((x) => name(x.name));
  const what = names.length > 1 ? L("adminPromoProductsCount", { count: names.length }) : names[0] || "—";
  const plan = p.bonus && plans.find((x) => x.id === p.bonus.planId);
  const offer = L("adminPromoSummary", { what, price: fcfa(p.salePrice) });
  return plan ? `${offer} ${L("adminPromoSummaryBonus", { days: Math.round(p.bonus.validityHours / 24), plan: plan.name })}` : offer;
}

// The order's status in words; an unknown one is shown as recorded.
function orderStatus(status) {
  const key = `adminPromoOrder_${status}`, text = L(key);
  return text === key ? String(status).replaceAll("_", " ") : text;
}

function bonusText(o) {
  if (o.bonus === "active" && o.bonusEndsAt) return L("adminPromoBonus_activeUntil", { day: shortDay(o.bonusEndsAt) });
  return L(`adminPromoBonus_${o.bonus}`);
}

function formValues(p, plans) {
  const unlimited = plans.find((x) => x.id === "unlimited") || plans[0];
  if (!p) return { nameEn: "", nameFr: "", productIds: [], salePrice: "", hasBonus: true, planId: unlimited?.id || "", days: 45,
    startsAt: "", endsAt: "", perNumberLimit: 1, termsEn: "", termsFr: "" };
  return { nameEn: p.name.en, nameFr: p.name.fr, productIds: [...p.productIds], salePrice: p.salePrice, hasBonus: Boolean(p.bonus),
    planId: p.bonus?.planId || unlimited?.id || "", days: p.bonus ? Math.round(p.bonus.validityHours / 24) : 45,
    startsAt: localInput(p.startsAt), endsAt: localInput(p.endsAt), perNumberLimit: p.perNumberLimit || 1, termsEn: p.terms.en, termsFr: p.terms.fr };
}

function read(form) {
  const f = form.elements;
  return { nameEn: f.nameEn.value.trim(), nameFr: f.nameFr.value.trim(), productIds: [...form.querySelectorAll("input[name=productIds]:checked")].map((x) => x.value),
    salePrice: f.salePrice.value === "" ? "" : Number(f.salePrice.value), hasBonus: f.hasBonus.checked, planId: f.planId?.value || "",
    days: Number(f.days?.value || 0), startsAt: f.startsAt.value, endsAt: f.endsAt.value, perNumberLimit: Number(f.perNumberLimit.value),
    termsEn: f.termsEn.value.trim(), termsFr: f.termsFr.value.trim() };
}

function bind(host, data, context) {
  const form = host.querySelector("#promoForm"), message = form.querySelector(".admin-promo__message"), p = data.selected;
  // The preview and stock follow the form as it is filled in.
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
      const result = await context.call("/api/admin/store/promotions/save", { method: "POST", body: JSON.stringify({
        ...(p ? { id: p.id, version: p.version } : {}), enabled, name: { en: draft.nameEn, fr: draft.nameFr }, terms: { en: draft.termsEn, fr: draft.termsFr },
        productIds: draft.productIds, salePrice: draft.salePrice, perNumberLimit: draft.perNumberLimit,
        startsAt: fromLocal(draft.startsAt), endsAt: fromLocal(draft.endsAt),
        bonus: draft.hasBonus ? { planId: draft.planId, validityHours: draft.days * 24, startsAt: "payment_confirmation" } : null }) });
      const saved = (result.promotions || []).find((x) => x.name.en === draft.nameEn && x.startsAt === fromLocal(draft.startsAt)) || null;
      await showPromotions(host, { ...context, selectedId: saved?.id || p?.id, notice: L(enabled ? "adminPromoScheduled" : "adminPromoDraftSaved") });
    } catch (error) {
      message.textContent = error.message;
      buttons.forEach((b) => { b.disabled = false; });
    }
  };
  host.querySelector("[data-promo-new]")?.addEventListener("click", () => void showPromotions(host, { ...context, selectedId: "new", notice: "" }));
  host.querySelectorAll("[data-promo-edit]").forEach((button) => button.addEventListener("click", () => {
    void showPromotions(host, { ...context, selectedId: button.dataset.promoEdit, notice: "" }).then(() => host.querySelector("#promoNameEn")?.focus());
  }));
  host.querySelector("[data-promo-end]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    if (!window.confirm(L("adminPromoEndConfirm"))) return;
    button.disabled = true;
    try {
      await context.call("/api/admin/store/promotions/end", { method: "POST", body: JSON.stringify({ id: button.dataset.promoEnd }) });
      await showPromotions(host, { ...context, selectedId: button.dataset.promoEnd, notice: L("adminPromoEnded") });
    } catch (error) { message.textContent = error.message; button.disabled = false; }
  });
}
