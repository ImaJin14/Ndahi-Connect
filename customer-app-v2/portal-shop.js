// Shop inside the portal (canvas: PhoneShop, PhoneProduct, PhoneCheckout,
// PhoneOrder). Signed-in customers browse the public catalogue and buy with
// their account details filled in, through the account store API (the same
// orders, stock and payments as the public store). Routes live in the Shop
// tab: #shop, #product/<id>, #checkout/<id>/<quantity> and #order/<id>.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { runButton } from "/shared/pending.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
// Places are written by staff and may end in a full stop; sentences add their own.
const place = (value) => text(value).replace(/[\s.]+$/, "");
const text = (value) => (value && typeof value === "object" ? value[currentLanguage()] || value.en || "" : value || "");
const money = (value) => (value == null ? L("homePriceTbc") : `${Number(value).toLocaleString(currentLanguage() === "fr" ? "fr-CM" : "en-CM")} FCFA`);
const icon = (d, size = 22) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${d}"></path></svg>`;
const BACK = icon("M15 18 9 12l6-6"), SHOP = "M3 9h18l-2-6H5Zm2 0v12h14V9M9 21v-7h6v7", CHECK = "m5 12 5 5 9-10";
const photo = (product, cls) => {
  const image = product.images && product.images[0];
  return `<span class="${cls}">${image && /^data:image\//.test(image.data) ? `<img src="${h(image.data)}" alt="${h(text(image.alt))}" loading="lazy">` : icon(SHOP, 28)}</span>`;
};
const bar = (href, label, title) => `<div class="portal-shop__bar"><a class="portal-sub__back portal-shop__back" href="${href}" aria-label="${h(label)}">${BACK}</a><h2 class="portal-shop__bar-title" id="shopTitle" tabindex="-1">${h(title)}</h2></div>`;
// Order progress, in the order a customer meets it.
const STEPS = ["paid", "preparing", "ready", "collected"];
// Status words are Activity's (portalOrder_<status>); unknown ones show as recorded.
const statusWord = (o) => { const word = L(`portalOrder_${o.status}`); return word === `portalOrder_${o.status}` ? o.status : word; };

let catalogue, account, category = "all", checkout = null, panel, call, api;

function load(force = false) {
  if (!catalogue || force) catalogue = fetch(api + "/api/store/catalogue", { cache: "no-store" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return catalogue;
}
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

function list(data) {
  const cats = (data.categories || []).filter((c) => (data.products || []).some((p) => p.categoryId === c.id));
  const products = (data.products || []).filter((p) => category === "all" || p.categoryId === category);
  const closed = data.settings && data.settings.open === false;
  return `<div class="portal-shop__head"><p class="portal-shop__lede">${h(L("shopLede"))}</p><a class="portal-shop__orders" href="/dashboard#activity">${h(L("shopMyOrders"))}</a></div>
  ${cats.length ? `<div class="nd-chips portal-shop__chips" role="group" aria-label="${h(L("shopCategory"))}">${[["all", L("shopAll")], ...cats.map((c) => [c.id, text(c.name)])].map(([id, label]) => `<button type="button" class="nd-chip" data-shop-category="${h(id)}" aria-pressed="${category === id}">${h(label)}</button>`).join("")}</div>` : ""}
  ${closed ? `<p class="portal-shop__note" role="status">${h(L("shopClosed"))}</p>` : ""}
  <div class="portal-shop__list">${products.length ? products.map((p) => `<a class="portal-shop__item" href="/dashboard#product/${encodeURIComponent(p.id)}">${photo(p, "portal-shop__thumb")}<span class="portal-shop__item-body"><span class="nd-meta">${h(category$(data, p))}</span><strong>${h(text(p.name))}</strong><span class="portal-shop__price">${h(money(p.price))}</span><span class="nd-meta${p.available > 0 ? "" : " portal-shop__out"}">${h(stock(p))}</span></span><span class="portal-shop__chevron" aria-hidden="true">›</span></a>`).join("") : `<p class="nd-meta">${h(L("shopEmpty"))}</p>`}</div>
  ${data.settings && data.settings.pickup ? `<p class="portal-shop__note">${h(L("shopPickupNote", { place: place(data.settings.pickup) }))}</p>` : ""}`;
}

function productView(data, p) {
  const max = Math.max(1, Math.min(20, p.available || 1)), closed = data.settings && data.settings.open === false;
  const facts = [[L("shopWarranty"), text(p.warranty) || text(data.settings && data.settings.warranty)], [L("shopReturns"), text(data.settings && data.settings.returns)]].filter(([, v]) => v);
  return `${bar("/dashboard#shop", L("shopBack"), L("uiTabShop"))}
  <div class="portal-shop__product">${photo(p, "portal-shop__photo")}
    <p class="nd-meta">${h(category$(data, p))}</p><h1 class="portal-shop__name">${h(text(p.name))}</h1>
    <p class="portal-shop__price-row"><strong>${h(money(p.price))}</strong><span class="nd-pill${p.available > 0 ? "" : " portal-shop__out"}">${h(stock(p))}</span></p>
    ${text(p.description) ? `<p class="portal-shop__desc">${h(text(p.description))}</p>` : ""}
    ${facts.length ? `<details class="portal-rule"><summary><span>${h(L("shopDetails"))}</span><span class="portal-rule__chevron" aria-hidden="true"></span></summary>${facts.map(([k, v]) => `<p><strong>${h(k)}:</strong> ${h(v)}</p>`).join("")}</details>` : ""}
  </div>
  <div class="portal-shop__buy">${p.available > 0 && !closed ? `<div class="portal-shop__qty" role="group" aria-label="${h(L("shopQuantity"))}"><button type="button" data-shop-qty="-1" aria-label="${h(L("shopLess"))}">−</button><output id="shopQty" aria-live="polite">1</output><button type="button" data-shop-qty="1" aria-label="${h(L("shopMore"))}" data-max="${max}">+</button></div><a class="nd-btn portal-shop__cta" id="shopBuy" href="/dashboard#checkout/${encodeURIComponent(p.id)}/1">${h(L("shopBuyNow"))}</a>` : `<p class="portal-shop__note" role="status">${h(closed ? L("shopClosed") : L("shopOutOfStock"))}</p>`}</div>`;
}

function checkoutView(data, p, quantity, who) {
  const total = p.price * quantity, pickup = text(data.settings && data.settings.pickup);
  return `${bar(`/dashboard#product/${encodeURIComponent(p.id)}`, L("shopBackProduct"), L("shopCheckout"))}
  <form class="portal-shop__checkout" id="shopCheckout" novalidate>
    <div class="portal-shop__line">${photo(p, "portal-shop__thumb")}<span><strong>${h(text(p.name))}</strong><span class="nd-meta">${h(L("shopQuantityN", { count: quantity }))}</span></span><strong>${h(money(total))}</strong></div>
    <section aria-labelledby="shopContact"><div class="portal-shop__section-head"><h3 id="shopContact">${h(L("shopYourDetails"))}</h3><span class="nd-meta">${h(L("shopFromAccount"))}</span></div><p>${h([who.name, who.phone].filter(Boolean).join(" · "))}</p></section>
    ${pickup ? `<section aria-labelledby="shopPickup"><h3 id="shopPickup">${h(L("shopCollection"))}</h3><p><strong>${h(pickup)}</strong><br><span class="nd-meta">${h(L("shopCodeNote"))}</span></p></section>` : ""}
    <fieldset class="portal-shop__pay"><legend>${h(L("shopPayWith"))}</legend><div class="nd-segmented portal-shop__methods">${[["mtn", "MTN Mobile Money"], ["orange", "Orange Money"]].map(([value, label], i) => `<label class="nd-segmented__option"><input type="radio" name="network" value="${value}" ${i === 0 ? "checked" : ""}><span>${label}</span></label>`).join("")}</div>
      <label class="portal-shop__field">${h(L("shopPayNumber"))}<input name="payerPhone" type="tel" inputmode="tel" autocomplete="tel" value="${h(who.phone || "")}" required></label></fieldset>
    <div class="portal-shop__total"><span>${h(L("shopTotal"))}</span><strong>${h(money(total))}</strong></div>
    <button type="submit" class="nd-btn nd-btn--block">${h(L("shopPay", { amount: money(total) }))}</button>
    <p class="nd-meta portal-shop__fine">${h(L("shopApproveNote"))}</p>
    <div id="shopCheckoutMessage" role="alert"></div>
  </form>`;
}

function orderView(o) {
  // Once paid: Paid is done and Preparing current, then Ready, then all done when Collected.
  const at = o.status === "collected" ? STEPS.length : o.status === "ready" ? 2 : 1;
  const waiting = ["pending", "awaiting_payment"].includes(o.paymentStatus) || o.status === "awaiting_payment";
  const pickup = place(o.pickup);
  return `${bar("/dashboard#activity", L("shopBackActivity"), L("shopOrderTitle", { reference: o.reference }))}
  <div class="portal-shop__line">${photo(o.product || {}, "portal-shop__thumb")}<span><strong>${h(text(o.product && o.product.name))} × ${h(o.quantity)}</strong><span class="nd-meta">${h(money(o.amount))}</span><span class="nd-pill portal-shop__status">${h(statusWord(o))}</span></span></div>
  ${waiting ? `<section class="portal-shop__waiting" aria-labelledby="shopWaitTitle"><h3 id="shopWaitTitle">${h(L("shopApproveTitle"))}</h3><p>${h(L("shopApproveBody", { amount: money(o.amount) }))}</p></section>` : ""}
  ${o.collectionCode ? `<section class="portal-shop__code" aria-labelledby="shopCodeTitle"><h3 id="shopCodeTitle">${h(L("shopCollectionCode"))}</h3><p class="portal-shop__code-value">${h(o.collectionCode)}</p>${pickup ? `<p>${h(L("shopShowCode", { place: pickup }))}</p>` : ""}</section>` : ""}
  ${o.paymentStatus === "paid" ? `<ol class="portal-shop__steps" aria-label="${h(L("shopProgress"))}">${STEPS.map((step, i) => `<li class="${i < at ? "is-done" : i === at ? "is-current" : ""}"${i === at ? ' aria-current="step"' : ""}><span class="portal-shop__dot" aria-hidden="true">${i < at ? icon(CHECK, 14) : ""}</span><strong>${h(L(`shopStep_${step}`))}</strong></li>`).join("")}</ol>` : ""}
  <div class="portal-shop__actions">${waiting || o.paymentStatus !== "paid" ? `<button type="button" class="nd-btn nd-btn--block" data-shop-verify>${h(L("shopCheckStatus"))}</button>` : ""}${o.receiptAvailable ? `<button type="button" class="nd-btn nd-btn--secondary nd-btn--block" data-shop-receipt>${h(L("shopReceipt"))}</button>` : ""}<a class="portal-shop__help" href="/help#support">${h(L("shopHelp"))}</a></div>
  <div id="shopOrderMessage" role="status" aria-live="polite"></div>`;
}

async function render() {
  if (!panel) return;
  const [route, id, extra] = location.hash.slice(1).split("/").map((part) => decodeURIComponent(part || ""));
  if (!["shop", "product", "checkout", "order"].includes(route)) return;
  try {
    if (route === "order" && id) {
      const { order } = await call("/api/account/store/order", { method: "POST", body: JSON.stringify({ orderId: id }) });
      panel.innerHTML = orderView(order); wireOrder(order);
      return;
    }
    const data = await load();
    if (!data) return; // the static fallback (link to the public store) stays
    const product = (data.products || []).find((p) => p.id === id);
    if (route === "product" && product) { panel.innerHTML = productView(data, product); wireProduct(product); }
    else if (route === "checkout" && product && product.available > 0) {
      const quantity = Math.max(1, Math.min(Number(extra) || 1, product.available, 20)), who = (await context()).customer || {};
      if (!checkout || checkout.productId !== product.id || checkout.quantity !== quantity) checkout = { productId: product.id, quantity, key: crypto.randomUUID() };
      panel.innerHTML = checkoutView(data, product, quantity, who); wireCheckout(product, quantity, who);
    } else { panel.innerHTML = list(data); wireList(); }
  } catch (error) {
    panel.innerHTML = `${bar("/dashboard#shop", L("shopBack"), L("uiTabShop"))}<p class="error" role="alert">${h(error.message)}</p>`;
  }
  if (route !== "shop") document.getElementById("shopTitle")?.focus({ preventScroll: true });
}

function wireList() {
  panel.querySelectorAll("[data-shop-category]").forEach((button) => { button.onclick = () => { category = button.dataset.shopCategory; render(); }; });
}
function wireProduct(p) {
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
  form.onsubmit = async (event) => {
    event.preventDefault();
    message.textContent = "";
    const network = form.elements.network.value, payerPhone = form.elements.payerPhone.value.trim();
    if (!payerPhone) { message.textContent = L("shopNeedNumber"); form.elements.payerPhone.focus(); return; }
    try {
      await runButton(form.querySelector('[type="submit"]'), L("shopSending"), async () => {
        const result = await post("/api/account/store/checkout", {
          checkoutKey: checkout.key, productId: p.id, quantity, expectedPrice: p.price,
          name: who.name || "", phone: who.phone || "", email: who.email || "", payerPhone, network });
        checkout = null; account = null; load(true);
        location.hash = `order/${encodeURIComponent(result.order.id)}`;
      }, { controls: Array.from(form.elements) });
    } catch (error) {
      // A new key only when no order was created; otherwise a retry finds the same order.
      if (error.notCreated) checkout = { ...checkout, key: crypto.randomUUID() };
      message.textContent = error.message;
    }
  };
}
function wireOrder(o) {
  const message = document.getElementById("shopOrderMessage"), verify = panel.querySelector("[data-shop-verify]"), receipt = panel.querySelector("[data-shop-receipt]");
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

export function mountShop(options) {
  call = options.call; api = options.api; panel = document.getElementById("shopPanel");
  if (!panel) return;
  if (!mountShop.listening) { mountShop.listening = true; window.addEventListener("hashchange", () => { render(); }); }
  render();
}
