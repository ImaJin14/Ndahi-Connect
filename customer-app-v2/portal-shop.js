// Shop inside the portal (canvas: PhoneShop, PhoneProduct, PhoneCheckout,
// PhoneOrder). Signed-in customers browse the public catalogue and buy with
// their account details filled in, through the account store API (the same
// orders, stock and payments as the public store). Routes live in the Shop
// tab: #shop, #product/<id>, #checkout/<id>/<quantity> and #order/<id>.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { runButton } from "/shared/pending.js";
import * as promo from "./promo.js";
import { setupKits, renderKits } from "./portal-kits.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
// Places are written by staff and may end in a full stop; sentences add their own.
export const place = (value) => text(value).replace(/[\s.]+$/, "");
export const text = (value) => (value && typeof value === "object" ? value[currentLanguage()] || value.en || "" : value || "");
export const money = (value) => (value == null ? L("homePriceTbc") : `${Number(value).toLocaleString(currentLanguage() === "fr" ? "fr-CM" : "en-CM")} FCFA`);
const icon = (d, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"></path></svg>`;
const BACK = icon("M15 18 9 12l6-6"), SHOP = "M3 9h18l-2-6H5Zm2 0v12h14V9M9 21v-7h6v7", CHECK = "m5 12 5 5 9-10";
// The desktop trust strip's icons (canvas: Shop, #417): phone, pin, person.
const TRUST = { pay: "M5 2h14v20H5ZM10 18h4", place: "M12 22s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z", signed: "M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 6 0 0 1 16 0v2" };
// A product photo's address: the API serves photos by path; a photo saved
// before photos were stored on their own is a data URL.
const photoSrc = (image) => {
  const src = image && typeof image.src === "string" ? image.src : "";
  return src.startsWith("/api/store/photos/") ? api.replace(/\/$/, "") + src : /^data:image\/(png|jpeg|webp);base64,/.test(src) ? src : "";
};
export const photo = (product, cls) => {
  const image = product.images && product.images[0], src = photoSrc(image);
  return `<span class="${cls}">${src ? `<img src="${h(src)}" alt="${h(text(image.alt))}" loading="lazy">` : icon(SHOP, 28)}</span>`;
};
// A product's photos (up to 30): the first one large, then a row of
// thumbnails to show another, as on the public store's product page.
function productPhotos(product) {
  const images = (product.images || []).filter(photoSrc);
  return `<div class="portal-shop__media">${photo({ images }, "portal-shop__photo")}${images.length > 1 ? `<div class="portal-shop__shots" role="group" aria-label="${h(L("shopPhotos"))}">${images.map((image, index) =>
    `<button type="button" class="portal-shop__shot" data-shop-photo="${index}" aria-pressed="${index === 0}" aria-label="${h(L("shopShowPhoto", { n: index + 1, count: images.length }))}"><img src="${h(photoSrc(image))}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}</div>`;
}
const bar = (href, label, title) => `<div class="portal-shop__bar"><a class="portal-sub__back portal-shop__back" href="${href}" aria-label="${h(label)}">${BACK}</a><h2 class="portal-shop__bar-title" id="shopTitle" tabindex="-1">${h(title)}</h2></div>`;
// Order progress, in the order a customer meets it.
const STEPS = ["paid", "preparing", "ready", "collected"];
// Status words are Activity's (portalOrder_<status>); unknown ones show as recorded.
const statusWord = (o) => { const word = L(`portalOrder_${o.status}`); return word === `portalOrder_${o.status}` ? o.status : word; };

let catalogue, account, category = "all", checkout = null, panel, call, api;

function load(force = false) {
  if (!catalogue || force) catalogue = fetch(api + "/api/store/catalogue", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null))
    .then((data) => { if (data) promo.setServerTime(data.serverTime); return data; }).catch(() => null);
  return catalogue;
}
// A store promotion (#302) starting or ending: read the catalogue again.
const refresh = () => { load(true); render(); if (homeHost) void showHomePromo(homeHost); };
// Store POSTs that need the response body (checkout says whether an order was created).
async function post(path, input) {
  const csrf = (await context()).csrfToken;
  const response = await fetch(api + path, { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify(input) });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(Error(body.error || L("shopFailed")), { status: response.status, notCreated: body.checkoutNotCreated });
  return body;
}
async function context() {
  account = account || (await call("/api/account/store/context"));
  return account;
}
const category$ = (data, product) => text((data.categories || []).find((c) => c.id === product.categoryId)?.name);
const stock = (product) => (product.available > 0 ? L("shopInStock", { count: product.available }) : L("shopOutOfStock"));
// The list's stock line (canvas: PhoneShop): "Only 2 left" from two units down.
const LOW_STOCK = 2;
const listStock = (product) => (product.available > 0 && product.available <= LOW_STOCK ? L("shopOnlyLeft", { count: product.available }) : stock(product));
// A chip's label on phones: the category's short name (canvas: PhoneShop;
// #414, owner 26 Nov), else its name. Desktop (canvas: Shop) keeps the name.
const chipLabel = (c) => {
  const full = text(c.name), short = text(c.shortName);
  return short && short !== full ? `<span class="nd-narrow-only">${h(short)}</span><span class="nd-wide-only">${h(full)}</span>` : h(full);
};

// Kits on sale head the Shop list, in the products' row style: photo, name,
// kit price and stock (owner, 27 Nov, #373).
const kitRows = (data) => (data.kits || []).map((k) => `<a class="portal-shop__item portal-shop__item--kit" href="/dashboard#kit/${encodeURIComponent(k.id)}">${photo({ images: k.items[0]?.image ? [k.items[0].image] : [] }, "portal-shop__thumb")}<span class="portal-shop__item-body"><span class="nd-meta">${h(L("kitShopLabel"))}</span><strong>${h(text(k.name))}</strong><span class="portal-shop__price">${h(money(k.price))}</span><span class="nd-meta portal-shop__stock${k.available > 0 ? k.available <= LOW_STOCK ? " portal-shop__stock--low" : "" : " portal-shop__out"}">${h(listStock(k))}</span><span class="portal-shop__view nd-wide-only" aria-hidden="true">${h(L("shopView"))}</span></span><span class="portal-shop__chevron" aria-hidden="true">›</span></a>`).join("");

function list(data) {
  const cats = (data.categories || []).filter((c) => (data.products || []).some((p) => p.categoryId === c.id));
  const products = (data.products || []).filter((p) => category === "all" || p.categoryId === category);
  const closed = data.settings && data.settings.open === false;
  const place$ = place(data.settings && data.settings.pickup);
  return `${promo.banner(data, "shopPromoTitle")}<div class="portal-shop__head"><a class="portal-shop__orders" href="/dashboard#activity">${h(L("shopMyOrders"))}</a></div>
  <ul class="portal-shop__trust nd-wide-only"><li>${icon(TRUST.pay, 18)}${h(L("shopTrustPay"))}</li>${place$ ? `<li>${icon(TRUST.place, 18)}${h(L("shopTrustCollect", { place: place$ }))}</li>` : ""}<li>${icon(TRUST.signed, 18)}${h(L("shopTrustSigned"))}</li></ul>
  ${cats.length ? `<div class="nd-chips portal-shop__chips" role="group" aria-label="${h(L("shopCategory"))}">${[["all", `<span class="nd-narrow-only">${h(L("shopAll"))}</span><span class="nd-wide-only">${h(L("shopAllDevices"))}</span>`], ...cats.map((c) => [c.id, chipLabel(c)])].map(([id, label]) => `<button type="button" class="nd-chip" data-shop-category="${h(id)}" aria-pressed="${category === id}">${label}</button>`).join("")}</div>` : ""}
  ${closed ? `<p class="portal-shop__note" role="status">${h(L("shopClosed"))}</p>` : ""}
  <div class="portal-shop__list">${category === "all" ? kitRows(data) : ""}${products.length || (category === "all" && (data.kits || []).length) ? products.map((p) => { const x = promo.listExtras(p); return `<a class="portal-shop__item${x ? " portal-shop__item--promo" : ""}" href="/dashboard#product/${encodeURIComponent(p.id)}">${photo(p, "portal-shop__thumb")}<span class="portal-shop__item-body">${x ? x.badge : `<span class="nd-meta">${h(category$(data, p))}</span>`}<strong>${h(text(p.name))}</strong><span class="portal-shop__price">${h(money(p.price))}</span>${x ? x.chip : ""}<span class="nd-meta portal-shop__stock${p.available > 0 ? p.available <= LOW_STOCK ? " portal-shop__stock--low" : "" : " portal-shop__out"}${x && p.available > 0 ? " portal-promo__left" : ""}">${h(x && p.available > 0 ? x.stock : listStock(p))}</span><span class="portal-shop__desc-short nd-wide-only">${h(text(p.description))}</span><span class="portal-shop__view nd-wide-only" aria-hidden="true">${h(L("shopView"))}</span></span><span class="portal-shop__chevron" aria-hidden="true">›</span></a>`; }).join("") : `<p class="nd-meta">${h(L("shopEmpty"))}</p>`}</div>
  ${place$ ? `<p class="portal-shop__note portal-shop__pickup nd-narrow-only">${h(L("shopPickupNote", { place: place$ }))}</p>` : ""}
  <div class="portal-shop__friends nd-wide-only"><p><strong>${h(L("shopFriendsTitle"))}</strong> ${h(L("shopFriendsBody"))}</p><a class="nd-btn nd-btn--sm" href="https://store.ndahiconnect.net" target="_blank" rel="noopener">${h(L("shopFriendsLink"))}</a></div>`;
}

// The phone product page's tiles (canvas: PhoneProduct, #410; owner 26 Nov):
// what the device needs, when the owner has written it, and that internet is
// sold separately, which is true of every device in the shop.
const facts$ = (p) => {
  const tiles = [...(text(p.needs) ? [[L("shopNeeds"), text(p.needs)]] : []), [L("shopInternet"), L("shopSoldSeparately")]];
  return `<dl class="portal-shop__facts nd-narrow-only">${tiles.map(([k, v]) => `<div><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join("")}</dl>`;
};

// The deal on a phone (canvas: PhonePromoBuy, #411): no quantity unless the
// offer allows more than one, no "sold separately" tile or details beyond its terms.
function promoProductView(data, p) {
  const closed = data.settings && data.settings.open === false, image = (p.images || []).filter(photoSrc)[0];
  const d = promo.buyProduct(p, { photo: image ? `<img src="${h(photoSrc(image))}" alt="${h(text(image.alt))}">` : `<span class="portal-buy__placeholder">${icon(SHOP, 28)}</span>`, closed });
  const max = Math.max(1, Math.min(p.promotion.perNumberLimit, d.left || 1)), can = d.left > 0 && !closed;
  return `${bar("/dashboard#shop", L("shopBack"), L("uiTabShop"))}
  <div class="portal-shop__product portal-buy">${d.top}
    <div class="portal-buy__body"><h1 class="portal-shop__name portal-buy__name">${h(text(p.name))}</h1>${d.price}${d.bonus}
    ${text(p.description) ? `<p class="portal-buy__desc">${h(text(p.description))}</p>` : ""}${d.terms}</div>
  <div class="portal-shop__buy portal-buy__foot">${can ? `${max > 1 ? `<div class="portal-shop__qty" role="group" aria-label="${h(L("shopQuantity"))}"><button type="button" data-shop-qty="-1" aria-label="${h(L("shopLess"))}">−</button><output id="shopQty" aria-live="polite">1</output><button type="button" data-shop-qty="1" aria-label="${h(L("shopMore"))}" data-max="${max}">+</button></div>` : ""}<a class="nd-btn portal-shop__cta portal-buy__cta" id="shopBuy" href="/dashboard#checkout/${encodeURIComponent(p.id)}/1">${h(d.button)}</a><p class="portal-buy__limit">${h(d.limit)}</p>`
    : `<p class="portal-shop__note" role="status">${h(closed ? L("shopClosed") : L("shopOutOfStock"))}</p>`}</div>
  </div>`;
}
function productView(data, p) {
  if (p.promotion) return promoProductView(data, p);
  // An offer limits how many one phone number may buy (#302).
  const max = Math.max(1, Math.min(p.promotion ? p.promotion.perNumberLimit : 20, p.available || 1)), closed = data.settings && data.settings.open === false, x = promo.productExtras(p);
  const facts = [[L("shopSpecifications"), text(p.specifications)], [L("shopContents"), text(p.contents)], [L("shopCompatibility"), text(p.compatibility)], [L("shopSetup"), text(p.setup)], [L("shopWarranty"), text(p.warranty) || text(data.settings && data.settings.warranty)], [L("shopReturns"), text(data.settings && data.settings.returns)]].filter(([, v]) => v);
  return `${bar("/dashboard#shop", L("shopBack"), L("uiTabShop"))}
  <div class="portal-shop__product">${x ? x.top : ""}${productPhotos(p)}
    <p class="nd-meta">${h(category$(data, p))}</p><h1 class="portal-shop__name">${h(text(p.name))}</h1>
    <p class="portal-shop__price-row"><strong>${h(money(p.price))}</strong><span class="nd-pill${p.available > 0 ? "" : " portal-shop__out"}${x && p.available > 0 ? " portal-promo__left" : ""}">${h(x && p.available > 0 ? x.stock : stock(p))}</span></p>
    ${x ? x.bonus : ""}
    ${text(p.description) ? `<p class="portal-shop__desc">${h(text(p.description))}</p>` : ""}
    ${facts$(p)}
    ${x ? x.terms : ""}
    ${facts.length ? `<details class="portal-rule"><summary><span>${h(L("shopDetailsAll"))}</span><span class="portal-rule__chevron" aria-hidden="true"></span></summary>${facts.map(([k, v]) => `<p><strong>${h(k)}:</strong> ${h(v)}</p>`).join("")}</details>` : ""}
  <div class="portal-shop__buy">${p.available > 0 && !closed ? `<div class="portal-shop__qty" role="group" aria-label="${h(L("shopQuantity"))}"><button type="button" data-shop-qty="-1" aria-label="${h(L("shopLess"))}">−</button><output id="shopQty" aria-live="polite">1</output><button type="button" data-shop-qty="1" aria-label="${h(L("shopMore"))}" data-max="${max}"${max <= 1 ? " disabled" : ""}>+</button></div><a class="nd-btn portal-shop__cta" id="shopBuy" href="/dashboard#checkout/${encodeURIComponent(p.id)}/1">${h(x ? x.button : L("shopBuyNow"))}</a>` : `<p class="portal-shop__note" role="status">${h(closed ? L("shopClosed") : L("shopOutOfStock"))}</p>`}</div>
  ${x && p.available > 0 && !closed ? `<p class="nd-meta portal-promo__limit">${h(x.limit)}</p>` : ""}
  </div>`;
}

// Checkout (canvas: PhoneCheckout, #397): the item, your details, collection,
// Pay with, then price · Mobile Payment Fee (2%) · Total to Pay, the wallet
// notice and Pay Now (#297, 24 Nov). The fee and total are the server's quote
// for this quantity (paymentQuotes[network][quantity - 1]); without one the fee
// is shown in the operator prompt. Paying opens the drawn "Waiting for
// payment" and "Order placed" screens at #checkout/<id>/<quantity>/<order>.
export const METHOD_NAMES = { mtn: "MTN MoMo", orange: "Orange Money" };
const shopQuote = (p, network, quantity) => { const q = p.paymentQuotes && p.paymentQuotes[network] && p.paymentQuotes[network][quantity - 1]; return q && Number.isFinite(q.total) ? q : null; };
// "Amina N." and "+237 6•• •• 12 45", as drawn: the details are the account's.
export const shortName = (name) => { const words = String(name || "").trim().split(/\s+/).filter(Boolean); return words.length > 1 ? `${words[0]} ${words.at(-1)[0]}.` : words[0] || ""; };
const nine = (phone) => String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
export const maskedPhone = (phone, country = true) => { const d = nine(phone); return d.length === 9 ? `${country ? "+237 " : ""}${d[0]}•• •• ${d.slice(5, 7)} ${d.slice(7)}` : phone || ""; };
// The price without the currency, as the item line draws it.
const amount = (value) => (value == null ? L("homePriceTbc") : Number(value).toLocaleString(currentLanguage() === "fr" ? "fr-CM" : "en-CM"));
function costView(p, quantity, network) {
  const q = shopQuote(p, network, quantity), price = q ? q.price : p.price * quantity;
  const notice = h(L(q ? "deskBuyNotice" : "deskBuyNoticeNoFee", { amount: "\u0000", wallet: METHOD_NAMES[network] })).replace("\u0000", `<strong>${h(money(q ? q.total : price))}</strong>`);
  return `<div class="portal-shop__cost" id="shopCost">
    <div class="portal-shop__cost-row"><span>${h(L("shopItem"))}</span><span>${h(money(price))}</span></div>
    ${promo.checkoutExtras(p).line}
    <div class="portal-shop__cost-row"><span>${h(L(q ? "deskBuyFee" : "deskBuyFeePlain"))}</span><span>${h(q ? money(q.fee) : L("deskBuyFeeInPrompt"))}</span></div>
    ${q ? `<div class="portal-shop__total"><span>${h(L("deskBuyTotal"))}</span><strong>${h(money(q.total))}</strong></div>` : ""}
    <p class="portal-shop__balance" role="note">${notice}</p>
  </div>`;
}

// The deal's checkout (canvas: PhonePromoBuy; owner 27 Nov, #411): the order,
// how the free bundle arrives and where to collect, as drawn, then Pay with and
// the number, the wallet note and Pay Now.
const promoNote = (p, quantity, network) => {
  const q = shopQuote(p, network, quantity), price = q ? q.price : p.price * quantity;
  const notice = h(L(q ? "deskBuyNotice" : "deskBuyNoticeNoFee", { amount: "\u0000", wallet: METHOD_NAMES[network] })).replace("\u0000", `<strong>${h(money(q ? q.total : price))}</strong>`);
  return `<p class="portal-buy__note" id="shopNote" role="note">${notice}</p>`;
};
function promoCheckoutView(data, p, quantity, who) {
  const pickup = place(data.settings && data.settings.pickup);
  return `${bar(`/dashboard#product/${encodeURIComponent(p.id)}`, L("shopBackProduct"), L("shopCheckout"))}
  <form class="portal-shop__checkout portal-buy__checkout" id="shopCheckout" novalidate>
    <div class="portal-shop__checkout-main portal-buy__main">
    ${promo.buyOrderLines(p, quantity, shopQuote(p, "mtn", quantity))}
    ${promo.buyHow(p)}
    <div class="portal-buy__collect"><strong>${h(pickup ? L("buyCollectAt", { place: pickup }) : L("shopCollection"))}</strong><span>${h(L("buyWhoAccount", { name: shortName(who.name), phone: maskedPhone(who.phone, false) }))}</span></div>
    <fieldset class="portal-shop__pay"><legend>${h(L("shopPayWith"))}</legend><div class="portal-shop__methods">${["mtn", "orange"].map((value, i) => `<label class="portal-shop__method"><input type="radio" name="network" value="${value}" ${i === 0 ? "checked" : ""}><span>${METHOD_NAMES[value]}</span></label>`).join("")}</div>
      <label class="portal-shop__field">${h(L("shopPayNumber"))}<span class="portal-shop__payer"><input name="payerPhone" type="tel" inputmode="tel" autocomplete="tel" value="${h(who.phone || "")}" required><span class="portal-shop__mask" id="shopPayerMask" aria-hidden="true"></span></span></label></fieldset>
    ${promoNote(p, quantity, "mtn")}
    </div>
    <div class="portal-shop__foot portal-buy__pay">
    <button type="submit" class="nd-btn nd-btn--block">${h(L("deskBuyPayNow"))}</button>
    <div id="shopCheckoutMessage" role="alert"></div>
    </div>
  </form>`;
}
function checkoutView(data, p, quantity, who) {
  if (p.promotion) return promoCheckoutView(data, p, quantity, who);
  const pickup = text(data.settings && data.settings.pickup);
  return `${bar(`/dashboard#product/${encodeURIComponent(p.id)}`, L("shopBackProduct"), L("shopCheckout"))}
  <form class="portal-shop__checkout" id="shopCheckout" novalidate>
    <div class="portal-shop__checkout-main">
    <div class="portal-shop__line">${photo(p, "portal-shop__thumb")}<span><strong>${h(text(p.name))}</strong><span class="nd-meta">${h(L("shopQuantityN", { count: quantity }))}</span></span><strong>${h(amount(p.price * quantity))}</strong></div>
    <section aria-labelledby="shopContact"><div class="portal-shop__section-head"><h3 id="shopContact">${h(L("shopYourDetails"))}</h3><span class="nd-pill nd-pill--success portal-shop__from">${h(L("shopFromAccount"))}</span></div><p>${h([shortName(who.name), maskedPhone(who.phone)].filter(Boolean).join(" · "))}</p></section>
    ${pickup ? `<section aria-labelledby="shopPickup"><h3 id="shopPickup">${h(L("shopCollection"))}</h3><p><strong>${h(pickup)}</strong><span class="nd-meta">${h(L("shopCodeNote"))}</span></p></section>` : ""}
    <fieldset class="portal-shop__pay"><legend>${h(L("shopPayWith"))}</legend><div class="portal-shop__methods">${["mtn", "orange"].map((value, i) => `<label class="portal-shop__method"><input type="radio" name="network" value="${value}" ${i === 0 ? "checked" : ""}><span>${METHOD_NAMES[value]}</span></label>`).join("")}</div>
      <label class="portal-shop__field">${h(L("shopPayNumber"))}<span class="portal-shop__payer"><input name="payerPhone" type="tel" inputmode="tel" autocomplete="tel" value="${h(who.phone || "")}" required><span class="portal-shop__mask" id="shopPayerMask" aria-hidden="true"></span></span></label></fieldset>
    </div>
    <div class="portal-shop__foot">
    ${costView(p, quantity, "mtn")}
    ${promo.checkoutExtras(p).note}
    <button type="submit" class="nd-btn nd-btn--block">${h(L("deskBuyPayNow"))}</button>
    <p class="nd-meta portal-shop__fine">${h(L("shopApproveNote"))}</p>
    <div id="shopCheckoutMessage" role="alert"></div>
    </div>
  </form>`;
}

// Waiting for payment and Order placed (canvas: PhoneCheckout): a bar without
// a back arrow, the state, and its two actions at the bottom.
const STATE_ICONS = { wait: "M5 2h14v20H5ZM10 18h4M12 7v4l2 2", done: CHECK };
const stateBar = (title) => `<div class="portal-shop__bar portal-shop__bar--state"><h2 class="portal-shop__bar-title" id="shopTitle" tabindex="-1">${h(title)}</h2></div>`;
export function waitView(o) {
  const method = METHOD_NAMES[o.network] || "Mobile Money", fee = Number.isFinite(o.total) && Number.isFinite(o.fee);
  const body = h(L(fee ? "shopWaitBody" : "shopWaitBodyNoFee", { method, amount: "\u0000", fee: fee ? money(o.fee) : "" })).replace("\u0000", `<strong>${h(money(fee ? o.total : o.amount))}</strong>`);
  return `${stateBar(L("shopWaitingTitle"))}
  <div class="portal-shop__state portal-shop__state--wait"><span class="portal-shop__state-icon" aria-hidden="true">${icon(STATE_ICONS.wait, 38)}</span><h1 class="portal-shop__state-title">${h(L("shopApproveTitle"))}</h1><p>${body}</p></div>
  <div class="portal-shop__foot portal-shop__foot--actions"><button type="button" class="nd-btn nd-btn--block" data-shop-check>${h(L("shopCheckStatus"))}</button><button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-shop-change>${h(L("shopChangePayment"))}</button><div id="shopCheckoutMessage" role="status" aria-live="polite"></div></div>`;
}
// Order placed for a deal (canvas: PhonePromoBuy): the timeline of the router and its free bundle.
function promoDoneView(o) {
  const body = h(L("buyPlacedBody", { reference: "\u0000" })).replace("\u0000", `<strong>${h(o.reference)}</strong>`);
  return `${stateBar(L("shopConfirmedTitle"))}
  <div class="portal-buy__done"><div class="portal-buy__done-head"><span class="portal-buy__done-icon" aria-hidden="true">${icon(CHECK, 26)}</span><h1 class="portal-shop__state-title portal-buy__h1">${h(L("shopPlacedTitle"))}</h1></div>
  <p class="portal-buy__placed">${body}</p>${promo.buyDone(o, place(o.pickup))}</div>
  <div class="portal-shop__foot portal-shop__foot--actions"><a class="nd-btn nd-btn--block" href="/dashboard#order/${encodeURIComponent(o.id)}">${h(L("buyTrack"))}</a></div>`;
}
export function doneView(o) {
  if (o.promotion) return promoDoneView(o);
  const body = h(L("shopPlacedBody", { reference: "\u0000" })).replace("\u0000", `<strong>${h(o.reference)}</strong>`);
  const saved = h(L("shopPlacedSaved", { activity: "\u0000" })).replace("\u0000", `<strong>${h(L("uiTabActivity"))}</strong>`);
  return `${stateBar(L("shopConfirmedTitle"))}
  <div class="portal-shop__state portal-shop__state--done"><span class="portal-shop__state-icon" aria-hidden="true">${icon(STATE_ICONS.done, 40)}</span><h1 class="portal-shop__state-title">${h(L("shopPlacedTitle"))}</h1><p>${body}</p><p class="portal-shop__saved">${saved}</p></div>
  <div class="portal-shop__foot portal-shop__foot--actions"><a class="nd-btn nd-btn--block" href="/dashboard#order/${encodeURIComponent(o.id)}">${h(L("shopViewOrder"))}</a><a class="nd-btn nd-btn--secondary nd-btn--block" href="/dashboard#shop">${h(L("shopBackToShop"))}</a></div>`;
}
// Which screen a placed order shows: paid, waiting, or (cancelled, failed,
// expired or in review) its order page.
export const placedState = (o) => (o.paymentStatus === "paid" && o.status !== "review" ? "done" : o.status === "awaiting_payment" && !["failed", "expired"].includes(o.paymentStatus) ? "wait" : "order");

// Order tracking (canvas: PhoneOrder, #406): the item with how it was paid,
// the collection code, the steps with when each happened and how long a ready
// order is held, then Receipt and Get help. New orders' codes are six digits,
// shown "739 204"; older ten-character codes show as they are.
export const codeShown = (code) => (/^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : code);
const stepTime = (value) => { const t = Date.parse(value); return Number.isFinite(t) ? new Date(t).toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Africa/Douala" }) : ""; };
const stepDay = (value) => new Date(value).toLocaleDateString(currentLanguage() === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short", timeZone: "Africa/Douala" });
const ORDER_TONES = { ready: "info", preparing: "warning", awaiting_payment: "warning", review: "danger" };
function orderSteps(o) {
  // Once paid: Paid is done and Preparing current, then Ready, then all done when Collected.
  const at = o.status === "collected" ? STEPS.length : o.status === "ready" ? 2 : 1, p = o.progress || {};
  const lines = { paid: stepTime(p.paidAt), preparing: at > 1 ? stepTime(p.readyAt) : "", ready: at === 2 && o.holdUntil ? L("shopHeldUntil", { date: stepDay(o.holdUntil) }) : "", collected: stepTime(p.collectedAt) };
  return `<ol class="portal-shop__steps" aria-label="${h(L("shopProgress"))}">${STEPS.map((step, i) => `<li class="${i < at ? "is-done" : i === at ? "is-current" : ""}"${i === at ? ' aria-current="step"' : ""}><span class="portal-shop__dot" aria-hidden="true">${i < at ? icon(CHECK, 12) : i === at ? "<span></span>" : ""}</span><span class="portal-shop__step-text"><strong>${h(L(`shopStep_${step}`))}</strong>${lines[step] ? `<span class="nd-meta">${h(lines[step])}</span>` : ""}</span></li>`).join("")}</ol>`;
}
function orderView(o) {
  const waiting = ["pending", "awaiting_payment"].includes(o.paymentStatus) || o.status === "awaiting_payment";
  const pickup = place(o.pickup), tone = ORDER_TONES[o.status];
  return `${bar("/dashboard#activity", L("shopBackActivity"), L("shopOrderTitle", { reference: o.reference }))}
  <div class="portal-shop__order">
  <div class="portal-shop__line portal-shop__line--order">${photo(o.product || {}, "portal-shop__thumb")}<span><strong>${h(text(o.product && o.product.name))} × ${h(o.quantity)}</strong><span class="nd-meta">${h([money(o.amount), METHOD_NAMES[o.network]].filter(Boolean).join(" · "))}</span></span><span class="nd-pill portal-shop__status${tone ? ` nd-pill--${tone}` : ""}">${h(statusWord(o))}</span></div>
  ${waiting ? `<section class="portal-shop__waiting" aria-labelledby="shopWaitTitle"><h3 id="shopWaitTitle">${h(L("shopApproveTitle"))}</h3><p>${h(Number.isFinite(o.total) && Number.isFinite(o.fee)
    ? L("shopApproveBody", { method: METHOD_NAMES[o.network] || "Mobile Money", amount: money(o.total), fee: money(o.fee) })
    : L("shopApproveBodyNoFee", { method: METHOD_NAMES[o.network] || "Mobile Money", amount: money(o.amount) }))}</p></section>` : ""}
  ${o.collectionCode ? `<section class="portal-shop__code" aria-labelledby="shopCodeTitle"><h3 id="shopCodeTitle">${h(L("shopCollectionCode"))}</h3><p class="portal-shop__code-value">${h(codeShown(o.collectionCode))}</p>${pickup ? `<p>${h(L("shopShowCode", { place: pickup }))}</p>` : ""}</section>` : ""}
  ${promo.orderExtras(o)}
  ${o.paymentStatus === "paid" ? orderSteps(o) : ""}
  <div class="portal-shop__actions">${waiting || o.paymentStatus !== "paid" ? `<button type="button" class="nd-btn nd-btn--block" data-shop-verify>${h(L("shopCheckStatus"))}</button>` : ""}${o.receiptAvailable ? `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-shop-receipt>${h(L("shopReceipt"))}</button>` : ""}<a class="portal-shop__help" href="/help#support">${h(L("shopGetHelp"))}</a></div>
  <div id="shopOrderMessage" role="status" aria-live="polite"></div>
  </div>`;
}

async function render() {
  if (!panel) return;
  const [route, id, extra, ...rest] = location.hash.slice(1).split("/").map((part) => decodeURIComponent(part || ""));
  // Kits, their booking and payment plans (#373, #374, #375).
  if (["kit", "booking", "plan"].includes(route)) return renderKits(route, [id, extra, ...rest]);
  if (!["shop", "product", "checkout", "order"].includes(route)) return;
  try {
    // A placed order on its checkout screens (#397).
    if (route === "checkout" && id && rest[0]) {
      const { order } = await call("/api/account/store/order", { method: "POST", body: JSON.stringify({ orderId: rest[0] }) });
      return showPlaced(order, id, extra);
    }
    if (route === "order" && id) {
      const { order } = await call("/api/account/store/order", { method: "POST", body: JSON.stringify({ orderId: id }) });
      panel.innerHTML = orderView(order); wireOrder(order);
      return;
    }
    const data = await load();
    if (!data) return; // the static fallback (link to the public store) stays
    const product = (data.products || []).find((p) => p.id === id);
    if (route === "product" && product) { panel.innerHTML = productView(data, product); wireProduct(product); promo.tick(panel, refresh); }
    else if (route === "checkout" && product && product.available > 0) {
      const quantity = Math.max(1, Math.min(Number(extra) || 1, product.available, product.promotion ? product.promotion.perNumberLimit : 20)), who = (await context()).customer || {};
      if (!checkout || checkout.productId !== product.id || checkout.quantity !== quantity) checkout = { productId: product.id, quantity, key: crypto.randomUUID() };
      panel.innerHTML = checkoutView(data, product, quantity, who); wireCheckout(product, quantity, who);
    } else { panel.innerHTML = list(data); wireList(); promo.tick(panel, refresh); }
  } catch (error) {
    panel.innerHTML = `${bar("/dashboard#shop", L("shopBack"), L("uiTabShop"))}<p class="error" role="alert">${h(error.message)}</p>`;
  }
  if (route !== "shop") document.getElementById("shopTitle")?.focus({ preventScroll: true });
}

function wireList() {
  panel.querySelectorAll("[data-shop-category]").forEach((button) => { button.onclick = () => { category = button.dataset.shopCategory; render(); }; });
}
function wireProduct(p) {
  const images = (p.images || []).filter(photoSrc);
  panel.querySelectorAll("[data-shop-photo]").forEach((button) => {
    button.onclick = () => {
      const image = images[Number(button.dataset.shopPhoto)], main = panel.querySelector(".portal-shop__photo img");
      if (!image || !main) return;
      main.src = photoSrc(image);
      main.alt = text(image.alt);
      panel.querySelectorAll("[data-shop-photo]").forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
    };
  });
  const output = document.getElementById("shopQty"), buy = document.getElementById("shopBuy");
  panel.querySelectorAll("[data-shop-qty]").forEach((button) => {
    button.onclick = () => {
      const max = Number(panel.querySelector("[data-max]").dataset.max), next = Math.max(1, Math.min(max, Number(output.value || output.textContent) + Number(button.dataset.shopQty)));
      output.textContent = String(next);
      buy.href = `/dashboard#checkout/${encodeURIComponent(p.id)}/${next}`;
    };
  });
}
function wireCheckout(p, quantity, who) {
  const form = document.getElementById("shopCheckout"), message = document.getElementById("shopCheckoutMessage");
  // The number shows masked, as drawn ("6•• •• 12 45"), until the field is used.
  const payer = form.elements.payerPhone, mask = document.getElementById("shopPayerMask");
  const showMask = () => { const masked = document.activeElement === payer ? "" : maskedPhone(payer.value, false); mask.textContent = masked; payer.classList.toggle("portal-shop__payer--masked", Boolean(masked) && masked !== payer.value); };
  for (const type of ["focus", "blur", "input", "change"]) payer.addEventListener(type, showMask);
  showMask();
  // The breakdown and the wallet notice follow the chosen network.
  form.querySelectorAll('input[name="network"]').forEach((radio) => { radio.onchange = () => {
    const network = form.elements.network.value;
    if (p.promotion) {
      document.getElementById("shopCost").outerHTML = promo.buyOrderLines(p, quantity, shopQuote(p, network, quantity));
      document.getElementById("shopNote").outerHTML = promoNote(p, quantity, network);
    } else document.getElementById("shopCost").outerHTML = costView(p, quantity, network);
  }; });
  form.onsubmit = async (event) => {
    event.preventDefault();
    message.textContent = "";
    const network = form.elements.network.value, payerPhone = payer.value.trim();
    if (!payerPhone) { message.textContent = L("shopNeedNumber"); payer.focus(); return; }
    try {
      await runButton(form.querySelector('[type="submit"]'), L("shopSending"), async () => {
        const result = await post("/api/account/store/checkout", {
          checkoutKey: checkout.key, productId: p.id, quantity, expectedPrice: p.price,
          name: who.name || "", phone: who.phone || "", email: who.email || "", payerPhone, network });
        checkout = null; account = null; load(true);
        // The drawn waiting screen; Back still leads to the product.
        location.replace(`#checkout/${encodeURIComponent(p.id)}/${quantity}/${encodeURIComponent(result.order.id)}`);
      }, { controls: Array.from(form.elements) });
    } catch (error) {
      // A new key only when no order was created; otherwise a retry finds the same order.
      if (error.notCreated) checkout = { ...checkout, key: crypto.randomUUID() };
      message.textContent = error.message;
    }
  };
}
// The waiting and placed screens. Check status asks the provider; Change
// payment cancels the unpaid order (owner, 26 Nov) and opens the form again
// with a fresh request.
function showPlaced(o, productId, quantity) {
  const state = placedState(o);
  if (state === "order") { location.replace(`#order/${encodeURIComponent(o.id)}`); return; }
  panel.innerHTML = state === "done" ? doneView(o) : waitView(o);
  document.getElementById("shopTitle")?.focus({ preventScroll: true });
  if (state !== "wait") return;
  const message = document.getElementById("shopCheckoutMessage"), check = panel.querySelector("[data-shop-check]"), change = panel.querySelector("[data-shop-change]");
  const controls = [check, change];
  check.onclick = () => runButton(check, L("shopChecking"), async () => {
    try {
      const { order } = await call("/api/account/store/verify", { method: "POST", body: JSON.stringify({ orderId: o.id }) });
      if (placedState(order) === "wait") message.textContent = L("shopStillWaiting");
      else showPlaced(order, productId, quantity);
    } catch (error) { message.textContent = error.message; }
  }, { controls });
  change.onclick = () => runButton(change, L("shopChanging"), async () => {
    try {
      const { order } = await post("/api/account/store/cancel", { orderId: o.id });
      if (placedState(order) === "done") { showPlaced(order, productId, quantity); return; }
      account = null; load(true);
      location.replace(`#checkout/${encodeURIComponent(productId)}/${encodeURIComponent(quantity || 1)}`);
    } catch (error) { message.textContent = error.message; }
  }, { controls });
}
function wireOrder(o) {
  const message = document.getElementById("shopOrderMessage"), verify = panel.querySelector("[data-shop-verify]"), receipt = panel.querySelector("[data-shop-receipt]");
  // Start the free month from its order (#423), then show the order again.
  promo.bindFreeMonth(panel, call, async () => {
    try { const { order } = await call("/api/account/store/order", { method: "POST", body: JSON.stringify({ orderId: o.id }) }); panel.innerHTML = orderView(order); wireOrder(order); }
    catch (_) { /* The order shows its new state next time it opens. */ }
  });
  if (verify) verify.onclick = () => runButton(verify, L("shopChecking"), async () => {
    try { const { order } = await call("/api/account/store/verify", { method: "POST", body: JSON.stringify({ orderId: o.id }) }); panel.innerHTML = orderView(order); wireOrder(order); }
    catch (error) { message.textContent = error.message; }
  });
  if (receipt) receipt.onclick = () => runButton(receipt, L("shopPreparing"), async () => {
    try {
      const csrf = (await context()).csrfToken;
      const response = await fetch(api + "/api/account/store/receipt", { method: "POST", credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify({ orderId: o.id }) });
      if (!response.ok) throw Error((await response.json().catch(() => ({}))).error || L("shopReceiptUnavailable"));
      const url = URL.createObjectURL(await response.blob()), link = document.createElement("a");
      link.href = url; link.download = `ndahi-store-receipt-${o.reference || o.id}.pdf`; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
    } catch (error) { message.textContent = error.message; }
  });
}

// The Home banner (#302): the offer and its countdown, from the same catalogue.
let homeHost;
export async function showHomePromo(host) {
  homeHost = host;
  if (!host || !api) return;
  const data = await load();
  host.innerHTML = data ? promo.banner(data, "homePromoTitle") : "";
  host.hidden = !host.innerHTML;
  promo.tick(host, refresh);
}

export function mountShop(options) {
  call = options.call; api = options.api; panel = document.getElementById("shopPanel");
  if (!panel) return;
  setupKits({ call, api, panel, load, post, context, resetContext: () => { account = null; } });
  if (!mountShop.listening) { mountShop.listening = true; window.addEventListener("hashchange", () => { render(); }); }
  render();
}
