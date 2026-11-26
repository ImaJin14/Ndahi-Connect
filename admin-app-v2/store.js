// Redesigned store management (admin-app-v2), three canvas screens over v1's
// store API and logic:
//   #store       Store orders (AdminStore): open orders beside the chosen order
//   #products    Products (AdminProducts): checkout banner, catalogue with quick
//                stock and visibility, then stock ledger, categories, settings
//   #product/id  Edit product (AdminProductEdit): EN/FR details, photos, price
//                and stock, visibility; Save product in the page head
// Strings come from shared-app/i18n/admin.js, in English and French.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { fcfa as money, maskPhone, paymentMethod } from "/payments.js";
const MAX_PRODUCT_IMAGES = 30;
// A product photo's address: the API serves photos by path; a photo saved
// before photos were stored on their own carries its data URL.
const photoSrc = (image) => (image?.src?.startsWith("/") ? String(window.NDAHI_CONFIG.apiUrl).replace(/\/$/, "") + image.src : image?.src || image?.data || "");
const loc = (en = "", fr = "") => ({ en, fr });
const emptyProduct = () => ({
  name: loc(),
  sku: "",
  categoryId: "",
  price: null,
  cost: 0,
  status: "draft",
  featured: false,
  images: [],
  description: loc(),
  specifications: loc(),
  compatibility: loc(),
  contents: loc(),
  warranty: loc(),
  setup: loc(),
  needs: loc(),
  keySpecs: [],
});
const field = (name, label, value = "", type = "text", extra = "") =>
  `<label class="nd-field"><span class="nd-label">${h(label)}</span><input class="nd-input" name="${h(name)}" type="${type}" value="${h(value ?? "")}" ${extra}></label>`;
const one = (name, lang, label, value, large) =>
  `<label class="nd-field" data-lang="${lang}"><span class="nd-label">${h(label)} (${lang.toUpperCase()})</span>${large ? `<textarea class="nd-input" name="${name}.${lang}" rows="4" maxlength="4000">${h(value?.[lang] || "")}</textarea>` : `<input class="nd-input" name="${name}.${lang}" value="${h(value?.[lang] || "")}" maxlength="120">`}</label>`;
const bilingual = (name, label, value = loc(), large = false) => ["en", "fr"].map((lang) => one(name, lang, label, value, large)).join("");
const checkbox = (name, label, checked) =>
  `<label class="admin-check admin-check--lg"><input type="checkbox" name="${name}" ${checked ? "checked" : ""}> ${h(label)}</label>`;
function values(form) {
  const out = {};
  for (const [key, value] of new FormData(form)) {
    if (key.includes(".")) {
      const [name, lang] = key.split(".");
      (out[name] ||= {})[lang] = value;
    } else out[key] = value;
  }
  return out;
}
const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const ZONE = "Africa/Douala";
// Amounts as on the other admin screens ("30,000 FCFA"; "30 000 FCFA" in French).
const fcfa = (n) => n == null ? L("adminStorePriceTbc") : money(n);
// "Today 09:12", or the day ("8 Nov") for older orders, in Douala time.
const day = (value) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at), key = (d) => d.toLocaleDateString("en-CA", { timeZone: ZONE });
  if (key(date) === key(new Date())) return L("adminStoreToday", { time: date.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE }) });
  return date.toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE });
};
// A store promotion's free month on the order (#423). Staff see a guest's
// code once the router is collected, to write down or read out (owner, 24 Nov).
function freeMonthFact(o) {
  const b = o.bonus;
  if (!b) return "";
  const label = b.days === 30 ? L("adminStoreFreeMonth") : L("adminPromoColBonus");
  const legacy = b.rule === "payment_confirmation";
  const text = b.status === "reserved" && b.code
    ? L("adminStoreBonusCode", { code: b.code, phone: b.phone || "", day: day(b.startBy || b.endsAt) })
    : b.status === "given" ? L("adminPromoBonus_given", { day: day(b.startBy) })
      : b.status === "active" && b.endsAt ? L("adminPromoBonus_activeUntil", { day: day(b.endsAt) })
        : b.status === "pending" ? L(legacy ? "adminPromoBonus_pendingPaid" : "adminPromoBonus_pending")
          : b.status === "expired" && !legacy ? L("adminPromoBonus_expiredUnstarted") : L(`adminPromoBonus_${b.status}`);
  return `<div><dt>${h(label)}</dt><dd class="admin-store__bonus">${h(text)}</dd></div>`;
}
// An order's state on Store orders, worded and toned as on the canvas: paid
// orange, ready blue, collected green, refunded grey. A requested refund shows
// as refunded at once, as drawn; payment review (paid after the reservation
// lapsed) is red (owner, 25 Nov, #391).
const orderState = (o) => (o.refundStatus && o.refundStatus !== "failed" ? "refunded"
  : o.status === "preparing" ? "paid" : o.status === "awaiting_payment" ? "waiting" : o.status);
const TONES = { paid: "warning", waiting: "warning", ready: "info", collected: "success", review: "danger" };
const orderPill = (o) => {
  const state = orderState(o), tone = TONES[state];
  return `<span class="nd-pill admin-store__pill${tone ? " nd-pill--" + tone : ""}">${h(L("adminStoreState_" + state))}</span>`;
};
// Open orders: paid, ready, and payment review (owner, 25 Nov, #391); oldest
// first, as drawn, so the longest-waiting order is prepared first.
const OPEN = ["preparing", "ready", "review"];
// "Find an order" (kept by the owner, 25 Nov): every order, by state.
const FILTERS = ["all", "waiting", "paid", "ready", "review", "collected", "refunded", "cancelled", "expired"];
const named = (name) => (name && typeof name === "object" ? name[currentLanguage()] || name.en || "" : String(name || ""));
// An account holder by name; a guest by their masked number, as drawn.
const orderWho = (o) => (o.customerId ? o.contact.name : L("adminWhoGuest", { phone: maskPhone(o.contact.phone) }));
const orderMethod = (o) => paymentMethod({ network: o.network, provider: o.payment?.provider });
const HISTORY = { ready: "adminStoreDid_ready", collect: "adminStoreDid_collect", refund: "adminStoreDid_refund", cancel: "adminStoreDid_cancel", contact: "adminStoreDid_contact",
  notes: "adminStoreDid_notes", "rotate-link": "adminStoreDid_rotate", verify: "adminStoreDid_verify", "refund-reference": "adminStoreDid_reference" };
const when = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ZONE }) : "—";
};

export function mountStore(root, { call, role, csrf, heads = {}, setHead = () => {} }) {
  let state,
    view = "store",
    productId = "",
    orderFilter = "all",
    orderQuery = "",
    refundAsk = false,
    handled = new Set(),
    productQuery = "",
    selectedOrder = "",
    images = [],
    lang = "en",
    savedNotice = "",
    keepNotice = false,
    loading;
  root.innerHTML =
    `<button type="button" id="retryStore" class="nd-btn nd-btn--secondary" hidden>${h(L("adminStoreRetry"))}</button><p id="storeAdminMessage" class="nd-meta admin-store__message" role="status" aria-live="polite"></p><div id="storeAdminContent" class="admin-store"></div>`;
  const $ = (s) => root.querySelector(s),
    message = $("#storeAdminMessage"),
    content = $("#storeAdminContent");
  async function run(button, task) {
    if (button?.disabled) return;
    const label = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = L("adminSaving");
    }
    message.textContent = "";
    try {
      await task();
    } catch (e) {
      message.textContent = e.message;
    } finally {
      if (button?.isConnected) {
        button.disabled = false;
        button.textContent = label;
      }
    }
  }
  async function load() {
    if (loading) return loading;
    const retry = $("#retryStore");
    retry.hidden = true;
    message.textContent = L("adminStoreLoading");
    content.setAttribute("aria-busy", "true");
    loading = (async () => {
      try {
        state = await call("/api/admin/store");
        render();
        message.textContent = "";
      } catch (error) {
        retry.hidden = false;
        throw error;
      } finally {
        content.removeAttribute("aria-busy");
        loading = undefined;
      }
    })();
    return loading;
  }
  // Called by the dashboard when Store orders, Products or Edit product opens.
  function activate(nextView = view, param = "") {
    if ((nextView !== view || param !== productId) && !keepNotice) savedNotice = "";
    keepNotice = false;
    view = nextView;
    productId = param;
    if (!state) return run(null, load);
    render();
  }
  // `quiet`: the drawn quick controls show their own result (the switch, the
  // pill, the count), so they add no "Saved." line above the screen.
  async function save(path, input, { quiet = false } = {}) {
    const result = await call("/api/admin/store/" + path, {
      method: "POST",
      body: JSON.stringify(input),
    });
    state = result;
    render();
    if (!quiet) message.textContent = L("adminStoreSaved");
    return result;
  }
  function missingConfiguration() {
    const s = state.settings;
    return [
      ["contact", L("adminProductsMissingContact")],
      ["pickup", L("adminProductsMissingPickup")],
      ["warranty", L("adminProductsMissingWarranty")],
      ["returns", L("adminProductsMissingReturns")],
    ]
      .filter(([key]) =>
        typeof s[key] === "object"
          ? !s[key]?.en?.trim() || !s[key]?.fr?.trim()
          : !s[key]?.trim(),
      )
      .map(([, label]) => label);
  }
  function render() {
    if (!state) return;
    const views = { store: ordersView, products: productsView, product: productView };
    (views[view] || ordersView)();
  }

  // ---------- Store orders (canvas: AdminStore) ----------
  // The drawn screen: open orders beside the chosen order and its next step.
  // Kept by the owner (25 Nov, #391), collapsed below the two panels: "Find an
  // order" (every order, by state) and "More order actions".
  function ordersView() {
    if (heads.store) heads.store.innerHTML = `<a class="nd-btn nd-btn--secondary admin-store__headlink" href="/dashboard#products">${h(L("adminStoreProductsLink"))}</a>`;
    // A save redraws the screen; an open finder stays open.
    const finderOpen = document.getElementById("storeFinder")?.open;
    content.innerHTML = `<div class="admin-store__orders">
<div class="admin-store__side">
  <section class="nd-panel admin-store__list" aria-labelledby="storeOrdersTitle"><h2 class="admin-store__h" id="storeOrdersTitle">${h(L("adminStoreOpenOrders"))}</h2><div id="storeOrderRows"></div></section>
  <details class="admin-options admin-store__finder" id="storeFinder"><summary>${h(L("adminStoreFind"))}</summary><div class="admin-options__body">
    <div class="admin-store__finderbar"><label class="nd-visually-hidden" for="storeOrderStatus">${h(L("adminStoreFilter"))}</label><select id="storeOrderStatus" class="nd-input nd-input--sm">${FILTERS.map((id) => `<option value="${id}" ${orderFilter === id ? "selected" : ""}>${h(L(id === "all" ? "adminStoreAllOrders" : "adminStoreState_" + id))}</option>`).join("")}</select>
    <input type="search" id="storeOrderSearch" class="nd-input nd-input--sm" value="${h(orderQuery)}" placeholder="${h(L("adminStoreSearch"))}" aria-label="${h(L("adminStoreSearchLabel"))}"></div>
    <div id="storeFoundRows"></div></div></details>
</div>
<div class="admin-store__main">
  <section class="nd-panel admin-store__detail" id="orderEditor" aria-labelledby="storeOrderRef"></section>
  <div id="orderMore"></div>
</div></div>`;
    if (finderOpen) $("#storeFinder").open = true;
    $("#storeOrderStatus").onchange = (e) => { orderFilter = e.target.value; foundRows(); };
    $("#storeOrderSearch").oninput = (e) => { orderQuery = e.target.value; foundRows(); };
    orderRows();
  }
  const orderRow = (o) => `<button type="button" class="admin-order" data-order-pick="${h(o.id)}" aria-pressed="${o.id === selectedOrder}"><span class="admin-order__main"><strong>${h(o.reference)} · ${h(named(o.product.name))}</strong><span>${h(orderWho(o))} · ${h(day(o.createdAt))}</span></span>${orderPill(o)}</button>`;
  function pickRows(host) {
    host.querySelectorAll("[data-order-pick]").forEach((b) => {
      b.onclick = () => {
        selectedOrder = b.dataset.orderPick;
        refundAsk = false;
        root.querySelectorAll("[data-order-pick]").forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.orderPick === selectedOrder)));
        editOrder(state.orders.find((o) => o.id === selectedOrder));
      };
    });
  }
  function orderRows() {
    // An order handled on this visit stays in the list, in its new state, as drawn.
    const list = state.orders.filter((o) => OPEN.includes(o.status) || handled.has(o.id)).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    if (!state.orders.some((o) => o.id === selectedOrder)) selectedOrder = list[0]?.id || "";
    const rows = $("#storeOrderRows");
    rows.innerHTML = list.length ? list.map(orderRow).join("") : `<p class="nd-meta admin-store__empty" role="status">${h(L("adminStoreNoOpen"))}</p>`;
    pickRows(rows);
    foundRows();
    const chosen = state.orders.find((o) => o.id === selectedOrder);
    if (chosen) editOrder(chosen);
    else { $("#orderEditor").innerHTML = `<p class="nd-meta">${h(L("adminStoreChoose"))}</p>`; $("#orderMore").replaceChildren(); }
  }
  function foundRows() {
    const query = orderQuery.trim().toLowerCase();
    const list = state.orders.filter((o) => (orderFilter === "all" || orderState(o) === orderFilter) &&
      `${o.reference} ${o.contact.name} ${o.contact.phone}`.toLowerCase().includes(query)).slice(0, 50);
    const rows = $("#storeFoundRows");
    rows.innerHTML = list.length ? list.map(orderRow).join("") : `<p class="nd-meta" role="status">${h(L("adminStoreNoMatch"))}</p>`;
    pickRows(rows);
  }
  function editOrder(o) {
    selectedOrder = o.id;
    const owner = role === "owner", paid = o.paymentStatus === "paid", current = orderState(o), method = orderMethod(o), refund = o.payment.refund;
    const collected = [...(o.history || [])].reverse().find((e) => e.action === "collect");
    // The drawn refund: a paid order not yet handed over (owner, 25 Nov, #391).
    const canRefund = owner && paid && !refund && ["paid", "ready"].includes(current);
    const step = current === "paid"
      ? `<p class="admin-store__hint">${h(L("adminStorePaidHint"))}</p><button type="button" class="nd-btn nd-btn--block admin-store__go" data-order-action="ready">${h(L("adminStoreMarkReady"))}</button>`
      : current === "ready"
        ? `<form id="collectOrder" class="admin-store__collect"><div><label class="admin-store__label" for="storeCollectionCode">${h(L("adminStoreCodeLabel"))}</label><input class="admin-store__code" id="storeCollectionCode" name="collectionCode" inputmode="numeric" autocomplete="off" required></div><button class="nd-btn nd-btn--block admin-store__go">${h(L("adminStoreVerify"))}</button></form>`
        : current === "collected"
          ? `<p class="admin-store__done">${h(L("adminStoreHandedOver", { when: when(collected?.at) }))}</p>`
          : current === "refunded"
            ? `<p class="admin-store__refunded">${h(L(refund?.status === "completed" ? refund.restock ? "adminStoreRefundDoneStock" : "adminStoreRefundDone" : refund?.restock ? "adminStoreRefundSent" : "adminStoreRefundSentNoStock", { method }))}</p>`
            : "";
    const ask = canRefund && refundAsk
      ? `<div class="admin-store__confirm" role="alertdialog" aria-labelledby="storeRefundTitle" aria-describedby="storeRefundNote"><strong id="storeRefundTitle">${h(L("adminStoreRefundAsk", { method }))}</strong><span id="storeRefundNote">${h(L("adminStoreRefundWarn"))}</span><div class="admin-store__confirmrow"><button type="button" class="nd-btn nd-btn--secondary admin-store__go2" id="storeKeepOrder">${h(L("adminStoreKeepOrder"))}</button><button type="button" class="nd-btn nd-btn--danger-solid admin-store__go2" id="storeConfirmRefund">${h(L("adminStoreConfirmRefund"))}</button></div></div>`
      : canRefund ? `<button type="button" class="nd-btn nd-btn--secondary admin-store__go2 admin-store__refundbtn" id="storeAskRefund">${h(L("adminStoreRefundOwner"))}</button>` : "";
    $("#orderEditor").innerHTML = `<div class="admin-store__detailhead"><h2 class="admin-store__ref" id="storeOrderRef">${h(o.reference)}</h2>${orderPill(o)}</div>
<dl class="admin-store__facts"><div><dt>${h(L("adminStoreItem"))}</dt><dd>${h(L("adminStoreItemLine", { item: named(o.product.name), count: o.quantity }))}</dd></div><div><dt>${h(L("adminStoreCustomer"))}</dt><dd>${h(orderWho(o))}</dd></div>
<div><dt>${h(L("adminStorePaid"))}</dt><dd>${h(fcfa(o.amount))} · ${h(method)}</dd></div><div><dt>${h(L("adminStoreCollectAt"))}</dt><dd>${h(o.pickup || "—")}</dd></div>${freeMonthFact(o)}</dl>
${step}${ask}`;
    // Kept by the owner (25 Nov, #391): everything v1 can do with an order.
    const later = owner && paid && !refund && ["review", "collected"].includes(current);
    const more = document.getElementById("storeOrderMore"), moreOpen = more?.open && more.dataset.order === o.id;
    $("#orderMore").innerHTML = `<details class="admin-options admin-store__more" id="storeOrderMore" data-order="${h(o.id)}"${moreOpen ? " open" : ""}><summary>${h(L("adminStoreMore"))}</summary><div class="admin-options__body">
<div class="admin-store__actions">${o.receiptAvailable ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" id="adminStoreReceipt">${h(L("adminStoreReceipt"))}</button>` : ""}<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-order-action="verify">${h(L("adminStoreCheckProvider"))}</button>${!o.payment.confirmedAt && !["paid", "refund-pending", "refunded"].includes(o.paymentStatus) ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-order-action="cancel">${h(L("adminStoreCancelUnpaid"))}</button>` : ""}<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-order-action="rotate-link">${h(L("adminStoreReplaceLink"))}</button></div>
${later ? `<form id="refundOrder" class="admin-form admin-store__refundform" role="group" aria-labelledby="storeLaterRefund"><strong id="storeLaterRefund">${h(L("adminStoreRefundLater"))}</strong><span class="nd-meta">${h(L("adminStoreRefundLaterNote"))}</span>${field("reason", L("adminStoreRefundReason"), "", "text", 'required maxlength="300"')}${checkbox("restock", L("adminStoreRestock"), false)}<button class="nd-btn nd-btn--danger-solid">${h(L("adminStoreConfirmRefund"))}</button></form>` : ""}
<form id="orderNotes" class="admin-form">${field("serialNumbers", L("adminStoreSerials"), o.serialNumbers || "")}<label class="nd-field"><span class="nd-label">${h(L("adminStoreNotes"))}</span><textarea class="nd-input" name="notes" maxlength="2000">${h(o.notes || "")}</textarea></label><label class="nd-field"><span class="nd-label">${h(L("adminStoreReturnStatus"))}</span><select class="nd-input" name="returnStatus">${["none", "requested", "received", "resolved"].map((status) => `<option value="${status}" ${status === o.returnStatus ? "selected" : ""}>${h(L("adminStoreReturn_" + status))}</option>`).join("")}</select></label><button class="nd-btn nd-btn--secondary">${h(L("adminStoreSaveAfterSales"))}</button></form>
<form id="orderContact" class="admin-form">${field("name", L("adminStoreContactName"), o.contact.name, "text", 'required maxlength="120"')}${field("phone", L("adminStoreContactPhone"), o.contact.phone, "tel", "required")}${field("email", L("adminStoreContactEmail"), o.contact.email || "", "email")}<button class="nd-btn nd-btn--secondary">${h(L("adminStoreCorrectContact"))}</button></form>
${owner && refund?.status === "uncertain" && !refund.providerReference ? `<form id="refundReference" class="admin-form"><h3 class="nd-h3">${h(L("adminStoreReconcileTitle"))}</h3>${field("providerReference", L("adminStoreReconcileRef"), "", "text", 'required maxlength="200"')}<button class="nd-btn nd-btn--secondary">${h(L("adminStoreVerifyRef"))}</button></form>` : ""}
<h3 class="nd-h3">${h(L("adminStoreHistory"))}</h3>${(o.history || []).map((e) => `<p class="nd-meta">${h(when(e.at))} · ${h(HISTORY[e.action] ? L(HISTORY[e.action]) : e.action)} · ${h(e.actor)}</p>`).join("")}<p id="replacementLink"></p></div></details>`;
    const receiptButton = $("#adminStoreReceipt");
    if (receiptButton) receiptButton.onclick = (event) => run(event.currentTarget, async () => {
      const response = await fetch(window.NDAHI_CONFIG.apiUrl + "/api/admin/store/receipt", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf?.() || "" }, body: JSON.stringify({ orderId: o.id }) });
      if (!response.ok) { const body = await response.json(); throw Error(body.error || L("adminStoreReceiptFailed")); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `ndahi-store-receipt-${o.id}.pdf`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
    const update = async (action, input = {}) => {
      const result = await save("orders/update", { id: o.id, version: o.version, action, ...input });
      if (["ready", "collect", "refund"].includes(action)) handled.add(o.id);
      if (result.token) {
        message.textContent = L("adminStoreLinkReplaced", { url: (window.NDAHI_CONFIG.storeUrl || "https://store.ndahiconnect.net") + "/#order/" + o.id + "/" + result.token });
      } else {
        await load();
      }
    };
    root.querySelectorAll("[data-order-action]").forEach((b) => (b.onclick = () => run(b, async () => {
      if (b.dataset.orderAction === "rotate-link" && !confirm(L("adminStoreRotateConfirm"))) return;
      await update(b.dataset.orderAction);
    })));
    const askRefund = $("#storeAskRefund"), keep = $("#storeKeepOrder"), confirmRefund = $("#storeConfirmRefund");
    if (askRefund) askRefund.onclick = () => { refundAsk = true; editOrder(o); $("#storeKeepOrder")?.focus(); };
    if (keep) keep.onclick = () => { refundAsk = false; editOrder(o); $("#storeAskRefund")?.focus(); };
    if (confirmRefund) confirmRefund.onclick = () => run(confirmRefund, async () => {
      await update("refund", { beforeCollection: true });
      refundAsk = false;
    });
    const collect = $("#collectOrder");
    if (collect) collect.onsubmit = (e) => {
      e.preventDefault();
      // Staff may type the code as it is shown to the customer, "739 204".
      run(e.submitter, () => update("collect", { collectionCode: e.target.elements.collectionCode.value.replace(/\s+/g, "") }));
    };
    for (const [id, action] of [["orderNotes", "notes"], ["orderContact", "contact"], ["refundOrder", "refund"], ["refundReference", "refund-reference"]])
      if ($("#" + id)) $("#" + id).onsubmit = (e) => {
        e.preventDefault();
        run(e.submitter, async () => {
          if (action === "refund" && !confirm(L("adminStoreRefundConfirm"))) return;
          await update(action, { ...values(e.target), ...(action === "refund" ? { restock: e.target.elements.restock.checked } : {}) });
        });
      };
  }

  // ---------- Products (canvas: AdminProducts) ----------
  // The drawn screen: the checkout switch, then the catalogue with quick
  // stock and visibility. Kept by the owner (25 Nov, #388), collapsed below:
  // stock adjustments and history, categories and store settings.
  function productsView() {
    const s = state.settings;
    // A save redraws the screen; disclosures that were open stay open.
    const wasOpen = ["storeInventory", "storeCategories", "storeSettings"].filter((id) => document.getElementById(id)?.open);
    if (heads.products) heads.products.innerHTML = `<a class="nd-btn admin-products__add" href="/dashboard#product/new">${h(L("adminHomeAddProduct"))}</a>`;
    content.innerHTML = `<section class="admin-products__banner${s.open ? " is-open" : ""}" aria-label="${h(L("adminProductsCheckout"))}"><div><strong>${h(L(s.open ? "adminProductsOpen" : "adminProductsClosed"))}</strong><span>${h(L(s.open ? "adminProductsOpenHint" : "adminProductsClosedHint"))}</span></div><button type="button" id="toggleStoreCheckout" class="admin-products__switch" role="switch" aria-checked="${s.open}" aria-label="${h(L("adminProductsSwitch"))}"><span class="admin-products__knob"></span></button></section>
<section class="nd-panel admin-products" aria-labelledby="storeCatalogueTitle"><h2 class="admin-products__h" id="storeCatalogueTitle">${h(L("adminProductsCatalogue"))}</h2><div id="storeProductRows"></div><p class="admin-products__note">${h(L("adminProductsLedger"))}</p></section>
<details class="admin-options admin-store__more" id="storeInventory"><summary>${h(L("adminProductsStockMore"))}</summary><div class="admin-options__body" id="storeInventoryBody"></div></details>
<details class="admin-options admin-store__more" id="storeCategories"><summary>${h(L("adminProductsCategories"))}</summary><div class="admin-options__body" id="storeCategoriesBody"></div></details>
<details class="admin-options admin-store__more" id="storeSettings"><summary>${h(L("adminProductsSettings"))}</summary><div class="admin-options__body" id="storeSettingsBody"></div></details>`;
    wasOpen.forEach((id) => { $("#" + id).open = true; });
    // The switch asks before changing anything; the change is audited (#388).
    const toggle = $("#toggleStoreCheckout");
    toggle.onclick = () => run(null, async () => {
      if (!s.open) {
        const missing = missingConfiguration();
        if (missing.length) {
          $("#storeSettings").open = true;
          throw Error(L("adminProductsMissing", { items: missing.join(", ") }));
        }
      }
      if (!confirm(L(s.open ? "adminProductsConfirmClose" : "adminProductsConfirmOpen"))) return;
      toggle.disabled = true;
      try { await save("settings/save", { ...s, open: !s.open }, { quiet: true }); }
      finally { if (toggle.isConnected) toggle.disabled = false; }
      $("#toggleStoreCheckout")?.focus();
    });
    productRows();
    inventory();
    categories();
    settings();
  }
  // A name in the screen's language (product and category names are kept in both).
  const inLanguage = (name) => (name && typeof name === "object" ? name[currentLanguage()] || name.en || "" : String(name || ""));
  const categoryName = (id) => inLanguage(state.categories.find((c) => c.id === id)?.name) || L("adminProductsUncategorized");
  function productRows() {
    const list = state.products;
    $("#storeProductRows").innerHTML = !list.length ? `<p class="nd-meta">${h(L("adminProductsNone"))}</p>` :
      `<div class="nd-table-wrap"><table class="admin-products__table"><thead><tr><th scope="col">${h(L("adminProductsColProduct"))}</th><th scope="col">${h(L("adminProductsColSku"))}</th><th scope="col">${h(L("adminProductsColPrice"))}</th><th scope="col">${h(L("adminProductsColStock"))}</th><th scope="col">${h(L("adminProductsColShown"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminProductsEdit"))}</span></th></tr></thead><tbody>${list.map((p) => {
        const shown = p.status === "published", name = inLanguage(p.name);
        return `<tr><td><span class="admin-product"><span class="admin-product__thumb">${p.images?.[0] ? `<img src="${h(photoSrc(p.images[0]))}" alt="" width="40" height="40" loading="lazy">` : ""}</span><span><strong>${h(name)}</strong><span class="admin-product__cat">${h(categoryName(p.categoryId))}</span></span></span></td><td class="admin-products__sku">${h(p.sku)}</td><td>${h(fcfa(p.price))}</td><td><span class="admin-stepper"><button type="button" class="admin-stepper__btn" data-stock-delta="-1" data-stock-product="${h(p.id)}" aria-label="${h(L("adminProductsRemoveOne", { name }))}" ${p.available <= 0 ? "disabled" : ""}>−</button><strong class="${p.available <= 2 ? "is-low" : ""}" title="${h(L("adminProductsAvailableOf", { available: p.available, stock: p.stock }))}">${h(p.available)}</strong><button type="button" class="admin-stepper__btn" data-stock-delta="1" data-stock-product="${h(p.id)}" aria-label="${h(L("adminProductsAddOne", { name }))}">+</button></span></td><td><button type="button" class="admin-shown${shown ? " is-on" : ""}" aria-pressed="${shown}" data-toggle-shown="${h(p.id)}" aria-label="${h(L("adminProductsShownLabel", { name }))}">${h(L(shown ? "adminProductsShown" : "adminProductsHidden"))}</button></td><td><a class="admin-products__edit" href="/dashboard#product/${encodeURIComponent(p.id)}" aria-label="${h(L("adminProductsEditName", { name }))}">${h(L("adminProductsEdit"))}</a></td></tr>`;
      }).join("")}</tbody></table></div>`;
    // − / +: one unit, recorded in the stock ledger like any adjustment.
    root.querySelectorAll("[data-stock-delta]").forEach((b) => (b.onclick = () => run(b, async () => {
      const p = state.products.find((p) => p.id === b.dataset.stockProduct);
      await save("stock/adjust", { id: p.id, delta: Number(b.dataset.stockDelta), reason: "Quick change on Products", version: p.version, operationKey: crypto.randomUUID() }, { quiet: true });
    })));
    // Shown / Hidden: publishes the product or takes it out of the store. An
    // archived product is hidden; showing it publishes it again.
    root.querySelectorAll("[data-toggle-shown]").forEach((b) => (b.onclick = () => run(b, async () => {
      const p = state.products.find((p) => p.id === b.dataset.toggleShown);
      await save("products/save", { ...p, status: p.status === "published" ? "draft" : "published" }, { quiet: true });
    })));
  }
  function categories() {
    const w = $("#storeCategoriesBody");
    w.innerHTML = `<div class="admin-store__catlist">${state.categories.map((c) => `<div class="admin-row"><span><strong>${h(c.name.en)}</strong> / ${h(c.name.fr)} · ${h(L(c.hidden ? "adminProductsCatHidden" : "adminProductsCatVisible"))} · ${h(L("adminProductsCatPosition", { position: c.position }))}</span><span class="admin-actions"><button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-edit-category="${h(c.id)}">${h(L("adminProductsEdit"))}</button><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-delete-category="${h(c.id)}">${h(L("adminProductsDelete"))}</button></span></div>`).join("")}</div><button type="button" class="nd-btn nd-btn--secondary" id="newStoreCategory">${h(L("adminProductsAddCategory"))}</button><div id="categoryEditor"></div>`;
    const edit = (c) => {
      $("#categoryEditor").innerHTML =
        `<form id="categoryForm" class="admin-form">${bilingual("name", L("adminProductsCategoryName"), c.name)}${bilingual("shortName", L("adminProductsCategoryShort"), c.shortName)}${field("position", L("adminProductsSortPosition"), c.position, "number", 'min="0" max="1000"')}${checkbox("hidden", L("adminProductsHideCategory"), c.hidden)}<button class="nd-btn">${h(L("adminProductsSaveCategory"))}</button></form>`;
      $("#categoryForm").onsubmit = (e) => {
        e.preventDefault();
        run(e.submitter, () => save("categories/save", { ...values(e.target), id: c.id, version: c.version, position: Number(e.target.elements.position.value), hidden: e.target.elements.hidden.checked }));
      };
    };
    $("#newStoreCategory").onclick = () => edit({ name: loc(), shortName: loc(), position: 0, hidden: false });
    root.querySelectorAll("[data-edit-category]").forEach((b) => (b.onclick = () => edit(state.categories.find((c) => c.id === b.dataset.editCategory))));
    root.querySelectorAll("[data-delete-category]").forEach((b) => (b.onclick = () => run(b, async () => {
      if (!confirm(L("adminProductsDeleteCategory"))) return;
      const c = state.categories.find((c) => c.id === b.dataset.deleteCategory);
      await save("categories/delete", { id: c.id, version: c.version });
    })));
  }
  function inventory() {
    const w = $("#storeInventoryBody");
    w.innerHTML = `<h3 class="nd-h3">${h(L("adminProductsInventory"))}</h3><p class="nd-meta">${h(L("adminProductsInventoryNote"))}</p><form id="stockForm" class="admin-form"><label class="nd-field"><span class="nd-label">${h(L("adminProductsColProduct"))}</span><select class="nd-input" name="id" required>${state.products.map((p) => `<option value="${h(p.id)}">${h(L("adminProductsStockOption", { name: inLanguage(p.name), available: p.available, stock: p.stock }))}</option>`).join("")}</select></label>${field("delta", L("adminProductsQuantity"), 1, "number", 'required min="-1000000" max="1000000"')}${field("reason", L("adminProductsReason"), "", "text", 'required maxlength="300"')}<button class="nd-btn nd-btn--secondary" ${!state.products.length ? "disabled" : ""}>${h(L("adminProductsRecord"))}</button></form><h3 class="nd-h3">${h(L("adminProductsMovements"))}</h3><div class="nd-table-wrap"><table class="nd-table"><thead><tr><th scope="col">${h(L("adminProductsColWhen"))}</th><th scope="col">${h(L("adminProductsColProduct"))}</th><th scope="col">${h(L("adminProductsColChange"))}</th><th scope="col">${h(L("adminProductsColBalance"))}</th><th scope="col">${h(L("adminProductsColReason"))}</th></tr></thead><tbody>${state.movements.map((m) => `<tr><td>${h(new Date(m.at).toLocaleString(locale(), { timeZone: ZONE }))}</td><td>${h(inLanguage(state.products.find((p) => p.id === m.productId)?.name) || m.productId)}</td><td>${h(m.delta)}</td><td>${h(m.balance)}</td><td>${h(m.reason)} / ${h(m.actor)}</td></tr>`).join("")}</tbody></table></div>`;
    $("#stockForm").onsubmit = (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const input = values(e.target), p = state.products.find((p) => p.id === input.id), fingerprint = JSON.stringify([input.id, input.delta, input.reason]);
        let op;
        try { op = JSON.parse(sessionStorage.getItem("store-stock-operation")); } catch {}
        if (!op || op.fingerprint !== fingerprint) {
          op = { fingerprint, key: crypto.randomUUID() };
          sessionStorage.setItem("store-stock-operation", JSON.stringify(op));
        }
        await save("stock/adjust", { ...input, delta: Number(input.delta), version: p.version, operationKey: op.key });
        sessionStorage.removeItem("store-stock-operation");
        $("#storeInventory").open = true;
      });
    };
  }
  function settings() {
    const s = state.settings;
    $("#storeSettingsBody").innerHTML =
      `<p class="nd-meta">${h(L("adminProductsSettingsNote"))}</p><form id="storeSettingsForm" class="admin-form">${field("name", L("adminProductsStoreName"), s.name, "text", 'required maxlength="100"')}${bilingual("banner", L("adminProductsBanner"), s.banner, true)}${field("contact", L("adminProductsContact"), s.contact, "text", 'maxlength="300"')}<label class="nd-field"><span class="nd-label">${h(L("adminProductsPickup"))}</span><textarea class="nd-input" name="pickup" maxlength="1000">${h(s.pickup)}</textarea></label>${field("hours", L("adminProductsHours"), s.hours, "text", 'maxlength="300"')}${field("readyHoldDays", L("adminProductsHoldDays"), s.readyHoldDays ?? 14, "number", 'min="1" max="90" required')}${bilingual("warranty", L("adminProductsWarrantyPolicy"), s.warranty, true)}${bilingual("returns", L("adminProductsReturnsPolicy"), s.returns, true)}<button class="nd-btn">${h(L("adminProductsSaveSettings"))}</button></form>`;
    $("#storeSettingsForm").onsubmit = (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        await save("settings/save", { ...values(e.target), version: s.version, open: s.open });
        $("#storeSettings").open = true;
      });
    };
  }

  // ---------- Edit product (canvas: AdminProductEdit) ----------
  // The drawn screen: name and description in the language chosen (EN/FR),
  // photos, price and stock, visibility; Save product in the page head. Kept by
  // the owner (25 Nov, #387), collapsed in their panels: More product details,
  // Photo details (alternative text and order) and More settings (Featured,
  // internal cost, Delete product).
  const LANGS = ["en", "fr"];
  const inLang = (value) => (value && typeof value === "object" ? value[currentLanguage()] || value.en || "" : String(value || ""));
  // One field per language; the EN/FR switch shows one of them.
  const textField = (name, label, value, large = false) => LANGS.map((code) => `<div class="admin-pedit__field" data-lang="${code}"><label class="admin-pedit__label" for="product-${name}-${code}">${h(L(label, { language: L("adminProductEditLanguage_" + code) }))}</label>${large
    ? `<textarea class="admin-pedit__input admin-pedit__textarea" id="product-${name}-${code}" name="${name}.${code}" rows="4" maxlength="4000">${h(value?.[code] || "")}</textarea>`
    : `<input class="admin-pedit__input" id="product-${name}-${code}" name="${name}.${code}" value="${h(value?.[code] || "")}" maxlength="${name === "warranty" ? 3000 : name === "needs" ? 60 : 120}">`}</div>`).join("");
  // Key specs (ProductDesktop, #415; owner 26 Nov): short label/value rows for
  // the product page's spec table, up to 12, in the language chosen above.
  const specRow = (row = {}, n = 1) => `<li class="admin-pedit__spec" data-key-spec>${LANGS.map((code) => `<div class="admin-pedit__field admin-pedit__spec-field" data-lang="${code}"><label class="admin-pedit__label" for="spec-label-${n}-${code}">${h(L("adminProductEditKeySpecLabel", { language: L("adminProductEditLanguage_" + code) }))}</label><input class="admin-pedit__input" id="spec-label-${n}-${code}" data-spec-label="${code}" value="${h(row.label?.[code] || "")}" maxlength="40"></div><div class="admin-pedit__field admin-pedit__spec-field" data-lang="${code}"><label class="admin-pedit__label" for="spec-value-${n}-${code}">${h(L("adminProductEditKeySpecValue", { language: L("adminProductEditLanguage_" + code) }))}</label><input class="admin-pedit__input" id="spec-value-${n}-${code}" data-spec-value="${code}" value="${h(row.value?.[code] || "")}" maxlength="120"></div>`).join("")}<button type="button" class="nd-btn nd-btn--secondary nd-btn--compact admin-pedit__spec-remove" data-remove-key-spec aria-label="${h(L("adminProductEditKeySpecRemoveN", { n }))}">${h(L("adminProductEditKeySpecRemove"))}</button></li>`;
  const keySpecsEditor = (rows) => `<fieldset class="admin-pedit__specs" id="productKeySpecs"><legend class="admin-pedit__label">${h(L("adminProductEditKeySpecs"))}</legend><p class="nd-meta">${h(L("adminProductEditKeySpecsHint"))}</p><ol class="admin-pedit__spec-list">${rows.map((row, i) => specRow(row, i + 1)).join("")}</ol><button type="button" class="nd-btn nd-btn--secondary nd-btn--compact" data-add-key-spec ${rows.length >= 12 ? "disabled" : ""}>${h(L("adminProductEditKeySpecAdd"))}</button></fieldset>`;
  const keySpecsInput = (form) => [...form.querySelectorAll("[data-key-spec]")].map((li) => ({
    label: Object.fromEntries(LANGS.map((code) => [code, li.querySelector(`[data-spec-label="${code}"]`).value])),
    value: Object.fromEntries(LANGS.map((code) => [code, li.querySelector(`[data-spec-value="${code}"]`).value])),
  }));
  function productView() {
    const p = productId === "new" ? emptyProduct() : state.products.find((x) => x.id === productId);
    if (!p) { location.replace("/dashboard#products"); return; }
    images = structuredClone(p.images || []);
    setHead({ title: p.id ? inLang(p.name) || p.sku : L("adminProductEditNew") });
    if (heads.product) heads.product.innerHTML = `<span class="admin-saved admin-pedit__saved" role="status" aria-live="polite" id="storeSaved">${h(savedNotice)}</span><button type="submit" form="storeProductForm" class="nd-btn admin-pedit__save">${h(L("adminProductEditSave"))}</button>`;
    const shown = p.status === "published";
    content.innerHTML = `<form id="storeProductForm" class="admin-pedit">
<div class="admin-pedit__col admin-pedit__col--main">
  <section class="nd-panel admin-pedit__panel" aria-labelledby="productTextTitle"><div class="admin-pedit__panelhead"><h2 class="admin-pedit__h2" id="productTextTitle">${h(L("adminProductEditTextTitle"))}</h2><div class="admin-pedit__langs" role="tablist" aria-label="${h(L("adminProductEditLanguage"))}">${LANGS.map((code) => `<button type="button" role="tab" class="admin-pedit__lang" aria-selected="${lang === code}" data-product-lang="${code}">${code.toUpperCase()}</button>`).join("")}</div></div>
  ${textField("name", "adminProductEditName", p.name)}${textField("description", "adminProductEditDescription", p.description, true)}
  <details class="admin-options admin-pedit__more" id="productMoreDetails"><summary>${h(L("adminProductEditMoreDetails"))}</summary><div class="admin-options__body">${textField("specifications", "adminProductEditSpecifications", p.specifications, true)}${textField("compatibility", "adminProductEditCompatibility", p.compatibility, true)}${textField("contents", "adminProductEditContents", p.contents, true)}${textField("setup", "adminProductEditSetup", p.setup, true)}${textField("needs", "adminProductEditNeeds", p.needs)}${keySpecsEditor(p.keySpecs || [])}</div></details></section>
  <section class="nd-panel admin-pedit__panel" aria-labelledby="productPhotosTitle"><h2 class="admin-pedit__h2" id="productPhotosTitle">${h(L("adminProductEditPhotos"))}</h2><div id="storeImages" class="admin-pedit__photos"></div><p class="admin-pedit__caption">${h(L("adminProductEditPhotoTypes"))}</p>
  <details class="admin-options admin-pedit__more" id="productPhotoDetails"><summary>${h(L("adminProductEditPhotoDetails"))}</summary><div class="admin-options__body" id="storePhotoDetails"></div></details></section>
</div>
<div class="admin-pedit__col">
  <section class="nd-panel admin-pedit__panel" aria-labelledby="productPriceTitle"><h2 class="admin-pedit__h2" id="productPriceTitle">${h(L("adminProductEditPriceTitle"))}</h2>
  <div><label class="admin-pedit__label" for="productPrice">${h(L("adminProductEditPrice"))}</label><input class="admin-pedit__input" id="productPrice" name="price" type="number" value="${h(p.price ?? "")}" min="1" max="100000000" step="1" placeholder="${h(L("adminStorePriceTbc"))}"></div>
  <div><label class="admin-pedit__label" for="productSku">${h(L("adminProductEditSku"))}</label><input class="admin-pedit__input admin-pedit__sku" id="productSku" name="sku" value="${h(p.sku)}" required maxlength="80"></div>
  <div><label class="admin-pedit__label" for="productCategory">${h(L("adminProductEditCategory"))}</label><select class="admin-pedit__input" id="productCategory" name="categoryId"><option value="">${h(L("adminProductEditUncategorized"))}</option>${state.categories.map((c) => `<option value="${h(c.id)}" ${c.id === p.categoryId ? "selected" : ""}>${h(inLang(c.name))}</option>`).join("")}</select></div>
  ${p.id ? `<div class="admin-pedit__stock"><span>${h(L("adminProductEditInStock"))}</span><strong>${h(p.available)} · <a href="/dashboard#products">${h(L("adminProductEditAdjust"))}</a></strong></div>` : `<p class="admin-pedit__caption">${h(L("adminProductEditStockStarts"))}</p>`}</section>
  <section class="nd-panel admin-pedit__panel" aria-labelledby="productVisibilityTitle"><h2 class="admin-pedit__h2" id="productVisibilityTitle">${h(L("adminProductEditVisibility"))}</h2>
  <label class="admin-pedit__check"><input type="checkbox" name="shown" ${shown ? "checked" : ""}>${h(L("adminProductEditShow"))}</label>
  ${LANGS.map((code) => `<div class="admin-pedit__field" data-lang="${code}"><label class="admin-pedit__label" for="product-warranty-${code}">${h(L("adminProductEditWarranty"))}</label><input class="admin-pedit__input" id="product-warranty-${code}" name="warranty.${code}" value="${h(p.warranty?.[code] || "")}" maxlength="3000"></div>`).join("")}
  <details class="admin-options admin-pedit__more" id="productMoreSettings"><summary>${h(L("adminProductEditMoreSettings"))}</summary><div class="admin-options__body">${checkbox("featured", L("adminProductEditFeatured"), p.featured)}${role === "owner" ? field("cost", L("adminProductEditCost"), p.cost, "number", 'min="0" max="100000000"') : ""}${p.status === "archived" ? `<p class="nd-meta">${h(L("adminProductEditArchived"))}</p>` : ""}${p.id ? `<p class="admin-store__danger"><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-delete-product="${h(p.id)}">${h(L("adminProductEditDelete"))}</button></p>` : ""}</div></details></section>
</div></form>`;
    const tabs = root.querySelectorAll("[data-product-lang]");
    const showLang = (next) => {
      lang = next;
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.productLang === lang)));
      root.querySelectorAll("#storeProductForm [data-lang]").forEach((field) => { field.hidden = field.dataset.lang !== lang; });
    };
    tabs.forEach((t) => {
      t.onclick = () => showLang(t.dataset.productLang);
      // Arrow keys move between the two languages, as tabs do.
      t.onkeydown = (e) => {
        if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
        e.preventDefault();
        const next = lang === "en" ? "fr" : "en";
        showLang(next);
        root.querySelector(`[data-product-lang="${next}"]`).focus();
      };
    });
    showLang(lang);
    const specs = root.querySelector("#productKeySpecs");
    const renumber = () => {
      const rows = specs.querySelectorAll("[data-key-spec]");
      rows.forEach((li, i) => li.querySelector("[data-remove-key-spec]").setAttribute("aria-label", L("adminProductEditKeySpecRemoveN", { n: i + 1 })));
      specs.querySelector("[data-add-key-spec]").disabled = rows.length >= 12;
    };
    specs.onclick = (e) => {
      const remove = e.target.closest("[data-remove-key-spec]");
      if (remove) { remove.closest("[data-key-spec]").remove(); renumber(); specs.querySelector("[data-add-key-spec]").focus(); return; }
      if (!e.target.closest("[data-add-key-spec]")) return;
      const list = specs.querySelector("ol"), n = list.children.length + 1;
      list.insertAdjacentHTML("beforeend", specRow({}, n));
      showLang(lang);
      renumber();
      list.lastElementChild.querySelector(`[data-spec-label="${lang}"]`).focus();
    };
    renderImages();
    const del = root.querySelector("#productMoreSettings [data-delete-product]");
    if (del) del.onclick = () => run(del, async () => {
      if (!confirm(L("adminProductEditDeleteConfirm"))) return;
      await save("products/delete", { id: p.id, version: p.version });
      location.hash = "products";
    });
    $("#storeProductForm").onsubmit = (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const input = values(e.target), form = e.target.elements;
        const status = form.shown.checked ? "published" : p.status === "archived" ? "archived" : "draft";
        delete input.shown;
        await save("products/save", {
          ...input,
          id: p.id,
          version: p.version,
          price: input.price === "" ? null : Number(input.price),
          cost: Number(input.cost || 0),
          status,
          featured: form.featured.checked,
          keySpecs: keySpecsInput(e.target),
          // Stored photos by id; a photo saved inside the product before stays as it is.
          images: images.map(({ id, data, alt }) => (id ? { id, alt } : { data, alt })),
        }, { quiet: true });
        // As drawn, the result shows beside Save product, not above the screen.
        savedNotice = L(status === "published" ? "adminProductEditSavedLive" : "adminProductEditSavedHidden");
        const saved = p.id ? p : state.products.find((x) => x.sku.toLowerCase() === String(input.sku).trim().toLowerCase());
        if (!p.id && saved) { keepNotice = true; location.hash = "product/" + encodeURIComponent(saved.id); }
        else render();
      });
    };
  }
  // The drawn grid: the photos (the first is the main one), empty slots up to
  // three, then "+ Add". Photo details holds each photo's alternative text in
  // both languages, its order and Remove.
  function renderImages() {
    const full = images.length >= MAX_PRODUCT_IMAGES, slots = Math.max(3, images.length);
    const label = (index) => (index === 0 ? L("adminProductEditMainPhoto") : L("adminProductEditPhotoN", { n: index + 1 }));
    $("#storeImages").innerHTML = Array.from({ length: slots }, (_, index) => {
      const im = images[index], main = index === 0 ? " is-main" : "";
      return im ? `<div class="admin-pedit__slot is-photo${main}"><img src="${h(photoSrc(im))}" alt="${h(inLang(im.alt) || label(index))}" width="140" height="140" loading="lazy"></div>` : `<div class="admin-pedit__slot${main}">${h(label(index))}</div>`;
    }).join("") + `<label class="admin-pedit__slot admin-pedit__add admin-photos__add${full ? " is-full" : ""}"><input type="file" id="storeImageUpload" accept="image/png,image/jpeg,image/webp" ${full ? "disabled" : ""}><span>${h(full ? L("adminProductEditPhotosFull", { max: MAX_PRODUCT_IMAGES }) : L("adminProductEditAddPhoto"))}</span></label>`;
    $("#storePhotoDetails").innerHTML = images.length ? images.map((im, index) => `<fieldset class="admin-photo${index === 0 ? " is-main" : ""}"><legend>${h(label(index))}</legend><img src="${h(photoSrc(im))}" alt="" width="120" height="90" loading="lazy">${bilingual(`image${index}`, L("adminProductEditAltText"), im.alt)}<div class="admin-actions"><button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-image-up="${index}" ${index === 0 ? "disabled" : ""}>${h(L("adminProductEditMoveUp"))}</button><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-image-delete="${index}">${h(L("adminProductEditRemove"))}</button></div></fieldset>`).join("") : `<p class="nd-meta">${h(L("adminProductEditNoPhotos"))}</p>`;
    const details = $("#storePhotoDetails");
    details.querySelectorAll("input").forEach((input) => (input.oninput = () => {
      const [key, code] = input.name.split(".");
      images[Number(key.slice(5))].alt[code] = input.value;
    }));
    details.querySelectorAll("[data-image-up]").forEach((b) => (b.onclick = () => {
      const index = Number(b.dataset.imageUp);
      [images[index - 1], images[index]] = [images[index], images[index - 1]];
      renderImages();
    }));
    details.querySelectorAll("[data-image-delete]").forEach((b) => (b.onclick = () => {
      images.splice(Number(b.dataset.imageDelete), 1);
      renderImages();
    }));
    $("#storeImageUpload").onchange = (e) => run(null, async () => {
      const file = e.target.files[0];
      if (!file) return;
      const editImages = images;
      if (editImages.length >= MAX_PRODUCT_IMAGES) throw Error(L("adminProductEditTooMany", { max: MAX_PRODUCT_IMAGES }));
      if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8e6) throw Error(L("adminProductEditBadImage"));
      const bitmap = await createImageBitmap(file);
      const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      bitmap.close();
      let data = canvas.toDataURL("image/webp", 0.8);
      if (data.length > 230000) data = canvas.toDataURL("image/webp", 0.4);
      if (data.length > 230000) throw Error(L("adminProductEditTooDetailed"));
      // Each photo is uploaded on its own; the product refers to it when saved.
      message.textContent = L("adminProductEditUploading");
      const { photo } = await call("/api/admin/store/photos", { method: "POST", body: JSON.stringify({ data }) });
      message.textContent = "";
      // The editor or image count may have changed while the photo uploaded.
      if (!$("#storeImages") || images !== editImages) return;
      if (editImages.length >= MAX_PRODUCT_IMAGES) throw Error(L("adminProductEditTooMany", { max: MAX_PRODUCT_IMAGES }));
      editImages.push({ id: photo.id, src: photo.src, alt: loc() });
      renderImages();
    });
  }
  $("#retryStore").onclick = (e) => run(e.currentTarget, load);
  return { load, activate };
}
