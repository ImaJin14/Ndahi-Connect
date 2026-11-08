import { escapeHtml as h } from "/shared/safe-html.js";
const loc = (en = "", fr = "") => ({ en, fr });
const emptyProduct = () => ({
  name: loc(),
  sku: "",
  categoryId: "",
  price: 1,
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
  `<label>${h(label)}<input name="${h(name)}" type="${type}" value="${h(value)}" ${extra}></label>`;
const bilingual = (name, label, value = loc(), large = false) =>
  ["en", "fr"]
    .map(
      (lang) =>
        `<label>${h(label)} (${lang.toUpperCase()})${large ? `<textarea name="${name}.${lang}" rows="3" maxlength="4000">${h(value?.[lang] || "")}</textarea>` : `<input name="${name}.${lang}" value="${h(value?.[lang] || "")}" maxlength="120">`}</label>`,
    )
    .join("");
const checkbox = (name, label, checked) =>
  `<label><input type="checkbox" name="${name}" ${checked ? "checked" : ""}> ${h(label)}</label>`;
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
const fcfa = (n) => `${Number(n).toLocaleString()} FCFA`;

export function mountStore(root, { call, role }) {
  let state,
    tab = "products",
    query = "",
    images = [];
  root.innerHTML =
    '<h2>Store</h2><p>Manage the device catalogue, inventory and customer orders.</p><button type="button" id="loadStore">Open store management</button><p id="storeAdminMessage" role="status" aria-live="polite"></p><div id="storeAdminContent"></div>';
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
    state = await call("/api/admin/store");
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
  function render() {
    content.innerHTML = `<div class="action-row">${["products", "categories", "inventory", "orders", "settings"].map((id) => `<button type="button" class="${tab === id ? "" : "secondary"}" data-store-tab="${id}">${id[0].toUpperCase() + id.slice(1)}</button>`).join("")}<button type="button" id="refreshStore">Refresh</button></div><div id="storeWorkspace"></div>`;
    root.querySelectorAll("[data-store-tab]").forEach(
      (b) =>
        (b.onclick = () => {
          tab = b.dataset.storeTab;
          query = "";
          render();
        }),
    );
    $("#refreshStore").onclick = (e) => run(e.currentTarget, load);
    ({
      products: products,
      categories: categories,
      inventory: inventory,
      orders: orders,
      settings: settings,
    })[tab]();
  }
  function products() {
    const w = $("#storeWorkspace");
    w.innerHTML = `<h3>Products</h3><button type="button" id="newStoreProduct">Add product</button><label>Search catalogue<input id="storeSearch" type="search" value="${h(query)}"></label><div id="storeProductRows"></div><div id="storeEditor"></div>`;
    $("#newStoreProduct").onclick = () => editProduct(emptyProduct());
    $("#storeSearch").oninput = (e) => {
      query = e.target.value;
      productRows();
    };
    productRows();
  }
  function productRows() {
    const list = state.products.filter((p) =>
      `${p.name.en} ${p.name.fr} ${p.sku}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    $("#storeProductRows").innerHTML =
      `<div class="table-scroll"><table><thead><tr><th>Product</th><th>Status</th><th>Price</th><th>Available / stock</th><th>Actions</th></tr></thead><tbody>${list.map((p) => `<tr><td>${h(p.name.en)}<br><small>${h(p.sku)}</small></td><td>${h(p.status)}</td><td>${h(fcfa(p.price))}</td><td>${h(p.available)} / ${h(p.stock)}</td><td><button data-edit-product="${h(p.id)}">Edit</button> <button data-delete-product="${h(p.id)}">Delete</button></td></tr>`).join("")}</tbody></table></div>`;
    root
      .querySelectorAll("[data-edit-product]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            editProduct(
              state.products.find((p) => p.id === b.dataset.editProduct),
            )),
      );
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
  }
  function editProduct(p) {
    images = structuredClone(p.images);
    $("#storeEditor").innerHTML =
      `<h3>${p.id ? "Edit product" : "New product"}</h3><form id="storeProductForm"><div class="form-grid">${bilingual("name", "Name", p.name)}${field("sku", "SKU / model", p.sku, "text", 'required maxlength="80"')}${field("price", "Selling price (FCFA)", p.price, "number", 'required min="1" max="100000000"')}${role === "owner" ? field("cost", "Internal cost (FCFA)", p.cost, "number", 'min="0" max="100000000"') : ""}<label>Category<select name="categoryId"><option value="">Uncategorized</option>${state.categories.map((c) => `<option value="${h(c.id)}" ${c.id === p.categoryId ? "selected" : ""}>${h(c.name.en)}</option>`).join("")}</select></label><label>Status<select name="status">${["draft", "published", "archived"].map((status) => `<option ${p.status === status ? "selected" : ""}>${status}</option>`).join("")}</select></label>${checkbox("featured", "Featured product", p.featured)}${["description", "specifications", "compatibility", "contents", "warranty", "setup"].map((key) => bilingual(key, key[0].toUpperCase() + key.slice(1), p[key], true)).join("")}</div><h4>Product images</h4><p class="form-help">Up to four images. Uploads are resized to a maximum of 960px and saved with the product. Add alternative text in both languages.</p><label>Upload image<input type="file" id="storeImageUpload" accept="image/png,image/jpeg,image/webp"></label><div id="storeImages"></div><div class="action-row"><button type="submit">Save product</button><button type="button" id="cancelProduct">Cancel</button></div></form>`;
    renderImages();
    $("#cancelProduct").onclick = () => $("#storeEditor").replaceChildren();
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
    $("#storeProductForm").onsubmit = (e) => {
      e.preventDefault();
      run(e.submitter, () => {
        const input = values(e.target);
        return save("products/save", {
          ...input,
          id: p.id,
          version: p.version,
          price: Number(input.price),
          cost: Number(input.cost || 0),
          featured: e.target.elements.featured.checked,
          images,
        });
      });
    };
    $("#storeEditor").scrollIntoView({ block: "nearest", behavior: "smooth" });
  }
  function renderImages() {
    const wrap = $("#storeImages");
    wrap.innerHTML = images
      .map(
        (im, index) =>
          `<fieldset><legend>Image ${index + 1}</legend><img src="${h(im.data)}" alt="${h(im.alt.en)}" width="120" height="90">${bilingual(`image${index}`, "Alternative text", im.alt)}<div class="action-row"><button type="button" data-image-up="${index}" ${index === 0 ? "disabled" : ""}>Move up</button><button type="button" data-image-delete="${index}">Remove</button></div></fieldset>`,
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
  function categories() {
    const w = $("#storeWorkspace");
    w.innerHTML = `<h3>Categories</h3><button type="button" id="newStoreCategory">Add category</button>${state.categories.map((c) => `<p>${h(c.name.en)} / ${h(c.name.fr)} · ${c.hidden ? "Hidden" : "Visible"} · ${h(c.position)} <button data-edit-category="${h(c.id)}">Edit</button> <button data-delete-category="${h(c.id)}">Delete</button></p>`).join("")}<div id="categoryEditor"></div>`;
    const edit = (c) => {
      $("#categoryEditor").innerHTML =
        `<form id="categoryForm">${bilingual("name", "Category name", c.name)}${field("position", "Sort position", c.position, "number", 'min="0" max="1000"')}${checkbox("hidden", "Hide category and its products", c.hidden)}<button>Save category</button></form>`;
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
    const w = $("#storeWorkspace");
    w.innerHTML = `<h3>Inventory</h3><p>Available stock excludes active reservations. Use negative quantities for removals. Every adjustment is recorded.</p><form id="stockForm"><label>Product<select name="id" required>${state.products.map((p) => `<option value="${h(p.id)}">${h(p.name.en)} — ${h(p.available)} available / ${h(p.stock)} in stock</option>`).join("")}</select></label>${field("delta", "Quantity to add or remove", 1, "number", 'required min="-1000000" max="1000000"')}${field("reason", "Reason", "", "text", 'required maxlength="300"')}<button ${!state.products.length ? "disabled" : ""}>Record adjustment</button></form><h4>Recent stock movements</h4><div class="table-scroll"><table><thead><tr><th>When</th><th>Product</th><th>Change</th><th>Balance</th><th>Reason / actor</th></tr></thead><tbody>${state.movements.map((m) => `<tr><td>${h(new Date(m.at).toLocaleString())}</td><td>${h(state.products.find((p) => p.id === m.productId)?.name.en || m.productId)}</td><td>${h(m.delta)}</td><td>${h(m.balance)}</td><td>${h(m.reason)} / ${h(m.actor)}</td></tr>`).join("")}</tbody></table></div>`;
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
      });
    };
  }
  function orders() {
    const w = $("#storeWorkspace");
    w.innerHTML = `<h3>Orders</h3><label>Search orders<input type="search" id="storeOrderSearch" value="${h(query)}" placeholder="Reference, customer or phone"></label><div id="storeOrderRows"></div><div id="orderEditor"></div>`;
    $("#storeOrderSearch").oninput = (e) => {
      query = e.target.value;
      orderRows();
    };
    orderRows();
  }
  function orderRows() {
    const list = state.orders.filter((o) =>
      `${o.reference} ${o.contact.name} ${o.contact.phone}`
        .toLowerCase()
        .includes(query.toLowerCase()),
    );
    $("#storeOrderRows").innerHTML =
      `<div class="table-scroll"><table><thead><tr><th>Reference</th><th>Customer</th><th>Item</th><th>Payment</th><th>Order</th><th>Actions</th></tr></thead><tbody>${list.map((o) => `<tr><td>${h(o.reference)}</td><td>${h(o.contact.name)}<br>${h(o.contact.phone)}</td><td>${h(o.product.name.en)} × ${h(o.quantity)}<br>${h(fcfa(o.amount))}</td><td>${h(o.paymentStatus)}${o.paymentReview ? `<br>${h(o.paymentReview)}` : ""}</td><td>${h(o.status)}</td><td><button data-order-edit="${h(o.id)}">Manage</button></td></tr>`).join("")}</tbody></table></div>`;
    root
      .querySelectorAll("[data-order-edit]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            editOrder(state.orders.find((o) => o.id === b.dataset.orderEdit))),
      );
  }
  function editOrder(o) {
    $("#orderEditor").innerHTML =
      `<h3>${h(o.reference)}</h3><p>${h(o.contact.name)} · ${h(o.contact.phone)} · ${h(o.contact.email || "")}</p><p>Payment: ${h(o.paymentStatus)}${o.payment.refund ? ` (refund: ${h(o.payment.refund.status)})` : ""} · Fulfilment: ${h(o.status)} · Stock: ${h(o.stockState)}</p><p>Pickup: ${h(o.pickup)} · ${h(o.hours)}</p><div class="action-row"><button data-order-action="verify">Check provider payment</button>${o.status === "preparing" && o.paymentStatus === "paid" ? '<button data-order-action="ready">Mark ready for pickup</button>' : ""}${!o.payment.confirmedAt && !["paid", "refund-pending", "refunded"].includes(o.paymentStatus) ? '<button data-order-action="cancel">Cancel unpaid order</button>' : ""}<button data-order-action="rotate-link">Replace tracking link</button></div>${o.status === "ready" ? `<form id="collectOrder">${field("collectionCode", "Customer collection code", "", "text", 'required autocomplete="off"')}<button>Confirm collection</button></form>` : ""}<form id="orderNotes">${field("serialNumbers", "Serial numbers", o.serialNumbers || "")}<label>Support / warranty notes<textarea name="notes" maxlength="2000">${h(o.notes || "")}</textarea></label><label>Return status<select name="returnStatus">${["none", "requested", "received", "resolved"].map((status) => `<option ${status === o.returnStatus ? "selected" : ""}>${status}</option>`).join("")}</select></label><button>Save after-sales details</button></form><form id="orderContact">${field("name", "Order contact name", o.contact.name, "text", 'required maxlength="120"')}${field("phone", "Order contact phone", o.contact.phone, "tel", "required")}${field("email", "Order contact email", o.contact.email || "", "email")}<button>Correct order contact</button></form>${role === "owner" && o.paymentStatus === "paid" && !o.payment.refund ? `<form id="refundOrder"><h4>Full refund</h4>${field("reason", "Refund reason", "", "text", 'required maxlength="300"')}${checkbox("restock", "Equipment is unsent or physically returned and can be restocked", false)}<p class="form-help">Stock is restored only after confirmed refund, when this checkbox is selected.</p><button>Authorize full refund</button></form>` : ""}${role === "owner" && o.payment.refund?.status === "uncertain" && !o.payment.refund.providerReference ? `<form id="refundReference"><h4>Reconcile uncertain refund</h4>${field("providerReference", "Reference verified in the provider dashboard", "", "text", 'required maxlength="200"')}<button>Verify refund reference</button></form>` : ""}<h4>Order history</h4>${o.history.map((e) => `<p>${h(e.at)} · ${h(e.action)} · ${h(e.actor)}</p>`).join("")}<p id="replacementLink"></p>`;
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
            if (action === "refund" && !confirm("Authorize this full refund?"))
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
  function settings() {
    const s = state.settings;
    $("#storeWorkspace").innerHTML =
      `<h3>Store content and settings</h3><p>Saved content appears in the store without a code deployment. Configure pickup and policies before opening checkout.</p><form id="storeSettingsForm">${field("name", "Store name", s.name, "text", 'required maxlength="100"')}${checkbox("open", "Accept new orders", s.open)}${bilingual("introduction", "Introduction", s.introduction, true)}${bilingual("banner", "Announcement banner", s.banner, true)}${field("contact", "Public contact details", s.contact, "text", 'maxlength="300"')}<label>Pickup location and instructions<textarea name="pickup" maxlength="1000">${h(s.pickup)}</textarea></label>${field("hours", "Pickup hours", s.hours, "text", 'maxlength="300"')}${bilingual("warranty", "Warranty policy", s.warranty, true)}${bilingual("returns", "Returns and refund policy", s.returns, true)}<button>Save store settings</button></form>`;
    $("#storeSettingsForm").onsubmit = (e) => {
      e.preventDefault();
      run(e.submitter, () =>
        save("settings/save", {
          ...values(e.target),
          version: s.version,
          open: e.target.elements.open.checked,
        }),
      );
    };
  }
  $("#loadStore").onclick = (e) => run(e.currentTarget, load);
  return { load };
}
