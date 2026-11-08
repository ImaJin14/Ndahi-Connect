import { escapeHtml as h } from "/shared/safe-html.js";
const $ = (s) => document.querySelector(s),
  api = window.NDAHI_CONFIG.apiUrl;
// Language switching is temporarily disabled; retain translations for later.
const lang = "en";
let data,
  account = { authenticated: false, orders: [] },
  category = "",
  search = "",
  selected,
  checkoutKey;
const words = {
  en: {
    shop: "Shop",
    orders: "My orders",
    account: "Sign in",
    eyebrow: "THE NDAHI DEVICE STORE",
    headline: "Make room for<br>better connections.",
    intro:
      "The right equipment. A little more reach. Find networking essentials for home, work and wherever you go.",
    browse: "Explore devices",
    pickup: "Local pickup",
    money: "MTN & Orange Money",
    support: "Setup guidance",
    devices: "Find your connection.",
    devicesIntro:
      "Networking essentials, with clear advice and local collection.",
    all: "All devices",
    search: "Search devices",
    empty: "Good connections are on their way.",
    emptyText:
      "Our equipment catalogue is being prepared. Come back soon to discover available devices.",
    closed:
      "Browsing is open. Checkout will be available when the store opens.",
    details: "View device",
    available: "available",
    unavailable: "Out of stock",
    featured: "Featured",
    help: "Not sure what you need?",
    helpText:
      "An extender needs an existing signal. A travel router shares a connection. Check compatibility before you buy.",
    internet: "Explore internet packages ↗",
    footer: "Equipment for your everyday connections.",
    specifications: "Specifications",
    compatibility: "Compatibility",
    contents: "What’s in the box",
    warranty: "Warranty",
    setup: "Setup guidance",
    buy: "Buy this device",
    separate:
      "Internet service is purchased separately unless explicitly included in this product’s description.",
    checkout: "Checkout",
    guest: "Guest checkout — no account required.",
    signed: "You are signed in. This purchase will appear in your account.",
    name: "Full name",
    phone: "Contact phone",
    email: "Email (optional)",
    payer: "Mobile Money number",
    network: "Payment network",
    quantity: "Quantity",
    pay: "Pay with Mobile Money",
    payHelp:
      "Approve the request on your phone. We never ask for your Mobile Money PIN.",
    total: "Total",
    returns: "Returns",
    policies: "Store policies",
    track: "Track an order",
    trackHelp:
      "Use the private tracking link saved after checkout. Your order number alone cannot open an order.",
    recent: "Recent orders on this browser",
    refresh: "Refresh",
    check: "Check payment",
    copy: "Copy private order link",
    saved: "Link copied. Keep it private.",
    claim: "Save to my account",
    collection: "Collection code",
    collectionHelp: "Share this code only when collecting your equipment.",
    pending: "Awaiting payment",
    expired: "Payment window expired",
    failed: "Payment failed",
    paid: "Payment confirmed",
    refunded: "Refunded",
    "refund-pending": "Refund in progress",
    preparing: "Preparing your order",
    ready: "Ready for pickup",
    collected: "Collected",
    cancelled: "Cancelled",
    review: "Payment received — support review required",
    awaiting_payment: "Awaiting payment",
    late: "Payment received after the reservation closed. Contact the store; do not pay again.",
    reserved:
      "Stock is reserved for 10 minutes. Keep this page or your tracking link.",
    wait: "Working…",
    notice: "Please check the details and try again.",
    order: "Order",
    checkAccount: "Refresh sign-in",
    signHelp:
      "Sign in to the portal in the new tab, then return here and refresh sign-in.",
    orderEmpty: "You have no saved orders yet.",
    link: "Private order link",
    open: "Open order",
    paymentReview:
      "Payment verification needs another check. Do not start a second payment.",
    gallery: "Product image",
    banner: "Store update",
  },
  fr: {
    shop: "Boutique",
    orders: "Mes commandes",
    account: "Se connecter",
    eyebrow: "LA BOUTIQUE NDAHI",
    headline: "Faites place à de<br>meilleures connexions.",
    intro:
      "Le bon équipement, un peu plus de portée. Découvrez les essentiels réseau pour la maison, le travail et vos déplacements.",
    browse: "Voir les appareils",
    pickup: "Retrait local",
    money: "MTN et Orange Money",
    support: "Conseils de configuration",
    devices: "Trouvez votre connexion.",
    devicesIntro:
      "Des équipements réseau, des conseils clairs et un retrait local.",
    all: "Tous les appareils",
    search: "Rechercher un appareil",
    empty: "De bonnes connexions arrivent.",
    emptyText:
      "Notre catalogue est en préparation. Revenez bientôt découvrir les appareils disponibles.",
    closed:
      "Vous pouvez consulter la boutique. Les achats seront disponibles à son ouverture.",
    details: "Voir l’appareil",
    available: "disponibles",
    unavailable: "Rupture de stock",
    featured: "À la une",
    help: "Besoin de conseils ?",
    helpText:
      "Un répéteur nécessite un signal existant. Un routeur de voyage partage une connexion. Vérifiez la compatibilité avant l’achat.",
    internet: "Découvrir les forfaits internet ↗",
    footer: "Des équipements pour vos connexions du quotidien.",
    specifications: "Caractéristiques",
    compatibility: "Compatibilité",
    contents: "Contenu du colis",
    warranty: "Garantie",
    setup: "Configuration",
    buy: "Acheter cet appareil",
    separate:
      "Le service internet est vendu séparément sauf mention explicite dans la description du produit.",
    checkout: "Commande",
    guest: "Achat invité — aucun compte requis.",
    signed: "Vous êtes connecté. Cet achat apparaîtra dans votre compte.",
    name: "Nom complet",
    phone: "Téléphone de contact",
    email: "Email (facultatif)",
    payer: "Numéro Mobile Money",
    network: "Réseau de paiement",
    quantity: "Quantité",
    pay: "Payer par Mobile Money",
    payHelp:
      "Validez la demande sur votre téléphone. Nous ne demandons jamais votre code PIN Mobile Money.",
    total: "Total",
    returns: "Retours",
    policies: "Conditions de la boutique",
    track: "Suivre une commande",
    trackHelp:
      "Utilisez le lien privé enregistré après l’achat. Le numéro de commande seul ne donne pas accès à la commande.",
    recent: "Commandes récentes sur ce navigateur",
    refresh: "Actualiser",
    check: "Vérifier le paiement",
    copy: "Copier le lien privé",
    saved: "Lien copié. Gardez-le confidentiel.",
    claim: "Enregistrer dans mon compte",
    collection: "Code de retrait",
    collectionHelp: "Communiquez ce code uniquement lors du retrait.",
    pending: "Paiement en attente",
    expired: "Délai de paiement expiré",
    failed: "Échec du paiement",
    paid: "Paiement confirmé",
    refunded: "Remboursé",
    "refund-pending": "Remboursement en cours",
    preparing: "Préparation de votre commande",
    ready: "Prête pour le retrait",
    collected: "Retirée",
    cancelled: "Annulée",
    review: "Paiement reçu — assistance nécessaire",
    awaiting_payment: "Paiement en attente",
    late: "Paiement reçu après expiration de la réservation. Contactez la boutique ; ne payez pas à nouveau.",
    reserved:
      "Le stock est réservé pendant 10 minutes. Conservez cette page ou votre lien de suivi.",
    wait: "Traitement…",
    notice: "Vérifiez les informations et réessayez.",
    order: "Commande",
    checkAccount: "Actualiser la connexion",
    signHelp:
      "Connectez-vous au portail dans le nouvel onglet, puis revenez ici et actualisez la connexion.",
    orderEmpty: "Vous n’avez pas encore de commandes enregistrées.",
    link: "Lien privé de commande",
    open: "Ouvrir la commande",
    paymentReview:
      "La vérification du paiement nécessite un nouveau contrôle. Ne lancez pas un second paiement.",
    gallery: "Image du produit",
    banner: "Actualité boutique",
  },
};
const t = (key) => words[lang][key] || key,
  l = (value) =>
    typeof value === "object" ? value?.[lang] || value?.en || "" : value || "",
  money = (n) =>
    `${Number(n).toLocaleString(lang === "fr" ? "fr-CM" : "en-CM")} FCFA`;
const routerArt =
  '<svg viewBox="0 0 460 290" fill="none" aria-hidden="true"><circle cx="240" cy="137" r="110" stroke="#c6d4b8"/><circle cx="240" cy="137" r="80" stroke="#c6d4b8"/><ellipse cx="242" cy="240" rx="135" ry="13" fill="#c4cfb6"/><path d="m144 176 162-13 53 42-161 18-54-47Z" fill="#fcfdf7" stroke="#bcc9ad"/><path d="m144 176 54 47v17l-54-45v-19Z" fill="#dbe3d2"/><path d="m198 223 161-18v17l-161 18v-17Z" fill="#e8eddf"/><path d="M164 180 150 73M318 175l12-110" stroke="#fdfef9" stroke-width="12" stroke-linecap="round"/><path d="m223 208 6-1m9 0 6-1m10 0 6-1" stroke="#759451" stroke-width="3" stroke-linecap="round"/><path d="M209 119c15-17 43-17 58 0m-46 10c9-10 23-10 33 0m-22 9c3-3 7-3 10 0" stroke="#739250" stroke-width="4" stroke-linecap="round"/></svg>';
async function call(path, input) {
  const r = await fetch(api + path, {
    credentials: "include",
    ...(input
      ? {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(account.csrfToken ? { "x-csrf-token": account.csrfToken } : {}),
          },
          body: JSON.stringify(input),
        }
      : {}),
  });
  const j = await r.json();
  if (!r.ok)
    throw Object.assign(Error(j.error || t("notice")), {
      status: r.status,
      checkoutNotCreated: j.checkoutNotCreated,
    });
  return j;
}
async function action(button, task) {
  if (button?.disabled) return;
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = t("wait");
  }
  try {
    await task();
  } catch (e) {
    $("#message").textContent = e.message;
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}
function visual(p) {
  return `<div class="product-visual">${p.images?.[0] ? `<img src="${h(p.images[0].data)}" alt="${h(l(p.images[0].alt))}" loading="lazy">` : '<svg viewBox="0 0 120 100" fill="none" aria-hidden="true"><path d="M60 15 100 35 60 55 20 35 60 15Z" stroke="currentColor" stroke-width="2"/><path d="M20 35v35l40 20 40-20V35M60 55v35M40 25l40 20" stroke="currentColor" stroke-width="2"/></svg>'}${p.featured ? `<span class="badge">${h(t("featured"))}</span>` : ""}</div>`;
}
function pendingCheckout() {
  try {
    return JSON.parse(sessionStorage.getItem("ndahi-store-checkout") || "null");
  } catch {
    return null;
  }
}
function recent() {
  try {
    return JSON.parse(
      localStorage.getItem("ndahi-store-orders") || "[]",
    ).filter((o) => o.id && o.token);
  } catch {
    return [];
  }
}
function remember(id, token) {
  localStorage.setItem(
    "ndahi-store-orders",
    JSON.stringify(
      [{ id, token }, ...recent().filter((o) => o.id !== id)].slice(0, 20),
    ),
  );
}
function orderHash(id, token) {
  return `#order/${encodeURIComponent(id)}${token ? "/" + encodeURIComponent(token) : ""}`;
}
function layout() {
  document.title = data.settings.name + " — NDAHI Connect";
  $("#storeName").textContent = data.settings.name;
  document.documentElement.lang = lang;
  document
    .querySelectorAll("[data-label]")
    .forEach((el) => (el.textContent = t(el.dataset.label)));
  $("#portal").href = data.portalUrl + "/login";
  $("#internet").href = data.portalUrl + "/onboarding.html";
  $("#internet").textContent = t("internet");
  $("#footerText").textContent = t("footer");
  $("#storeContact").textContent = data.settings.contact;
}
function renderShop() {
  const products = data.products
    .filter(
      (p) =>
        (!category || p.categoryId === category) &&
        `${l(p.name)} ${p.sku} ${l(p.description)}`
          .toLowerCase()
          .includes(search.toLowerCase()),
    )
    .sort((a, b) => Number(b.featured) - Number(a.featured));
  $("#view").innerHTML =
    `<section class="hero"><div><span class="eyebrow">${h(t("eyebrow"))}</span><h1>${t("headline")}</h1><p>${h(l(data.settings.introduction) || t("intro"))}</p><a class="button" href="#devices">${h(t("browse"))} <span aria-hidden="true">↗</span></a></div><div class="hero-art">${routerArt}<span class="art-label">NDAHI / CONNECTED EVERYDAY</span></div></section><div class="strip"><span><b>↗</b>${h(t("pickup"))}</span><span><b>◈</b>${h(t("money"))}</span><span><b>◎</b>${h(t("support"))}</span></div>${l(data.settings.banner) ? `<p class="notice">${h(l(data.settings.banner))}</p>` : ""}${pendingCheckout() ? `<p class="notice"><button id="resumeCheckout" class="secondary">${lang === "fr" ? "Reprendre ma commande" : "Resume checkout"}</button></p>` : ""}${!data.settings.open ? `<p class="notice">${h(t("closed"))}</p>` : ""}<section id="devices"><div class="section-top"><div><h2>${h(t("devices"))}</h2><p>${h(t("devicesIntro"))}</p></div><input class="search" type="search" id="search" aria-label="${h(t("search"))}" placeholder="${h(t("search"))}" value="${h(search)}"></div><div class="filters"><button data-category="" class="${!category ? "active" : ""}">${h(t("all"))}</button>${data.categories.map((c) => `<button data-category="${h(c.id)}" class="${category === c.id ? "active" : ""}">${h(l(c.name))}</button>`).join("")}</div><div class="products">${products.length ? products.map((p) => `<article class="product">${visual(p)}<h3>${h(l(p.name))}</h3><p>${h(p.available ? `${p.available} ${t("available")}` : t("unavailable"))}</p><div class="product-bottom"><span class="price">${h(money(p.price))}</span><button data-product="${h(p.id)}">${h(t("details"))} ↗</button></div></article>`).join("") : `<div class="empty"><h3>${h(t("empty"))}</h3><p>${h(t("emptyText"))}</p></div>`}</div></section><section class="help-block"><div><h2>${h(t("help"))}</h2><p>${h(t("helpText"))}</p></div><a class="button secondary" href="${h(data.portalUrl)}/onboarding.html" target="_blank" rel="noopener">${h(t("internet"))}</a></section><details class="policy"><summary>${h(t("policies"))}</summary><h3>${h(t("warranty"))}</h3><p>${h(l(data.settings.warranty))}</p><h3>${h(t("returns"))}</h3><p>${h(l(data.settings.returns))}</p></details>`;
  if ($("#resumeCheckout"))
    $("#resumeCheckout").onclick = () => {
      selected = pendingCheckout().product;
      showCheckout();
    };
  $("#search").oninput = (e) => {
    const pos = e.target.selectionStart;
    search = e.target.value;
    renderShop();
    $("#search").focus();
    $("#search").setSelectionRange(pos, pos);
  };
  document.querySelectorAll("[data-category]").forEach(
    (b) =>
      (b.onclick = () => {
        category = b.dataset.category;
        renderShop();
      }),
  );
  document
    .querySelectorAll("[data-product]")
    .forEach((b) => (b.onclick = () => showProduct(b.dataset.product)));
}
function showProduct(id) {
  selected = data.products.find((p) => p.id === id);
  const p = selected;
  $("#productDetail").innerHTML =
    `<div class="detail-grid"><div>${visual(p)}<div class="gallery">${p.images.map((im) => `<img src="${h(im.data)}" alt="${h(l(im.alt))}">`).join("")}</div></div><div><p class="eyebrow">${h(p.sku)}</p><h2 id="productTitle">${h(l(p.name))}</h2><p class="price">${h(money(p.price))}</p><p class="details">${h(l(p.description))}</p><p class="form-help">${h(t("separate"))}</p><button id="buy" ${!p.available || !data.settings.open || !data.paymentProviders.length ? "disabled" : ""}>${h(p.available ? t("buy") : t("unavailable"))}</button></div></div><div class="details">${[
      "specifications",
      "compatibility",
      "contents",
      "warranty",
      "setup",
    ]
      .filter((k) => l(p[k]))
      .map((k) => `<h3>${h(t(k))}</h3><p>${h(l(p[k]))}</p>`)
      .join("")}</div>`;
  $("#buy").onclick = () => {
    $("#productDialog").close();
    showCheckout();
  };
  $("#productDialog").showModal();
}
function showCheckout() {
  const pending = pendingCheckout();
  if (pending) {
    selected = pending.product;
    checkoutKey = pending.input.checkoutKey;
  } else checkoutKey = crypto.randomUUID();
  const c = pending ? pending.input : account.customer || {};
  $("#checkoutDetail").innerHTML =
    `<h2 id="checkoutTitle">${h(t("checkout"))}</h2><p>${h(account.authenticated ? t("signed") : t("guest"))}</p><p class="form-help">${h(t("separate"))}</p><form id="checkoutForm"><div class="form-grid"><div><label for="name">${h(t("name"))}</label><input id="name" name="name" required maxlength="120" autocomplete="name" value="${h(c.name || "")}"></div><div><label for="phone">${h(t("phone"))}</label><input id="phone" name="phone" type="tel" required autocomplete="tel" value="${h(c.phone || "")}" placeholder="6XXXXXXXX"></div><div><label for="email">${h(t("email"))}</label><input id="email" name="email" type="email" autocomplete="email" value="${h(c.email || "")}"></div><div><label for="quantity">${h(t("quantity"))}</label><input id="quantity" name="quantity" type="number" min="1" max="${Math.min(20, selected.available)}" value="${h(c.quantity || 1)}" required></div><div><label for="payerPhone">${h(t("payer"))}</label><input id="payerPhone" name="payerPhone" type="tel" required value="${h(c.payerPhone || c.phone || "")}" placeholder="6XXXXXXXX"></div><div><label for="network">${h(t("network"))}</label><select id="network" name="network"><option value="mtn">MTN Mobile Money</option><option value="orange">Orange Money</option></select></div></div><div class="checkout-summary"><span>${h(l(selected.name))}</span><strong id="total">${h(money(selected.price))}</strong></div><p><strong>${h(t("pickup"))}</strong><br>${h(data.settings.pickup)}<br>${h(data.settings.hours)}</p><p class="form-help">${h(t("payHelp"))}</p><p class="form-help">${h(t("reserved"))}</p><details class="policy"><summary>${h(t("policies"))}</summary><p>${h(l(selected.warranty) || l(data.settings.warranty))}</p><p>${h(l(data.settings.returns))}</p></details><div class="actions"><button type="submit">${h(t("pay"))}</button></div><p id="checkoutError" class="error" role="alert"></p></form>`;
  if (pending) {
    $("#network").value = c.network;
    $("#checkoutForm")
      .querySelectorAll("input,select")
      .forEach((el) => (el.disabled = true));
  }
  $("#quantity").oninput = () =>
    ($("#total").textContent = money(
      selected.price * Number($("#quantity").value),
    ));
  $("#checkoutForm").onsubmit = async (e) => {
    e.preventDefault();
    const button = e.submitter;
    await action(button, async () => {
      try {
        const fields = Object.fromEntries(new FormData(e.target));
        const input = pending
          ? pending.input
          : {
              ...fields,
              quantity: Number(fields.quantity),
              productId: selected.id,
              expectedPrice: selected.price,
              checkoutKey,
            };
        sessionStorage.setItem(
          "ndahi-store-checkout",
          JSON.stringify({
            input,
            product: selected,
            account: pending ? pending.account : account.authenticated,
          }),
        );
        const result = await call(
          (pending ? pending.account : account.authenticated)
            ? "/api/account/store/checkout"
            : "/api/store/checkout",
          input,
        );
        remember(result.order.id, result.token);
        sessionStorage.removeItem("ndahi-store-checkout");
        $("#checkoutDialog").close();
        location.hash = orderHash(result.order.id, result.token);
      } catch (err) {
        if (err.checkoutNotCreated) {
          sessionStorage.removeItem("ndahi-store-checkout");
        }
        $("#checkoutError").textContent = err.message;
        throw err;
      }
    });
  };
  $("#checkoutDialog").showModal();
}
async function refreshAccount() {
  account = await call("/api/account/store/context");
}
function orderCard(o) {
  return `<article class="order-card"><span class="eyebrow">${h(o.reference)}</span><h3>${h(l(o.product.name))} × ${h(o.quantity)}</h3><p>${h(money(o.amount))} · ${h(t(o.paymentStatus))}${o.refundStatus === "failed" ? ` · ${lang === "fr" ? "Échec du remboursement — contactez la boutique" : "Refund failed — contact the store"}` : ""}</p><span class="order-status">${h(t(o.status))}</span>${o.paymentReview ? `<p class="notice">${h(t(o.paymentReview === "late_payment" ? "late" : "paymentReview"))}</p>` : ""}${o.collectionCode ? `<h4>${h(t("collection"))}</h4><p class="collection">${h(o.collectionCode)}</p><p class="form-help">${h(t("collectionHelp"))}</p>` : ""}<p><strong>${h(t("pickup"))}</strong><br>${h(o.pickup)}<br>${h(o.hours)}</p>${o.serialNumbers ? `<p>${h(o.serialNumbers)}</p>` : ""}<details class="policy"><summary>${h(t("policies"))}</summary><h4>${h(t("warranty"))}</h4><p>${h(l(o.product.warranty))}</p><h4>${h(t("returns"))}</h4><p>${h(l(o.returns))}</p></details></article>`;
}
async function showOrders() {
  await refreshAccount();
  $("#view").innerHTML =
    `<div class="section-top"><div><h1>${h(t("orders"))}</h1><p>${h(t("trackHelp"))}</p></div><button class="secondary" id="refreshAccount">${h(t("checkAccount"))}</button></div><p class="form-help">${h(t("signHelp"))}</p>${account.orders.length ? account.orders.map((o) => orderCard(o) + `<a class="button secondary" href="${h(orderHash(o.id))}">${h(t("open"))}</a>`).join("") : `<p>${h(t("orderEmpty"))}</p>`}<h2>${h(t("recent"))}</h2>${recent()
      .map(
        (o) =>
          `<p><a href="${h(orderHash(o.id, o.token))}">${h(t("order"))} ${h(o.id.slice(0, 8).toUpperCase())} ↗</a></p>`,
      )
      .join("")}`;
  $("#refreshAccount").onclick = (e) => action(e.currentTarget, showOrders);
}
async function showOrder(id, token, verify = false) {
  const result = await call(
    account.authenticated
      ? `/api/account/store/${verify ? "verify" : "order"}`
      : `/api/store/${verify ? "verify" : "order"}`,
    { orderId: id, token },
  );
  const o = result.order;
  $("#view").innerHTML =
    `<div class="section-top"><h1>${h(t("order"))}</h1><a href="#orders">${h(t("orders"))}</a></div>${orderCard(o)}<div class="actions"><button id="checkPayment">${h(t("check"))}</button>${o.receiptAvailable ? `<button class="secondary" id="downloadStoreReceipt">Download receipt</button>` : ""}${token ? `<button class="secondary" id="copyLink">${h(t("copy"))}</button>` : ""}${token && account.authenticated ? `<button class="secondary" id="claimOrder">${h(t("claim"))}</button>` : ""}</div><p class="form-help">${h(t("reserved"))}</p>${token ? `<label for="privateLink">${h(t("link"))}</label><input readonly id="privateLink" value="${h(location.origin + "/" + orderHash(id, token))}">` : ""}`;
  $("#checkPayment").onclick = (e) =>
    action(e.currentTarget, () => showOrder(id, token, true));
  if ($("#downloadStoreReceipt")) $("#downloadStoreReceipt").onclick = (e) => action(e.currentTarget, async () => {
    const response = await fetch(api + (account.authenticated ? "/api/account/store/receipt" : "/api/store/receipt"), {
      method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(account.authenticated ? { "x-csrf-token": account.csrfToken } : {}) }, body: JSON.stringify({ orderId: id, token }),
    });
    if (!response.ok) { const result = await response.json(); throw Error(result.error || "Receipt unavailable."); }
    const blob = await response.blob(), url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = `ndahi-store-receipt-${id}.pdf`; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
  });
  if ($("#copyLink"))
    $("#copyLink").onclick = (e) =>
      action(e.currentTarget, async () => {
        await navigator.clipboard.writeText(
          location.origin + "/" + orderHash(id, token),
        );
        $("#message").textContent = t("saved");
      });
  if ($("#claimOrder"))
    $("#claimOrder").onclick = (e) =>
      action(e.currentTarget, async () => {
        await call("/api/account/store/claim", { orderId: id, token });
        await showOrder(id, token);
      });
}
async function route() {
  if (!data) return;
  $("#message").textContent = "";
  layout();
  try {
    const parts = location.hash.slice(1).split("/");
    if (parts[0] === "order" && parts[1])
      await showOrder(
        decodeURIComponent(parts[1]),
        parts[2] ? decodeURIComponent(parts[2]) : undefined,
      );
    else if (parts[0] === "orders") await showOrders();
    else renderShop();
  } catch (e) {
    $("#message").textContent = e.message;
  }
}

document
  .querySelectorAll(".close")
  .forEach((b) => (b.onclick = () => b.closest("dialog").close()));
window.addEventListener("hashchange", route);
try {
  [data] = await Promise.all([call("/api/store/catalogue"), refreshAccount()]);
  await route();
} catch (e) {
  $("#view").textContent = e.message;
}
