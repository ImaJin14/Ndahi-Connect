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
    eyebrow: "NDAHI Store",
    headline: "Equipment for better connections.",
    intro:
      "Routers and extenders we've tested on our network. Buy without an account — pay with Mobile Money and collect locally.",
    how: "How buying works",
    step1: "Pick a device",
    step2: "Pay as a guest or signed in",
    step3: "Collect with your code",
    step3At: "Collect at {place} with your code",
    browse: "Explore devices",
    pickup: "Local pickup",
    money: "MTN & Orange Money",
    support: "Setup guidance",
    devices: "Find your connection.",
    devicesIntro:
      "Networking essentials, with clear advice and local collection.",
    all: "All",
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
    guestChoice: "Just a name and phone number. You get a private tracking link.",
    guestTitle: "Continue as guest",
    inStock: "in stock",
    onlyLeft: "Only {n} left",
    view: "View",
    trackShort: "Track order",
    trackLong: "Track an order",
    internetNav: "Internet packages",
    storeSub: "Store",
    internetRow: "Looking for internet packages?",
    customerTitle: "Already an NDAHI customer?",
    customerText: "Sign in to check out faster and keep orders next to your bundle payments.",
    backShop: "Back to the shop",
    breadcrumb: "Breadcrumb",
    fewer: "Fewer",
    more: "More",
    buyNote: "Pay with MTN MoMo or Orange Money. Collect at {place} with your order code. No account needed.",
    checkoutHow: "How would you like to check out?",
    payerHint: "The number that pays.",
    collectAt: "Collect at {place}",
    deliveryLater: "Delivery comes later.",
    payWith: "Pay with",
    keepLink: "Keep this private link",
    keepLinkText: "You bought as a guest. This link is the only way back to this order — copy or bookmark it.",
    copyShort: "Copy",
    claimGuest: "Save to an account",
    codeHelp: "Show this at {place}. Staff check it before handing over.",
    specsAll: "Specifications, box contents, warranty",
    signInstead: "Sign in to NDAHI",
    signInsteadHelp: "Details filled in, order saved in your account.",
    progress: "Order progress",
    stepPaid: "Paid",
    stepPreparing: "Prepared and tested",
    stepReady: "Ready to collect",
    stepCollected: "Collected",
    signed: "You are signed in. This purchase will appear in your account.",
    name: "Full name",
    phone: "Contact phone",
    email: "Email (optional, for order updates)",
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
    ready: "Ready to collect",
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
    all: "Tout",
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
    guestChoice: "Un nom et un numéro suffisent. Vous recevez un lien de suivi privé.",
    guestTitle: "Continuer en invité",
    inStock: "en stock",
    onlyLeft: "Plus que {n}",
    view: "Voir",
    trackShort: "Suivre",
    trackLong: "Suivre une commande",
    internetNav: "Forfaits Internet",
    storeSub: "Boutique",
    internetRow: "Vous cherchez un forfait Internet ?",
    customerTitle: "Déjà client NDAHI ?",
    customerText: "Connectez-vous pour payer plus vite et retrouver vos commandes avec vos paiements de forfaits.",
    backShop: "Retour à la boutique",
    breadcrumb: "Fil d’Ariane",
    fewer: "Moins",
    more: "Plus",
    buyNote: "Payez avec MTN MoMo ou Orange Money. Retirez à {place} avec votre code de commande. Aucun compte requis.",
    checkoutHow: "Comment souhaitez-vous payer ?",
    payerHint: "Le numéro qui paie.",
    collectAt: "Retrait à {place}",
    deliveryLater: "La livraison viendra plus tard.",
    payWith: "Payer avec",
    keepLink: "Gardez ce lien privé",
    keepLinkText: "Vous avez acheté en invité. Ce lien est le seul moyen de revenir à cette commande — copiez-le ou ajoutez-le aux favoris.",
    copyShort: "Copier",
    claimGuest: "Enregistrer dans un compte",
    codeHelp: "Montrez-le à {place}. L’équipe le vérifie avant la remise.",
    specsAll: "Caractéristiques, contenu, garantie",
    signInstead: "Se connecter à NDAHI",
    signInsteadHelp: "Coordonnées remplies, commande enregistrée dans votre compte.",
    how: "Comment acheter",
    step1: "Choisissez un appareil",
    step2: "Payez en invité ou connecté",
    step3: "Retirez avec votre code",
    step3At: "Retirez à {place} avec votre code",
    progress: "Suivi de la commande",
    stepPaid: "Payée",
    stepPreparing: "Préparée et testée",
    stepReady: "Prête à retirer",
    stepCollected: "Retirée",
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
    n == null ? (lang === "fr" ? "Prix à confirmer" : "Price to be confirmed") : `${Number(n).toLocaleString(lang === "fr" ? "fr-CM" : "en-CM")} FCFA`;
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
  $("#storeName").textContent = t("storeSub");
  document.documentElement.lang = lang;
  document
    .querySelectorAll("[data-label]")
    .forEach((el) => (el.textContent = t(el.dataset.label)));
  $("#portal").href = data.portalUrl + "/login";
  $("#internetNav").href = data.portalUrl + "/onboarding.html";
  $("#internet").href = data.portalUrl + "/onboarding.html";
  $("#internet").textContent = t("internet");
  $("#footerText").textContent = t("footer");
  $("#storeContact").textContent = data.settings.contact;
  $("#footerPolicies").innerHTML = `<summary>${h(t("policies"))}</summary><h3>${h(t("warranty"))}</h3><p>${h(l(data.settings.warranty))}</p><h3>${h(t("returns"))}</h3><p>${h(l(data.settings.returns))}</p>`;
}
const ICON = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18 9 12l6-6"/></svg>',
  chevron: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>',
  store: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 9h18l-1.5-5h-15L3 9Z"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></svg>',
  person: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg>',
};
const category_ = (p) => l(data.categories.find((c) => c.id === p.categoryId)?.name);
// Stock as the canvas words it: "6 in stock", "Only 2 left" (amber), "Out of stock".
function stock(p) {
  if (!p.available) return { text: t("unavailable"), low: true };
  if (p.available <= 2) return { text: t("onlyLeft").replace("{n}", p.available), low: true };
  return { text: `${p.available} ${t("inStock")}`, low: false };
}
let shopScroll = 0;
// A checkout interrupted after submitting can be resumed (same key, no double order).
const resumeNotice = () => pendingCheckout() ? `<p class="notice"><button id="resumeCheckout" class="secondary">${lang === "fr" ? "Reprendre ma commande" : "Resume checkout"}</button></p>` : "";
function bindResume() {
  if ($("#resumeCheckout"))
    $("#resumeCheckout").onclick = () => {
      selected = pendingCheckout().product;
      showCheckout();
    };
}
// Shop (canvas: PhoneGuestShop rows, StoreGuest cards).
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
  // The canvas has no search; it appears only once the catalogue outgrows the chips.
  const searchable = data.products.length > 8;
  $("#view").innerHTML =
    `<section class="hero"><div><span class="eyebrow hero-domain">${h(location.hostname)}</span><h1>${t("headline")}</h1><p>${h(l(data.settings.introduction) || t("intro"))}</p></div><ol class="steps" aria-label="${h(t("how"))}"><li><span aria-hidden="true">1</span>${h(t("step1"))}</li><li><span aria-hidden="true">2</span>${h(t("step2"))}</li><li><span aria-hidden="true">3</span>${h(place() ? t("step3At").replace("{place}", place()) : t("step3"))}</li></ol></section>${l(data.settings.banner) ? `<p class="notice">${h(l(data.settings.banner))}</p>` : ""}${resumeNotice()}${!data.settings.open ? `<p class="notice">${h(t("closed"))}</p>` : ""}<section id="devices" aria-labelledby="devicesTitle"><h2 id="devicesTitle" class="visually-hidden">${h(t("devices"))}</h2>${searchable ? `<input class="search" type="search" id="search" aria-label="${h(t("search"))}" placeholder="${h(t("search"))}" value="${h(search)}">` : ""}<div class="filters"><button data-category="" class="${!category ? "active" : ""}">${h(t("all"))}</button>${data.categories.map((c) => `<button data-category="${h(c.id)}" class="${category === c.id ? "active" : ""}">${h(l(c.name))}</button>`).join("")}</div><div class="products">${products.length ? products.map((p) => { const s = stock(p); return `<article class="product">${visual(p)}<div class="product-body"><p class="product-category">${h(category_(p))}</p><h3>${h(l(p.name))}</h3><div class="product-bottom"><p><span class="price">${h(money(p.price))}</span><span class="product-stock${s.low ? " is-low" : ""}">${h(s.text)}</span></p><button data-product="${h(p.id)}" aria-label="${h(t("details"))}: ${h(l(p.name))}"><span class="wide">${h(t("view"))}</span><span class="narrow">${ICON.chevron}</span></button></div></div></article>`; }).join("") : `<div class="empty"><h3>${h(t("empty"))}</h3><p>${h(t("emptyText"))}</p></div>`}</div></section><a class="internet-row narrow" href="${h(data.portalUrl)}/onboarding.html" target="_blank" rel="noopener">${h(t("internetRow"))}<span aria-hidden="true">→</span></a>${account.authenticated ? "" : `<section class="customer-bar wide"><div><h2>${h(t("customerTitle"))}</h2><p>${h(t("customerText"))}</p></div><a class="button dark" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(t("account"))}</a></section>`}`;
  bindResume();
  if ($("#search"))
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
  document.querySelectorAll("[data-product]").forEach(
    (b) =>
      (b.onclick = () => {
        shopScroll = scrollY;
        location.hash = `#product/${encodeURIComponent(b.dataset.product)}`;
      }),
  );
}
// Specification rows (canvas: ProductDesktop table). "Key: value" lines in the
// specifications become their own rows; the other fields are one row each.
function specRows(p) {
  const rows = [];
  for (const line of l(p.specifications).split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    rows.push(m ? [m[1], m[2]] : [t("specifications"), line]);
  }
  for (const k of ["compatibility", "contents", "warranty", "setup"]) if (l(p[k])) rows.push([t(k), l(p[k])]);
  rows.push([lang === "fr" ? "Référence" : "SKU", p.sku]);
  return `<dl class="spec-table">${rows.map(([k, v]) => `<div class="${v.length > 40 ? "is-long" : ""}"><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join("")}</dl><p class="form-help">${h(t("separate"))}</p>`;
}
let qty = 1;
// Product page (canvas: PhoneGuestProduct, ProductDesktop): its own address.
function renderProduct(id) {
  selected = data.products.find((p) => p.id === id);
  const p = selected;
  if (!p) return renderShop();
  qty = 1;
  const s = stock(p), cat = category_(p),
    blocked = p.price == null || !p.available || !data.settings.open || !data.paymentProviders.length,
    max = Math.max(1, Math.min(20, p.available || 1));
  $("#view").innerHTML =
    `<div class="bar narrow"><a class="bar-back" href="#shop" aria-label="${h(t("backShop"))}">${ICON.back}</a><span class="bar-title">${h(data.settings.name)}</span><a class="bar-link" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(t("account"))}</a></div>${resumeNotice()}<nav class="crumbs wide" aria-label="${h(t("breadcrumb"))}"><a href="#shop">${h(t("shop"))}</a>${cat ? ` / ${h(cat)}` : ""} / <span aria-current="page">${h(l(p.name))}</span></nav><div class="detail-grid"><div class="detail-media">${visual(p)}${(p.images || []).length > 1 ? `<div class="gallery">${p.images.map((im, i) => `<button type="button" class="thumb${i ? "" : " is-current"}" data-image="${i}" aria-label="${h(t("gallery"))} ${i + 1}"><img src="${h(im.data)}" alt=""></button>`).join("")}</div>` : ""}</div><div class="detail-info"><p class="eyebrow">${h(cat || p.sku)}</p><h1 id="productTitle">${h(l(p.name))}</h1><p class="price-row"><span class="price">${h(money(p.price))}</span><span class="stock${s.low ? " is-low" : ""}">${h(s.text)}</span></p><p class="details">${h(l(p.description))}</p><div class="buy-bar"><div class="stepper"><button type="button" data-step="-1" aria-label="${h(t("fewer"))}" ${blocked ? "disabled" : ""}>−</button><output id="qty" aria-live="polite" aria-label="${h(t("quantity"))}">1</output><button type="button" data-step="1" aria-label="${h(t("more"))}" ${blocked || max === 1 ? "disabled" : ""}>+</button></div><button id="buy" ${blocked ? "disabled" : ""}>${h(p.available ? t("buy") : t("unavailable"))}</button></div><p class="buy-note wide">${h(t("buyNote").replace("{place}", place() || data.settings.name))}</p><div class="wide">${specRows(p)}</div><details class="specs narrow"><summary>${h(t("specsAll"))}</summary>${specRows(p)}</details></div></div>`;
  document.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => {
    qty = Math.min(max, Math.max(1, qty + Number(b.dataset.step)));
    $("#qty").textContent = qty;
    document.querySelector('[data-step="-1"]').disabled = qty <= 1;
    document.querySelector('[data-step="1"]').disabled = qty >= max;
  }));
  if (!blocked) document.querySelector('[data-step="-1"]').disabled = true;
  document.querySelectorAll("[data-image]").forEach((b) => (b.onclick = () => {
    const image = p.images[Number(b.dataset.image)];
    const main = document.querySelector(".detail-media .product-visual img");
    if (main) { main.src = image.data; main.alt = l(image.alt); }
    document.querySelectorAll("[data-image]").forEach((x) => x.classList.toggle("is-current", x === b));
  }));
  $("#buy").onclick = () => showCheckout();
  bindResume();
  scrollTo(0, 0);
}
function showCheckout() {
  const pending = pendingCheckout();
  if (pending) {
    selected = pending.product;
    checkoutKey = pending.input.checkoutKey;
  } else checkoutKey = crypto.randomUUID();
  const c = pending ? pending.input : account.customer || {};
  const count = Number(c.quantity) || qty || 1;
  $("#checkoutDetail").innerHTML =
    `<h2 id="checkoutTitle">${h(t("checkoutHow"))}</h2><p class="checkout-line">${h(l(selected.name))} × ${h(count)} · ${h(money(selected.price * count))}</p>${account.authenticated ? `<p class="notice notice--quiet">${h(t("signed"))}</p>` : `<div class="checkout-choice"><div class="choice is-chosen"><span class="choice__icon">${ICON.store}</span><span><strong>${h(t("guestTitle"))}</strong><span>${h(t("guestChoice"))}</span></span></div><a class="choice" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener"><span class="choice__icon">${ICON.person}</span><span><strong>${h(t("signInstead"))}</strong><span>${h(t("signInsteadHelp"))}</span></span></a></div>`}<form id="checkoutForm"><div class="form-grid"><div><label for="name">${h(t("name"))}</label><input id="name" name="name" required maxlength="120" autocomplete="name" value="${h(c.name || "")}"></div><div><label for="phone">${h(t("phone"))}</label><input id="phone" name="phone" type="tel" required autocomplete="tel" value="${h(c.phone || "")}" placeholder="6XXXXXXXX"></div><div><label for="payerPhone">${h(t("payer"))}</label><input id="payerPhone" name="payerPhone" type="tel" required aria-describedby="payerHint" value="${h(c.payerPhone || c.phone || "")}" placeholder="6XXXXXXXX"><p class="form-help" id="payerHint">${h(t("payerHint"))}</p></div><div><label for="email">${h(t("email"))}</label><input id="email" name="email" type="email" autocomplete="email" value="${h(c.email || "")}"></div></div><input type="hidden" id="quantity" name="quantity" value="${h(count)}"><div class="collect-box"><strong>${h(place() ? t("collectAt").replace("{place}", place()) : t("pickup"))}</strong><span>${h(l(data.settings.hours))}</span><span>${h(t("deliveryLater"))}</span></div><fieldset class="pay-with"><legend>${h(t("payWith"))}</legend><label class="method"><input type="radio" name="network" value="mtn" ${c.network === "orange" ? "" : "checked"}><span>MTN Mobile Money</span></label><label class="method"><input type="radio" name="network" value="orange" ${c.network === "orange" ? "checked" : ""}><span>Orange Money</span></label></fieldset><div class="checkout-summary"><span>${h(t("total"))}</span><strong id="total">${h(money(selected.price * count))}</strong></div><p class="form-help">${h(t("payHelp"))}</p><p class="form-help">${h(t("reserved"))}</p><p class="form-help">${h(t("separate"))}</p><details class="policy"><summary>${h(t("policies"))}</summary><p>${h(l(selected.warranty) || l(data.settings.warranty))}</p><p>${h(l(data.settings.returns))}</p></details><div class="actions"><button type="submit">${h(t("pay"))}</button></div><p id="checkoutError" class="error" role="alert"></p></form>`;
  if (pending)
    $("#checkoutForm")
      .querySelectorAll("input,select")
      .forEach((el) => (el.disabled = true));
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
// Collection point without a trailing full stop, for sentences that add their own.
function place() {
  return l(data?.settings?.pickup).replace(/[\s.]+$/, "");
}
// Paid orders show where they are (canvas: PhoneGuestOrder).
function progress(o) {
  if (o.paymentStatus !== "paid" || ["review", "cancelled"].includes(o.status)) return "";
  const at = o.status === "collected" ? 4 : o.status === "ready" ? 2 : 1;
  return `<ol class="progress" aria-label="${h(t("progress"))}">${["stepPaid", "stepPreparing", "stepReady", "stepCollected"].map((key, i) => `<li class="${i < at ? "done" : i === at ? "current" : ""}"${i === at ? ' aria-current="step"' : ""}><span aria-hidden="true">${i < at ? ICON.check : ""}</span>${h(t(key))}</li>`).join("")}</ol>`;
}
// A compact order for the My orders list.
function orderCard(o) {
  return `<article class="order-card"><span class="eyebrow">${h(o.reference)}</span><h3>${h(l(o.product.name))} × ${h(o.quantity)}</h3><p>${h(money(o.amount))} · ${h(t(o.paymentStatus))}${o.refundStatus === "failed" ? ` · ${lang === "fr" ? "Échec du remboursement — contactez la boutique" : "Refund failed — contact the store"}` : ""}</p><span class="order-status">${h(t(o.status))}</span>${progress(o)}${o.paymentReview ? `<p class="notice">${h(t(o.paymentReview === "late_payment" ? "late" : "paymentReview"))}</p>` : ""}${o.collectionCode ? `<h4>${h(t("collection"))}</h4><p class="collection">${h(o.collectionCode)}</p><p class="form-help">${h(t("collectionHelp"))}</p>` : ""}<p><strong>${h(t("pickup"))}</strong><br>${h(o.pickup)}<br>${h(o.hours)}</p>${o.serialNumbers ? `<p>${h(o.serialNumbers)}</p>` : ""}<details class="policy"><summary>${h(t("policies"))}</summary><h4>${h(t("warranty"))}</h4><p>${h(l(o.product.warranty))}</p><h4>${h(t("returns"))}</h4><p>${h(l(o.returns))}</p></details></article>`;
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
const toneOf = (o) => o.paymentStatus === "paid" ? (["ready", "collected"].includes(o.status) ? "ready" : "info") : ["failed", "expired"].includes(o.paymentStatus) ? "danger" : "waiting";
// One order (canvas: PhoneGuestOrder): its bar, the line, the collection code as
// the forest card, progress, the private link for guests, then Receipt and Save.
async function showOrder(id, token, verify = false) {
  const result = await call(
    account.authenticated
      ? `/api/account/store/${verify ? "verify" : "order"}`
      : `/api/store/${verify ? "verify" : "order"}`,
    { orderId: id, token },
  );
  const o = result.order, paid = o.paymentStatus === "paid", link = token ? location.origin + "/" + orderHash(id, token) : "";
  $("#view").innerHTML =
    `<div class="order-page"><div class="bar"><a class="bar-back" href="#orders" aria-label="${h(t("orders"))}">${ICON.back}</a><h1 class="bar-title">${h(t("order"))} ${h(o.reference)}</h1></div><div class="order-line">${visual(o.product)}<div><strong>${h(l(o.product.name))} × ${h(o.quantity)}</strong><span>${h(money(o.amount))} · ${h(t(o.paymentStatus))}${o.refundStatus === "failed" ? ` · ${lang === "fr" ? "Échec du remboursement — contactez la boutique" : "Refund failed — contact the store"}` : ""}</span></div><span class="order-status is-${toneOf(o)}">${h(t(o.status))}</span></div>${o.paymentReview ? `<p class="notice">${h(t(o.paymentReview === "late_payment" ? "late" : "paymentReview"))}</p>` : ""}${o.collectionCode ? `<section class="code-card" aria-labelledby="codeTitle"><h2 class="eyebrow" id="codeTitle">${h(t("collection"))}</h2><p class="code-card__code">${h(o.collectionCode)}</p><p>${h(t("codeHelp").replace("{place}", (o.pickup || place()).replace(/[\s.]+$/, "")))}</p></section>` : ""}${progress(o)}${token && !account.authenticated ? `<section class="keep-link" aria-labelledby="keepTitle"><h2 id="keepTitle">${h(t("keepLink"))}</h2><p>${h(t("keepLinkText"))}</p><div class="keep-link__row"><input readonly id="privateLink" aria-label="${h(t("link"))}" value="${h(link)}"><button type="button" id="copyLink">${h(t("copyShort"))}</button></div></section>` : ""}<div class="order-facts"><p><strong>${h(t("pickup"))}</strong><br>${h(o.pickup)}<br>${h(o.hours)}</p>${o.serialNumbers ? `<p>${h(o.serialNumbers)}</p>` : ""}<details class="policy"><summary>${h(t("policies"))}</summary><h4>${h(t("warranty"))}</h4><p>${h(l(o.product.warranty))}</p><h4>${h(t("returns"))}</h4><p>${h(l(o.returns))}</p></details></div>${paid ? "" : `<p class="form-help">${h(t("reserved"))}</p>`}<div class="order-actions">${paid ? "" : `<button id="checkPayment">${h(t("check"))}</button>`}${o.receiptAvailable ? `<button class="secondary" id="downloadStoreReceipt">Download receipt</button>` : ""}${token ? account.authenticated ? `<button class="secondary" id="claimOrder">${h(t("claimGuest"))}</button>` : `<a class="button secondary" id="signToClaim" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(t("claimGuest"))}</a>` : ""}</div>${token && !account.authenticated ? `<p class="form-help">${h(t("signHelp"))}</p>` : ""}</div>`;
  if ($("#checkPayment"))
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
        await navigator.clipboard.writeText(link);
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
  const parts = location.hash.slice(1).split("/");
  const view = parts[0] === "order" && parts[1] ? "order" : parts[0] === "product" && parts[1] ? "product" : parts[0] === "orders" ? "orders" : "shop";
  document.body.dataset.view = view;
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.dataset.nav === (view === "orders" || view === "order" ? "orders" : "shop")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  try {
    if (view === "order")
      await showOrder(
        decodeURIComponent(parts[1]),
        parts[2] ? decodeURIComponent(parts[2]) : undefined,
      );
    else if (view === "orders") await showOrders();
    else if (view === "product") renderProduct(decodeURIComponent(parts[1]));
    else {
      renderShop();
      if (shopScroll) { scrollTo(0, shopScroll); shopScroll = 0; }
    }
  } catch (e) {
    $("#message").textContent = e.message;
  }
}

document
  .querySelectorAll(".close")
  .forEach((b) => (b.onclick = () => b.closest("dialog").close()));
// The product page closes like the sheet it replaces: Escape returns to the shop.
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.body.dataset.view === "product" && !document.querySelector("dialog[open]")) location.hash = "#shop";
});
// A guest who signs in from an order (new tab) can save it here on return.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || account.authenticated || document.body.dataset.view !== "order") return;
  try { await refreshAccount(); if (account.authenticated) await route(); } catch { /* stay as guest */ }
});
window.addEventListener("hashchange", route);
try {
  [data] = await Promise.all([call("/api/store/catalogue"), refreshAccount()]);
  await route();
} catch (e) {
  $("#view").textContent = e.message;
}
