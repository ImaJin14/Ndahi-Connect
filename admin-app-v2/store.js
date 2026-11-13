// Redesigned store management (admin-app-v2), three canvas screens over v1's
// store API and logic:
//   #store       Store orders (AdminStore): open orders beside the chosen order
//   #products    Products (AdminProducts): checkout banner, catalogue with quick
//                stock and visibility, then stock ledger, categories, settings
//   #product/id  Edit product (AdminProductEdit): EN/FR details, photos, price
//                and stock, visibility; Save product in the page head
// The store launches in English, so these screens are English like v1's.
import { escapeHtml as h } from "/shared/safe-html.js";
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
const fcfa = (n) => n == null ? "Price to be confirmed" : `${Number(n).toLocaleString()} FCFA`;
const day = (value) => {
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return "—";
  const date = new Date(at), today = new Date().toDateString() === date.toDateString();
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "Africa/Douala" });
  return today ? `Today ${time}` : date.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Douala" });
};
// Order pills, worded as on the canvas.
const ORDER = {
  awaiting_payment: ["Waiting for payment", "warning"], preparing: ["Paid · to prepare", "warning"], ready: ["Ready to collect", "info"],
  collected: ["Collected", "success"], review: ["Payment review", "danger"], cancelled: ["Cancelled", ""], expired: ["Expired", ""],
};
const orderPill = (o) => {
  const [label, tone] = o.refundStatus ? [`Refund ${o.refundStatus}`, ""] : ORDER[o.status] || [String(o.status || "—").replace(/_/g, " "), ""];
  return `<span class="nd-pill${tone ? " nd-pill--" + tone : ""}">${h(label)}</span>`;
};
const FILTERS = [
  ["open", "Open orders"], ["all", "All orders"], ["preparing", "To prepare"], ["ready", "Ready to collect"], ["review", "Payment review"],
  ["awaiting_payment", "Waiting for payment"], ["collected", "Collected"], ["cancelled", "Cancelled"], ["expired", "Expired"],
];
const OPEN = ["awaiting_payment", "preparing", "ready", "review"];

export function mountStore(root, { call, role, csrf, heads = {}, setHead = () => {} }) {
  let state,
    view = "store",
    productId = "",
    orderFilter = "open",
    orderQuery = "",
    productQuery = "",
    selectedOrder = "",
    images = [],
    lang = "en",
    savedNotice = "",
    keepNotice = false,
    loading;
  root.innerHTML =
    '<button type="button" id="retryStore" class="nd-btn nd-btn--secondary" hidden>Retry loading store</button><p id="storeAdminMessage" class="nd-meta admin-store__message" role="status" aria-live="polite"></p><div id="storeAdminContent" class="admin-store"></div>';
  const $ = (s) => root.querySelector(s),
    message = $("#storeAdminMessage"),
    content = $("#storeAdminContent");
  async function run(button, task) {
    if (button?.disabled) return;
    const label = button?.textContent;
    if (button) {
      button.disabled = true;
      button.textContent = "Saving…";
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
    message.textContent = "Loading store management…";
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
  async function save(path, input) {
    const result = await call("/api/admin/store/" + path, {
      method: "POST",
      body: JSON.stringify(input),
    });
    state = result;
    render();
    message.textContent = "Saved.";
    return result;
  }
  function missingConfiguration() {
    const s = state.settings;
    return [
      ["contact", "Contact details"],
      ["pickup", "Pickup location"],
      ["warranty", "Warranty in EN and FR"],
      ["returns", "Returns in EN and FR"],
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
  function ordersView() {
    if (heads.store) heads.store.innerHTML = '<a class="nd-btn nd-btn--secondary" href="/dashboard#products">Products &amp; stock</a>';
    content.innerHTML = `<div class="admin-store__orders">
<section class="nd-panel admin-store__list" aria-labelledby="storeOrdersTitle">
  <div class="admin-store__listhead"><h2 class="admin-store__h" id="storeOrdersTitle">${h((FILTERS.find(([id]) => id === orderFilter) || FILTERS[0])[1])}</h2>
  <label class="nd-visually-hidden" for="storeOrderStatus">Order status</label><select id="storeOrderStatus" class="nd-input nd-input--sm">${FILTERS.map(([value, label]) => `<option value="${value}" ${orderFilter === value ? "selected" : ""}>${label}</option>`).join("")}</select>
  <input type="search" id="storeOrderSearch" class="nd-input nd-input--sm" value="${h(orderQuery)}" placeholder="Reference, customer or phone" aria-label="Search orders"></div>
  <div id="storeOrderRows"></div>
</section>
<section class="nd-panel admin-store__detail" id="orderEditor" aria-live="polite"></section></div>`;
    $("#storeOrderStatus").onchange = (e) => {
      orderFilter = e.target.value;
      $("#storeOrdersTitle").textContent = (FILTERS.find(([id]) => id === orderFilter) || FILTERS[0])[1];
      orderRows();
    };
    $("#storeOrderSearch").oninput = (e) => {
      orderQuery = e.target.value;
      orderRows();
    };
    orderRows();
  }
  function orderRows() {
    const list = state.orders.filter(
      (o) =>
        (orderFilter === "all" || (orderFilter === "open" ? OPEN.includes(o.status) : o.status === orderFilter)) &&
        `${o.reference} ${o.contact.name} ${o.contact.phone}`
          .toLowerCase()
          .includes(orderQuery.toLowerCase()),
    );
    const chosen = list.find((o) => o.id === selectedOrder) || list[0];
    $("#storeOrderRows").innerHTML = !list.length
      ? '<p class="store-empty nd-meta" role="status">No orders match this view.</p>'
      : list.map((o) => `<button type="button" class="admin-order" data-order-pick="${h(o.id)}" aria-pressed="${o === chosen}"><span class="admin-order__main"><strong>${h(o.reference)} · ${h(o.product.name.en)}</strong><span>${h(o.contact.name)} · ${h(day(o.createdAt))}</span></span>${orderPill(o)}</button>`).join("");
    root.querySelectorAll("[data-order-pick]").forEach((b) => {
      b.onclick = () => {
        selectedOrder = b.dataset.orderPick;
        root.querySelectorAll("[data-order-pick]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
        editOrder(state.orders.find((o) => o.id === selectedOrder));
      };
    });
    if (chosen) editOrder(chosen);
    else $("#orderEditor").innerHTML = '<p class="nd-meta">Choose an order to see it here.</p>';
  }
  function editOrder(o) {
    selectedOrder = o.id;
    const owner = role === "owner", paid = o.paymentStatus === "paid";
    const step = o.status === "preparing" && paid
      ? `<p class="admin-store__hint">Test the device, pack it, then mark it ready to collect.</p><button type="button" class="nd-btn" data-order-action="ready">Mark ready to collect</button>`
      : o.status === "ready"
        ? `<form id="collectOrder" class="admin-form"><label class="nd-field"><span class="nd-label">Customer's collection code</span><input class="nd-input admin-store__code" name="collectionCode" inputmode="numeric" autocomplete="off" required></label><button class="nd-btn">Verify code and hand over</button></form>`
        : o.status === "collected"
          ? `<p class="nd-callout nd-callout--success admin-callout">Code verified and handed over — logged to the audit trail.</p>`
          : "";
    $("#orderEditor").innerHTML = `<div class="admin-store__detailhead"><h2 class="nd-h2">${h(o.reference)}</h2>${orderPill(o)}</div>
<dl class="admin-store__facts"><div><dt>Item</dt><dd>${h(o.product.name.en)} × ${h(o.quantity)}</dd></div><div><dt>Customer</dt><dd>${h(o.contact.name)} · ${h(o.contact.phone)}${o.contact.email ? " · " + h(o.contact.email) : ""}</dd></div>
<div><dt>Paid</dt><dd>${h(fcfa(o.amount))} · ${h(o.paymentStatus)}${o.payment.refund ? ` (refund: ${h(o.payment.refund.status)})` : ""}</dd></div><div><dt>Collect at</dt><dd>${h(o.pickup || "—")}${o.hours ? " · " + h(o.hours) : ""}</dd></div></dl>
${step}
${owner && paid && !o.payment.refund ? `<details class="admin-store__refund"><summary class="nd-btn nd-btn--secondary admin-btn--danger">Refund (owner only)</summary><form id="refundOrder" class="admin-form admin-store__refundform" role="group" aria-label="Refund the full amount"><strong>Refund the full amount?</strong><span class="nd-meta">The order is cancelled. Stock comes back only after the refund is confirmed and you tick the box below.</span>${field("reason", "Refund reason", "", "text", 'required maxlength="300"')}${checkbox("restock", "Equipment is unsent or physically returned and can be restocked", false)}<button class="nd-btn nd-btn--danger-solid">Confirm refund</button></form></details>` : ""}
<details class="admin-options"><summary>More order actions</summary><div class="admin-options__body">
<div class="admin-store__actions">${o.receiptAvailable ? '<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" id="adminStoreReceipt">Download store receipt</button>' : ""}<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-order-action="verify">Check provider payment</button>${!o.payment.confirmedAt && !["paid", "refund-pending", "refunded"].includes(o.paymentStatus) ? '<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-order-action="cancel">Cancel unpaid order</button>' : ""}<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-order-action="rotate-link">Replace tracking link</button></div>
<form id="orderNotes" class="admin-form">${field("serialNumbers", "Serial numbers", o.serialNumbers || "")}<label class="nd-field"><span class="nd-label">Support / warranty notes</span><textarea class="nd-input" name="notes" maxlength="2000">${h(o.notes || "")}</textarea></label><label class="nd-field"><span class="nd-label">Return status</span><select class="nd-input" name="returnStatus">${["none", "requested", "received", "resolved"].map((status) => `<option ${status === o.returnStatus ? "selected" : ""}>${status}</option>`).join("")}</select></label><button class="nd-btn nd-btn--secondary">Save after-sales details</button></form>
<form id="orderContact" class="admin-form">${field("name", "Order contact name", o.contact.name, "text", 'required maxlength="120"')}${field("phone", "Order contact phone", o.contact.phone, "tel", "required")}${field("email", "Order contact email", o.contact.email || "", "email")}<button class="nd-btn nd-btn--secondary">Correct order contact</button></form>
${owner && o.payment.refund?.status === "uncertain" && !o.payment.refund.providerReference ? `<form id="refundReference" class="admin-form"><h3 class="nd-h3">Reconcile uncertain refund</h3>${field("providerReference", "Reference verified in the provider dashboard", "", "text", 'required maxlength="200"')}<button class="nd-btn nd-btn--secondary">Verify refund reference</button></form>` : ""}
<h3 class="nd-h3">Order history</h3>${o.history.map((e) => `<p class="nd-meta">${h(e.at)} · ${h(e.action)} · ${h(e.actor)}</p>`).join("")}<p id="replacementLink"></p></div></details>`;
    const receiptButton = $("#adminStoreReceipt");
    if (receiptButton) receiptButton.onclick = (event) => run(event.currentTarget, async () => {
      const response = await fetch(window.NDAHI_CONFIG.apiUrl + "/api/admin/store/receipt", { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf?.() || "" }, body: JSON.stringify({ orderId: o.id }) });
      if (!response.ok) { const body = await response.json(); throw Error(body.error || "Receipt unavailable."); }
      const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
      link.href = url; link.download = `ndahi-store-receipt-${o.id}.pdf`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
    });
    const update = async (action, input = {}) => {
      const result = await save("orders/update", {
        id: o.id,
        version: o.version,
        action,
        ...input,
      });
      if (result.token) {
        message.textContent =
          "Replacement link created. The previous link no longer works. Share privately with the verified buyer: " +
          (window.NDAHI_CONFIG.storeUrl || "https://store.ndahiconnect.net") +
          "/#order/" +
          o.id +
          "/" +
          result.token;
      } else {
        await load();
      }
    };
    root.querySelectorAll("[data-order-action]").forEach(
      (b) =>
        (b.onclick = () =>
          run(b, async () => {
            if (
              b.dataset.orderAction === "rotate-link" &&
              !confirm(
                "Revoke the previous tracking link and issue a replacement for the verified buyer?",
              )
            )
              return;
            await update(b.dataset.orderAction);
          })),
    );
    for (const [id, action] of [
      ["collectOrder", "collect"],
      ["orderNotes", "notes"],
      ["orderContact", "contact"],
      ["refundOrder", "refund"],
      ["refundReference", "refund-reference"],
    ])
      if ($("#" + id))
        $("#" + id).onsubmit = (e) => {
          e.preventDefault();
          run(e.submitter, async () => {
            if (action === "refund" && !confirm("Authorize this full refund? The order is cancelled and this can't be undone."))
              return;
            await update(action, {
              ...values(e.target),
              ...(action === "refund"
                ? { restock: e.target.elements.restock.checked }
                : {}),
            });
          });
        };
  }

  // ---------- Products (canvas: AdminProducts) ----------
  function productsView() {
    const s = state.settings, missing = missingConfiguration();
    // A save redraws the screen; disclosures that were open stay open.
    const wasOpen = ["storeInventory", "storeCategories", "storeSettings"].filter((id) => document.getElementById(id)?.open);
    if (heads.products) heads.products.innerHTML = `<a class="admin-link" href="https://store.ndahiconnect.net" target="_blank" rel="noopener">View storefront ↗</a><button type="button" id="refreshStore" class="nd-btn nd-btn--secondary">Refresh</button><a class="nd-btn" href="/dashboard#product/new">Add product</a>`;
    content.innerHTML = `<section class="admin-store__banner${s.open ? " is-open" : ""}" aria-label="Checkout status"><div class="admin-store__bannertext"><strong>Store checkout is ${s.open ? "open" : "closed"}</strong><p id="storeCheckoutStatus" role="status" class="store-state ${s.open ? "is-open" : ""}">${s.open ? "Open — accepting new orders" : "Closed — new orders paused"}</p><span class="nd-meta">${s.open ? "Customers and guests can pay. Close checkout to pause new orders." : "Products stay visible but nobody can pay until you reopen. Approve policies and finish payment and device testing first."}</span>${missing.length ? `<p class="store-setup-note">Configuration missing: ${h(missing.join(", "))}.</p>` : ""}</div><button type="button" id="toggleStoreCheckout" class="admin-switch${s.open ? " is-on" : ""}" ${!s.open && missing.length ? "disabled" : ""}><span class="admin-switch__track" aria-hidden="true"><span class="admin-switch__knob"></span></span><span>${s.open ? "Close checkout" : "Open checkout"}</span></button></section>
<section class="nd-panel admin-store__catalogue" aria-labelledby="storeCatalogueTitle"><div class="nd-panel__head"><h2 class="nd-h2" id="storeCatalogueTitle">Catalogue</h2><input type="search" id="storeSearch" class="nd-input nd-input--sm" value="${h(productQuery)}" placeholder="Name or SKU" aria-label="Search catalogue"></div><div id="storeProductRows"></div><p class="nd-meta admin-store__note">Every stock change is recorded in the inventory ledger with who made it.</p></section>
<details class="admin-options admin-store__more" id="storeInventory"><summary>Stock adjustments and history</summary><div class="admin-options__body" id="storeInventoryBody"></div></details>
<details class="admin-options admin-store__more" id="storeCategories"><summary>Categories</summary><div class="admin-options__body" id="storeCategoriesBody"></div></details>
<details class="admin-options admin-store__more" id="storeSettings"><summary>Store settings</summary><div class="admin-options__body" id="storeSettingsBody"></div></details>`;
    wasOpen.forEach((id) => { $("#" + id).open = true; });
    const toggle = $("#toggleStoreCheckout");
    toggle.onclick = (e) =>
      run(e.currentTarget, async () => {
        if (
          !s.open &&
          !confirm(
            "Open checkout for new purchases? Confirm approved policies, accurate stock and prices, pickup details, and completed payment/device acceptance testing.",
          )
        )
          return;
        await save("settings/save", { ...s, open: !s.open });
        message.textContent = state.settings.open
          ? "Checkout opened."
          : "Checkout closed. Existing orders can still be managed.";
      });
    const refresh = document.getElementById("refreshStore");
    if (refresh) refresh.onclick = (e) => run(e.currentTarget, load);
    $("#storeSearch").oninput = (e) => {
      productQuery = e.target.value;
      productRows();
    };
    productRows();
    inventory();
    categories();
    settings();
  }
  function productRows() {
    const list = state.products.filter((p) =>
      `${p.name.en} ${p.name.fr} ${p.sku}`
        .toLowerCase()
        .includes(productQuery.toLowerCase()),
    );
    const category = (id) => state.categories.find((c) => c.id === id)?.name.en || "Uncategorized";
    $("#storeProductRows").innerHTML = !list.length ? '<p class="nd-meta">No products yet.</p>' :
      `<div class="nd-table-wrap"><table class="nd-table"><thead><tr><th scope="col">Product</th><th scope="col">SKU</th><th scope="col">Price</th><th scope="col">In stock</th><th scope="col">Shown in store</th><th scope="col"><span class="nd-visually-hidden">Actions</span></th></tr></thead><tbody>${list.map((p) => {
        const shown = p.status === "published";
        return `<tr><td><span class="admin-product"><span class="admin-product__thumb">${p.images?.[0]?.data ? `<img src="${h(p.images[0].data)}" alt="" width="40" height="40">` : ""}</span><span><strong>${h(p.name.en)}</strong><span class="admin-cell__sub">${h(category(p.categoryId))}</span></span></span></td><td class="admin-code admin-store__sku">${h(p.sku)}</td><td>${h(fcfa(p.price))}</td><td><span class="admin-stepper"><button type="button" class="admin-stepper__btn" data-stock-delta="-1" data-stock-product="${h(p.id)}" aria-label="Remove one ${h(p.name.en)}" ${p.available <= 0 ? "disabled" : ""}>−</button><strong class="${p.available <= 2 ? "is-low" : ""}" title="${h(p.available)} available of ${h(p.stock)} in stock">${h(p.available)}</strong><button type="button" class="admin-stepper__btn" data-stock-delta="1" data-stock-product="${h(p.id)}" aria-label="Add one ${h(p.name.en)}">+</button></span></td><td><button type="button" class="admin-shown${shown ? " is-on" : ""}" aria-pressed="${shown}" data-toggle-shown="${h(p.id)}" aria-label="Shown in store: ${h(p.name.en)}">${shown ? "Shown" : p.status === "archived" ? "Archived" : "Hidden"}</button></td><td><span class="admin-actions"><a class="nd-btn nd-btn--compact nd-btn--secondary" href="/dashboard#product/${encodeURIComponent(p.id)}" aria-label="Edit ${h(p.name.en)}">Edit</a><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-delete-product="${h(p.id)}">Delete</button></span></td></tr>`;
      }).join("")}</tbody></table></div>`;
    root.querySelectorAll("[data-delete-product]").forEach(
      (b) =>
        (b.onclick = () =>
          run(b, async () => {
            if (
              confirm(
                "Delete this product? Products with history must be archived instead.",
              )
            ) {
              const p = state.products.find(
                (p) => p.id === b.dataset.deleteProduct,
              );
              await save("products/delete", { id: p.id, version: p.version });
            }
          })),
    );
    // − / +: one unit, recorded in the stock ledger like any adjustment.
    root.querySelectorAll("[data-stock-delta]").forEach(
      (b) =>
        (b.onclick = () =>
          run(b, async () => {
            const p = state.products.find((p) => p.id === b.dataset.stockProduct);
            await save("stock/adjust", { id: p.id, delta: Number(b.dataset.stockDelta), reason: "Quick change on Products", version: p.version, operationKey: crypto.randomUUID() });
          })),
    );
    // Shown / Hidden: publishes the product or returns it to draft.
    root.querySelectorAll("[data-toggle-shown]").forEach(
      (b) =>
        (b.onclick = () =>
          run(b, async () => {
            const p = state.products.find((p) => p.id === b.dataset.toggleShown);
            await save("products/save", { ...p, status: p.status === "published" ? "draft" : "published" });
          })),
    );
  }
  function categories() {
    const w = $("#storeCategoriesBody");
    w.innerHTML = `<div class="admin-store__catlist">${state.categories.map((c) => `<div class="admin-row"><span><strong>${h(c.name.en)}</strong> / ${h(c.name.fr)} · ${c.hidden ? "Hidden" : "Visible"} · position ${h(c.position)}</span><span class="admin-actions"><button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-edit-category="${h(c.id)}">Edit</button><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-delete-category="${h(c.id)}">Delete</button></span></div>`).join("")}</div><button type="button" class="nd-btn nd-btn--secondary" id="newStoreCategory">Add category</button><div id="categoryEditor"></div>`;
    const edit = (c) => {
      $("#categoryEditor").innerHTML =
        `<form id="categoryForm" class="admin-form">${bilingual("name", "Category name", c.name)}${field("position", "Sort position", c.position, "number", 'min="0" max="1000"')}${checkbox("hidden", "Hide category and its products", c.hidden)}<button class="nd-btn">Save category</button></form>`;
      $("#categoryForm").onsubmit = (e) => {
        e.preventDefault();
        run(e.submitter, () =>
          save("categories/save", {
            ...values(e.target),
            id: c.id,
            version: c.version,
            position: Number(e.target.elements.position.value),
            hidden: e.target.elements.hidden.checked,
          }),
        );
      };
    };
    $("#newStoreCategory").onclick = () =>
      edit({ name: loc(), position: 0, hidden: false });
    root
      .querySelectorAll("[data-edit-category]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            edit(
              state.categories.find((c) => c.id === b.dataset.editCategory),
            )),
      );
    root.querySelectorAll("[data-delete-category]").forEach(
      (b) =>
        (b.onclick = () =>
          run(b, async () => {
            if (confirm("Delete this category?")) {
              const c = state.categories.find(
                (c) => c.id === b.dataset.deleteCategory,
              );
              await save("categories/delete", { id: c.id, version: c.version });
            }
          })),
    );
  }
  function inventory() {
    const w = $("#storeInventoryBody");
    w.innerHTML = `<h3 class="nd-h3">Inventory</h3><p class="nd-meta">Available stock excludes active reservations. Use negative quantities for removals. Every adjustment is recorded.</p><form id="stockForm" class="admin-form"><label class="nd-field"><span class="nd-label">Product</span><select class="nd-input" name="id" required>${state.products.map((p) => `<option value="${h(p.id)}">${h(p.name.en)} — ${h(p.available)} available / ${h(p.stock)} in stock</option>`).join("")}</select></label>${field("delta", "Quantity to add or remove", 1, "number", 'required min="-1000000" max="1000000"')}${field("reason", "Reason", "", "text", 'required maxlength="300"')}<button class="nd-btn nd-btn--secondary" ${!state.products.length ? "disabled" : ""}>Record adjustment</button></form><h3 class="nd-h3">Recent stock movements</h3><div class="nd-table-wrap"><table class="nd-table"><thead><tr><th scope="col">When</th><th scope="col">Product</th><th scope="col">Change</th><th scope="col">Balance</th><th scope="col">Reason / actor</th></tr></thead><tbody>${state.movements.map((m) => `<tr><td>${h(new Date(m.at).toLocaleString())}</td><td>${h(state.products.find((p) => p.id === m.productId)?.name.en || m.productId)}</td><td>${h(m.delta)}</td><td>${h(m.balance)}</td><td>${h(m.reason)} / ${h(m.actor)}</td></tr>`).join("")}</tbody></table></div>`;
    $("#stockForm").onsubmit = (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        const input = values(e.target),
          p = state.products.find((p) => p.id === input.id),
          fingerprint = JSON.stringify([input.id, input.delta, input.reason]);
        let op;
        try {
          op = JSON.parse(sessionStorage.getItem("store-stock-operation"));
        } catch {}
        if (!op || op.fingerprint !== fingerprint) {
          op = { fingerprint, key: crypto.randomUUID() };
          sessionStorage.setItem("store-stock-operation", JSON.stringify(op));
        }
        await save("stock/adjust", {
          ...input,
          delta: Number(input.delta),
          version: p.version,
          operationKey: op.key,
        });
        sessionStorage.removeItem("store-stock-operation");
        $("#storeInventory").open = true;
      });
    };
  }
  function settings() {
    const s = state.settings;
    $("#storeSettingsBody").innerHTML =
      `<p class="nd-meta">Saved content appears in the store without a code deployment. Configure pickup and policies before opening checkout.</p><form id="storeSettingsForm" class="admin-form">${field("name", "Store name", s.name, "text", 'required maxlength="100"')}${bilingual("introduction", "Introduction", s.introduction, true)}${bilingual("banner", "Announcement banner", s.banner, true)}${field("contact", "Public contact details", s.contact, "text", 'maxlength="300"')}<label class="nd-field"><span class="nd-label">Pickup location and instructions</span><textarea class="nd-input" name="pickup" maxlength="1000">${h(s.pickup)}</textarea></label>${field("hours", "Pickup hours", s.hours, "text", 'maxlength="300"')}${bilingual("warranty", "Warranty policy", s.warranty, true)}${bilingual("returns", "Returns and refund policy", s.returns, true)}<button class="nd-btn">Save store settings</button></form>`;
    $("#storeSettingsForm").onsubmit = (e) => {
      e.preventDefault();
      run(e.submitter, async () => {
        await save("settings/save", {
          ...values(e.target),
          version: s.version,
          open: s.open,
        });
        $("#storeSettings").open = true;
      });
    };
  }

  // ---------- Edit product (canvas: AdminProductEdit) ----------
  function productView() {
    const p = productId === "new" ? emptyProduct() : state.products.find((x) => x.id === productId);
    if (!p) { location.replace("/dashboard#products"); return; }
    images = structuredClone(p.images || []);
    setHead({ title: p.id ? p.name.en || p.sku : "New product" });
    if (heads.product) heads.product.innerHTML = `<span class="admin-saved" role="status" aria-live="polite" id="storeSaved">${h(savedNotice)}</span><button type="submit" form="storeProductForm" class="nd-btn">Save product</button>`;
    const shown = p.status === "published";
    content.innerHTML = `<form id="storeProductForm" class="admin-store__product">
<div class="admin-store__col admin-store__col--main">
  <section class="nd-panel admin-store__panel admin-store__textpanel" aria-labelledby="productTextTitle"><div class="admin-store__panelhead"><h2 class="nd-h2" id="productTextTitle">Name and description</h2><div class="nd-segmented" role="tablist" aria-label="Language">${[["en", "EN"], ["fr", "FR"]].map(([id, label]) => `<button type="button" role="tab" class="nd-segmented__option" aria-selected="${lang === id}" data-product-lang="${id}">${label}</button>`).join("")}</div></div>
  ${bilingual("name", "Name", p.name)}${bilingual("description", "Description", p.description, true)}
  <details class="admin-options"><summary>More product details</summary><div class="admin-options__body">${["specifications", "compatibility", "contents", "setup"].map((key) => bilingual(key, key[0].toUpperCase() + key.slice(1), p[key], true)).join("")}</div></details></section>
  <section class="nd-panel admin-store__panel" aria-labelledby="productPhotosTitle"><h2 class="nd-h2" id="productPhotosTitle">Photos</h2><div id="storeImages" class="admin-photos"></div>
  <label class="admin-photos__add"><input type="file" id="storeImageUpload" accept="image/png,image/jpeg,image/webp"><span>+ Add photo</span></label><p class="nd-meta">JPG, PNG or WebP, up to four. Large images are resized to 960px. Add alternative text in both languages; the first photo is the main one.</p></section>
</div>
<div class="admin-store__col">
  <section class="nd-panel admin-store__panel" aria-labelledby="productPriceTitle"><h2 class="nd-h2" id="productPriceTitle">Price and stock</h2>
  ${field("price", "Price (FCFA)", p.price, "number", 'min="1" max="100000000" placeholder="Price to be confirmed"')}${field("sku", "SKU", p.sku, "text", 'required maxlength="80"')}
  <label class="nd-field"><span class="nd-label">Category</span><select class="nd-input" name="categoryId"><option value="">Uncategorized</option>${state.categories.map((c) => `<option value="${h(c.id)}" ${c.id === p.categoryId ? "selected" : ""}>${h(c.name.en)}</option>`).join("")}</select></label>
  ${role === "owner" ? field("cost", "Internal cost (FCFA)", p.cost, "number", 'min="0" max="100000000"') : ""}
  ${p.id ? `<div class="admin-row"><span class="admin-row__label">In stock</span><strong>${h(p.available)} · <a class="admin-link" href="/dashboard#products">adjust</a></strong></div>` : '<p class="nd-meta">Stock starts at 0; add it on Products after saving.</p>'}</section>
  <section class="nd-panel admin-store__panel" aria-labelledby="productVisibilityTitle"><h2 class="nd-h2" id="productVisibilityTitle">Visibility</h2>
  ${checkbox("shown", "Show in the store", shown)}${checkbox("featured", "Featured product", p.featured)}
  ${p.status === "archived" ? '<p class="nd-meta">Archived: kept for order history and hidden from the store. Show it to publish it again.</p>' : ""}
  ${bilingual("warranty", "Warranty", p.warranty, true)}</section>
</div></form>
${p.id ? `<p class="admin-store__danger"><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-delete-product="${h(p.id)}">Delete product</button></p>` : ""}`;
    const tabs = root.querySelectorAll("[data-product-lang]");
    const showLang = (next) => {
      lang = next;
      tabs.forEach((t) => t.setAttribute("aria-selected", String(t.dataset.productLang === lang)));
      root.querySelectorAll(".admin-store__textpanel [data-lang]").forEach((label) => { label.hidden = label.dataset.lang !== lang; });
    };
    tabs.forEach((t) => { t.onclick = () => showLang(t.dataset.productLang); });
    showLang(lang);
    renderImages();
    $("#storeImageUpload").onchange = (e) =>
      run(null, async () => {
        const file = e.target.files[0];
        if (!file) return;
        if (images.length >= 4) throw Error("Use at most four images.");
        if (
          !["image/png", "image/jpeg", "image/webp"].includes(file.type) ||
          file.size > 8e6
        )
          throw Error("Choose a PNG, JPEG or WebP under 8 MB.");
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height)),
          canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas
          .getContext("2d")
          .drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        let data = canvas.toDataURL("image/webp", 0.8);
        if (data.length > 230000) data = canvas.toDataURL("image/webp", 0.4);
        if (data.length > 230000)
          throw Error("Image is too detailed; upload a smaller image.");
        images.push({ data, alt: loc() });
        renderImages();
        e.target.value = "";
      });
    const del = root.querySelector(".admin-store__danger [data-delete-product]");
    if (del) del.onclick = () => run(del, async () => {
      if (!confirm("Delete this product? Products with history must be archived instead.")) return;
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
          images,
        });
        savedNotice = status === "published" ? "Saved · live in the store" : "Saved · hidden from the store";
        const saved = p.id ? p : state.products.find((x) => x.sku.toLowerCase() === String(input.sku).trim().toLowerCase());
        if (!p.id && saved) { keepNotice = true; location.hash = "product/" + encodeURIComponent(saved.id); }
        else render();
      });
    };
  }
  function renderImages() {
    const wrap = $("#storeImages");
    wrap.innerHTML = images
      .map(
        (im, index) =>
          `<fieldset class="admin-photo${index === 0 ? " is-main" : ""}"><legend>${index === 0 ? "Main photo" : `Photo ${index + 1}`}</legend><img src="${h(im.data)}" alt="${h(im.alt.en)}" width="120" height="90">${bilingual(`image${index}`, "Alternative text", im.alt)}<div class="admin-actions"><button type="button" class="nd-btn nd-btn--compact nd-btn--secondary" data-image-up="${index}" ${index === 0 ? "disabled" : ""}>Move up</button><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet admin-btn--danger" data-image-delete="${index}">Remove</button></div></fieldset>`,
      )
      .join("");
    wrap.querySelectorAll("input").forEach(
      (input) =>
        (input.oninput = () => {
          const [key, lang] = input.name.split(".");
          images[Number(key.slice(5))].alt[lang] = input.value;
        }),
    );
    wrap.querySelectorAll("[data-image-up]").forEach(
      (b) =>
        (b.onclick = () => {
          const index = Number(b.dataset.imageUp);
          [images[index - 1], images[index]] = [
            images[index],
            images[index - 1],
          ];
          renderImages();
        }),
    );
    wrap.querySelectorAll("[data-image-delete]").forEach(
      (b) =>
        (b.onclick = () => {
          images.splice(Number(b.dataset.imageDelete), 1);
          renderImages();
        }),
    );
  }
  $("#retryStore").onclick = (e) => run(e.currentTarget, load);
  return { load, activate };
}
