import { escapeHtml as h } from "/shared/safe-html.js";
import { createPromo } from "./promo.js";
const $ = (s) => document.querySelector(s),
  api = window.NDAHI_CONFIG.apiUrl;
// A product photo's address: the API serves photos by path; a photo saved
// before photos were stored on their own is a data URL.
const photoSrc = (image) => (image?.src?.startsWith("/") ? api.replace(/\/$/, "") + image.src : image?.src || "");
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
    // The phone board's shorter line (PhoneGuestShop, #403; owner 26 Nov).
    introPhone: "No account needed. Pay with Mobile Money, collect locally.",
    policyWarranty: "Warranty policy",
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
    buy: "Buy now",
    // The phone product's tiles (canvas: PhoneGuestProduct, #402).
    needs: "Needs",
    internetTile: "Internet",
    soldSeparately: "Sold separately",
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
    collectAt: "Collect at {place}",
    fromAccount: "from your account", guestWord: "guest",
    payWith: "Pay with",
    keepLink: "Keep this private link",
    keepLinkText: "You bought as a guest. This link is the only way back to this order — copy or bookmark it.",
    copyShort: "Copy",
    copied: "Copied",
    copyFailed: "Select the link and copy it.",
    receiptShort: "Receipt",
    heldUntil: "Held for you until {date}",
    claimGuest: "Save to an account",
    codeHelp: "Show this at {place}. Staff check it before handing over.",
    specsAll: "Specifications, box contents, warranty",
    signInstead: "Sign in to NDAHI",
    signInsteadHelp: "Details filled in, order saved in Activity.",
    // Checkout in four steps (canvas: PhoneGuestCheckout, #400).
    checkoutBar: "Checkout",
    guestCheckoutBar: "Guest checkout",
    backProduct: "Back to product",
    backStep: "Back",
    waitingBar: "Waiting for payment",
    confirmedBar: "Order confirmed",
    payerNote: "— the one that pays",
    emailLabel: "Email",
    emailNote: "— optional, for order updates",
    deliveryLaterShort: "Delivery comes later",
    feeLabel: "Mobile Payment Fee (2%)",
    feeLabelPlain: "Mobile Payment Fee",
    totalToPay: "Total to Pay",
    walletNote: "Ensure you have at least {total} in your {method} wallet (includes 2% mobile payment fee). Keep your screen unlocked to enter your PIN.",
    walletNoteNoFee: "Ensure you have {price} plus the Mobile Money fee in your {method} wallet. Keep your screen unlocked to enter your PIN.",
    payNow: "Pay Now",
    approveTitle: "Approve on your phone",
    approveText: "A {method} request for {total} (incl. {fee} fee) was sent to {number}. If this page closes, reopen the store in the same browser to pick up where you left off.",
    approveTextNoFee: "A {method} request for {price} plus the Mobile Money fee was sent to {number}. If this page closes, reopen the store in the same browser to pick up where you left off.",
    checkStatus: "Check status",
    changePayment: "Change payment",
    stillWaiting: "Not confirmed yet. Approve the request on your phone, then check again.",
    paymentEnded: "This payment didn't go through. Choose Change payment to try again.",
    placedTitle: "Order placed",
    placedText: "Order {ref} is paid. Your tracking link shows when it's ready to collect.",
    keepTitle: "Save your private tracking link",
    keepText: "Copy or bookmark it — we also email it if you gave an address. Anyone with the link can see this order.",
    accountTitle: "Want this in an account?",
    accountText: "Sign in or sign up with the same number and the order moves into Activity.",
    saveToAccount: "Save to an account",
    trackOrder: "Track my order",
    progress: "Order progress",
    stepPaid: "Paid",
    stepPreparing: "Prepared and tested",
    stepReady: "Ready to collect",
    stepCollected: "Collected",
    signed: "You are signed in. This purchase will appear in your account.",
    name: "Full name",
    email: "Email (optional, for order updates)",
    payer: "Mobile Money number",
    network: "Payment network",
    quantity: "Quantity",
    // Price, Mobile Money fee and total, all from the server (#297, canvas: PhoneGuestCheckout).
    pay: "Pay {total}",
    item: "Item",
    feeInPrompt: "Shown in your prompt",
    requestSent: "A {method} request for {total} (incl. {fee} fee) was sent. If this page closes, reopen the store in the same browser to pick up where you left off.",
    requestSentNoFee: "A {method} request for {price} plus the Mobile Money fee shown in your prompt was sent. If this page closes, reopen the store in the same browser to pick up where you left off.",
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
    link: "Private tracking link",
    open: "Open order",
    paymentReview:
      "Payment verification needs another check. Do not start a second payment.",
    gallery: "Product image",
    photoOf: "Show photo {n} of {count}",
    banner: "Store update",
  },
  fr: {
    shop: "Boutique",
    orders: "Mes commandes",
    account: "Se connecter",
    eyebrow: "LA BOUTIQUE NDAHI",
    headline: "Des équipements pour de meilleures connexions.",
    intro:
      "Des routeurs et répéteurs testés sur notre réseau. Achetez sans compte — payez par Mobile Money et retirez sur place.",
    introPhone: "Sans compte. Payez par Mobile Money, retirez sur place.",
    policyWarranty: "Politique de garantie",
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
    buy: "Acheter",
    needs: "Nécessite",
    internetTile: "Internet",
    soldSeparately: "Vendu séparément",
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
    collectAt: "Retrait à {place}",
    fromAccount: "depuis votre compte", guestWord: "invité",
    payWith: "Payer avec",
    keepLink: "Gardez ce lien privé",
    keepLinkText: "Vous avez acheté en invité. Ce lien est le seul moyen de revenir à cette commande — copiez-le ou ajoutez-le aux favoris.",
    copyShort: "Copier",
    copied: "Copié",
    copyFailed: "Sélectionnez le lien et copiez-le.",
    receiptShort: "Reçu",
    heldUntil: "Gardée pour vous jusqu'au {date}",
    claimGuest: "Enregistrer dans un compte",
    codeHelp: "Montrez-le à {place}. L’équipe le vérifie avant la remise.",
    specsAll: "Caractéristiques, contenu, garantie",
    signInstead: "Se connecter à NDAHI",
    signInsteadHelp: "Coordonnées remplies, commande enregistrée dans Activité.",
    checkoutBar: "Paiement",
    guestCheckoutBar: "Paiement en invité",
    backProduct: "Retour au produit",
    backStep: "Retour",
    waitingBar: "En attente du paiement",
    confirmedBar: "Commande confirmée",
    payerNote: "— celui qui paie",
    emailLabel: "E-mail",
    emailNote: "— facultatif, pour le suivi de commande",
    deliveryLaterShort: "La livraison viendra plus tard",
    feeLabel: "Frais de paiement mobile (2 %)",
    feeLabelPlain: "Frais de paiement mobile",
    totalToPay: "Total à payer",
    walletNote: "Assurez-vous d'avoir au moins {total} sur votre portefeuille {method} (frais de paiement mobile de 2 % inclus). Gardez l'écran déverrouillé pour saisir votre code.",
    walletNoteNoFee: "Assurez-vous d'avoir {price} plus les frais Mobile Money sur votre portefeuille {method}. Gardez l'écran déverrouillé pour saisir votre code.",
    payNow: "Payer",
    approveTitle: "Validez sur votre téléphone",
    approveText: "Une demande {method} de {total} (dont {fee} de frais) a été envoyée au {number}. Si cette page se ferme, rouvrez la boutique dans le même navigateur pour reprendre.",
    approveTextNoFee: "Une demande {method} de {price} plus les frais Mobile Money a été envoyée au {number}. Si cette page se ferme, rouvrez la boutique dans le même navigateur pour reprendre.",
    checkStatus: "Vérifier le statut",
    changePayment: "Changer de paiement",
    stillWaiting: "Pas encore confirmé. Validez la demande sur votre téléphone, puis vérifiez à nouveau.",
    paymentEnded: "Ce paiement n'a pas abouti. Choisissez Changer de paiement pour réessayer.",
    placedTitle: "Commande passée",
    placedText: "La commande {ref} est payée. Votre lien de suivi indique quand elle est prête à retirer.",
    keepTitle: "Gardez votre lien de suivi privé",
    keepText: "Copiez-le ou ajoutez-le aux favoris — nous l'envoyons aussi par e-mail si vous en avez donné un. Toute personne ayant le lien peut voir cette commande.",
    accountTitle: "Vous voulez la retrouver dans un compte ?",
    accountText: "Connectez-vous ou créez un compte avec le même numéro et la commande passe dans Activité.",
    saveToAccount: "Enregistrer dans un compte",
    trackOrder: "Suivre ma commande",
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
    email: "Email (facultatif)",
    payer: "Numéro Mobile Money",
    network: "Réseau de paiement",
    quantity: "Quantité",
    pay: "Payer {total}",
    item: "Article",
    feeInPrompt: "Indiqués dans la demande",
    requestSent: "Une demande {method} de {total} (dont {fee} de frais) a été envoyée. Si cette page se ferme, rouvrez la boutique dans le même navigateur pour reprendre.",
    requestSentNoFee: "Une demande {method} de {price}, plus les frais Mobile Money indiqués dans la demande, a été envoyée. Si cette page se ferme, rouvrez la boutique dans le même navigateur pour reprendre.",
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
    link: "Lien de suivi privé",
    open: "Ouvrir la commande",
    paymentReview:
      "La vérification du paiement nécessite un nouveau contrôle. Ne lancez pas un second paiement.",
    gallery: "Image du produit",
    photoOf: "Afficher la photo {n} sur {count}",
    banner: "Actualité boutique",
  },
};
const t = (key) => words[lang][key] || key,
  // A sentence with its {placeholders} filled in.
  tf = (key, values) => t(key).replace(/\{(\w+)\}/g, (match, name) => (name in values ? String(values[name]) : match)),
  METHODS = { mtn: "MTN MoMo", orange: "Orange Money" },
  // The server's quote for this quantity on this network (paymentQuotes, #297).
  quoteOf = (p, network, count) => { const q = p?.paymentQuotes?.[network]?.[count - 1]; return Number.isFinite(q?.total) ? q : null; },
  l = (value) =>
    typeof value === "object" ? value?.[lang] || value?.en || "" : value || "",
  money = (n) =>
    n == null ? (lang === "fr" ? "Prix à confirmer" : "Price to be confirmed") : `${Number(n).toLocaleString(lang === "fr" ? "fr-CM" : "en-CM")} FCFA`;
// Store promotions (#302): banner, product extras, checkout lines, countdowns.
const promo = createPromo({ lang, money, l });
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
  return `<div class="product-visual">${p.images?.[0] ? `<img src="${h(photoSrc(p.images[0]))}" alt="${h(l(p.images[0].alt))}" loading="lazy">` : '<svg viewBox="0 0 120 100" fill="none" aria-hidden="true"><path d="M60 15 100 35 60 55 20 35 60 15Z" stroke="currentColor" stroke-width="2"/><path d="M20 35v35l40 20 40-20V35M60 55v35M40 25l40 20" stroke="currentColor" stroke-width="2"/></svg>'}${p.featured ? `<span class="badge">${h(t("featured"))}</span>` : ""}</div>`;
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
}
const ICON = {
  back: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M15 18 9 12l6-6"/></svg>',
  chevron: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m9 18 6-6-6-6"/></svg>',
  check: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M20 6 9 17l-5-5"/></svg>',
  store: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M3 9h18l-2-6H5Zm2 0v12h14V9M9 21v-7h6v7"/></svg>',
  person: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a8 6 0 0 1 16 0v2"/></svg>',
  // A done step on the order's progress (canvas: PhoneOrder).
  tick: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 12 5 5 9-10"/></svg>',
  // The checkout's waiting and placed steps (canvas: PhoneGuestCheckout).
  phone: '<svg width="38" height="38" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 2h14v20H5ZM10 18h4M12 7v4l2 2"/></svg>',
  done: '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 12 5 5 9-10"/></svg>',
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
    `${promo.hero(data)}<section class="hero"><div><span class="eyebrow hero-domain">${h(location.hostname)}</span><h1>${t("headline")}</h1><p><span class="narrow">${h(t("introPhone"))}</span><span class="wide">${h(t("intro"))}</span></p></div><ol class="steps" aria-label="${h(t("how"))}"><li><span aria-hidden="true">1</span>${h(t("step1"))}</li><li><span aria-hidden="true">2</span>${h(t("step2"))}</li><li><span aria-hidden="true">3</span>${h(place() ? t("step3At").replace("{place}", place()) : t("step3"))}</li></ol></section>${l(data.settings.banner) ? `<p class="notice">${h(l(data.settings.banner))}</p>` : ""}${resumeNotice()}${!data.settings.open ? `<p class="notice">${h(t("closed"))}</p>` : ""}<section id="devices" aria-labelledby="devicesTitle"><h2 id="devicesTitle" class="visually-hidden">${h(t("devices"))}</h2>${searchable ? `<input class="search" type="search" id="search" aria-label="${h(t("search"))}" placeholder="${h(t("search"))}" value="${h(search)}">` : ""}<div class="filters"><button data-category="" class="${!category ? "active" : ""}">${h(t("all"))}</button>${data.categories.map((c) => `<button data-category="${h(c.id)}" class="${category === c.id ? "active" : ""}" aria-label="${h(l(c.name))}"><span class="narrow" aria-hidden="true">${h(l(c.shortName) || l(c.name))}</span><span class="wide" aria-hidden="true">${h(l(c.name))}</span></button>`).join("")}</div><div class="products">${products.length ? products.map((p) => { const s = stock(p), pc = promo.card(p); return `<article class="product${pc ? " product--promo" : ""}">${pc ? `<div class="promo-visual">${visual(p)}${pc.badge}</div>` : visual(p)}<div class="product-body"><p class="product-category">${h(category_(p))}</p><h3>${h(l(p.name))}</h3>${pc ? pc.chip : ""}<div class="product-bottom"><p><span class="price">${h(money(p.price))}${pc ? pc.regular : ""}</span><span class="product-stock${s.low || pc ? " is-low" : ""}">${h(pc && p.available ? pc.stock : s.text)}</span></p><button data-product="${h(p.id)}" aria-label="${h(t("details"))}: ${h(l(p.name))}"><span class="wide">${h(pc ? pc.button : t("view"))}</span><span class="narrow" aria-hidden="true">›</span></button></div></div></article>`; }).join("") : `<div class="empty"><h3>${h(t("empty"))}</h3><p>${h(t("emptyText"))}</p></div>`}</div></section><a class="internet-row narrow" href="${h(data.portalUrl)}/onboarding.html" target="_blank" rel="noopener">${h(t("internetRow"))}<span aria-hidden="true">→</span></a>${account.authenticated ? "" : `<section class="customer-bar wide"><div><h2>${h(t("customerTitle"))}</h2><p>${h(t("customerText"))}</p></div><a class="button dark" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(t("account"))}</a></section>`}`;
  bindResume();
  promo.tick($("#view"), () => void reloadCatalogue());
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
// "Needs" (set in Admin) and "Internet: Sold separately", as tiles on phones
// (canvas: PhoneGuestProduct, #402). An offer that includes internet (#302)
// leaves out the Internet tile.
function factTiles(p) {
  const tiles = [...(l(p.needs) ? [[t("needs"), l(p.needs)]] : []), ...(p.promotion?.bonus ? [] : [[t("internetTile"), t("soldSeparately")]])];
  return tiles.length ? `<dl class="facts narrow">${tiles.map(([k, v]) => `<div><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join("")}</dl>` : "";
}
// The spec table (canvas: ProductDesktop, #415; owner 26 Nov): the product's key
// specs from Admin, then the store's warranty and returns. On desktop they are
// the whole table; until a product has key specs, and on phones inside
// "Specifications, box contents, warranty", the product's texts follow as rows.
function specRows(p, { desktop = false } = {}) {
  const keys = (p.keySpecs || []).map((row) => [l(row.label), l(row.value)]).filter(([k, v]) => k && v);
  if (desktop && keys.length) {
    const rows = [...keys];
    if (l(data.settings.warranty)) rows.push([t("policyWarranty"), l(data.settings.warranty)]);
    if (l(data.settings.returns)) rows.push([t("returns"), l(data.settings.returns)]);
    return `<dl class="spec-table spec-table--keys">${rows.map(([k, v]) => `<div class="${v.length > 40 ? "is-long" : ""}"><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join("")}</dl>`;
  }
  const rows = [...keys];
  for (const line of l(p.specifications).split(/\n+/).map((x) => x.trim()).filter(Boolean)) {
    const m = /^([^:]{1,40}):\s*(.+)$/.exec(line);
    rows.push(m ? [m[1], m[2]] : [t("specifications"), line]);
  }
  for (const k of ["compatibility", "contents", "warranty", "setup"]) if (l(p[k])) rows.push([t(k), l(p[k])]);
  rows.push([lang === "fr" ? "Référence" : "SKU", p.sku]);
  // The store's own policies, once in the footer (owner, 26 Nov: no footer).
  if (l(data.settings.warranty)) rows.push([t("policyWarranty"), l(data.settings.warranty)]);
  if (l(data.settings.returns)) rows.push([t("returns"), l(data.settings.returns)]);
  // A promotion's free bundle is internet included with the product (#302).
  return `<dl class="spec-table">${rows.map(([k, v]) => `<div class="${v.length > 40 ? "is-long" : ""}"><dt>${h(k)}</dt><dd>${h(v)}</dd></div>`).join("")}</dl>${p.promotion?.bonus ? "" : `<p class="form-help">${h(t("separate"))}</p>`}`;
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
    // An offer limits how many one phone number may buy (#302).
    max = Math.max(1, Math.min(p.promotion ? p.promotion.perNumberLimit : 20, p.available || 1)),
    pp = promo.product(p);
  // A deal on a phone (canvas: PhonePromoBuy, #411): the badge and time left on
  // the photo, the regular price crossed out only after real sales at it, no
  // "sold separately" tiles or details beyond its terms, no quantity unless the
  // offer allows more than one, and the limit under Get the deal.
  const one = pp && max === 1;
  $("#view").innerHTML =
    `<div class="bar narrow"><a class="bar-back" href="#shop" aria-label="${h(t("backShop"))}">${ICON.back}</a><span class="bar-title">${h(data.settings.name)}</span>${pp ? "" : `<a class="bar-link" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(t("account"))}</a>`}</div>${resumeNotice()}<nav class="crumbs wide" aria-label="${h(t("breadcrumb"))}"><a href="#shop">${h(t("shop"))}</a>${cat ? ` / ${h(cat)}` : ""} / <span aria-current="page">${h(l(p.name))}</span></nav><div class="detail-grid${pp ? " is-promo" : ""}"><div class="detail-media">${pp ? `<div class="promo-visual">${visual(p)}${pp.badge}${pp.strip}</div>` : visual(p)}${(p.images || []).length > 1 ? `<div class="gallery${pp ? " wide" : ""}" role="group" aria-label="${h(t("gallery"))}">${p.images.map((im, i) => `<button type="button" class="thumb${i ? "" : " is-current"}" data-image="${i}" aria-pressed="${i === 0}" aria-label="${h(t("photoOf").replace("{n}", i + 1).replace("{count}", p.images.length))}"><img src="${h(photoSrc(im))}" alt="" loading="lazy"></button>`).join("")}</div>` : ""}</div><div class="detail-info"><p class="eyebrow">${h(cat || p.sku)}</p><h1 id="productTitle">${h(l(p.name))}</h1><p class="price-row"><span class="price">${h(money(p.price))}${pp ? pp.regular : ""}</span><span class="stock${s.low || pp ? " is-low" : ""}">${h(pp && p.available ? pp.stock : s.text)}</span></p>${pp ? pp.bonus : ""}<p class="details">${h(l(p.description))}</p>${pp ? pp.terms : ""}${pp ? "" : factTiles(p)}<div class="buy-bar">${one ? "" : `<div class="stepper"><button type="button" data-step="-1" aria-label="${h(t("fewer"))}" ${blocked ? "disabled" : ""}>−</button><output id="qty" aria-live="polite" aria-label="${h(t("quantity"))}">1</output><button type="button" data-step="1" aria-label="${h(t("more"))}" ${blocked || max === 1 ? "disabled" : ""}>+</button></div>`}<button id="buy" ${blocked ? "disabled" : ""}>${h(p.available ? (pp ? pp.button : t("buy")) : t("unavailable"))}</button>${pp ? `<p class="promo-limit">${h(pp.limitCustomer)}</p>` : ""}</div><p class="buy-note wide">${h(t("buyNote").replace("{place}", place() || data.settings.name))}</p><div class="wide">${specRows(p, { desktop: true })}</div>${pp ? "" : `<details class="specs narrow"><summary>${h(t("specsAll"))}</summary>${specRows(p)}</details>`}</div></div>`;
  document.querySelectorAll("[data-step]").forEach((b) => (b.onclick = () => {
    qty = Math.min(max, Math.max(1, qty + Number(b.dataset.step)));
    $("#qty").textContent = qty;
    document.querySelector('[data-step="-1"]').disabled = qty <= 1;
    document.querySelector('[data-step="1"]').disabled = qty >= max;
  }));
  if (!blocked && document.querySelector('[data-step="-1"]')) document.querySelector('[data-step="-1"]').disabled = true;
  document.querySelectorAll("[data-image]").forEach((b) => (b.onclick = () => {
    const image = p.images[Number(b.dataset.image)];
    const main = document.querySelector(".detail-media .product-visual img");
    if (main) { main.src = photoSrc(image); main.alt = l(image.alt); }
    document.querySelectorAll("[data-image]").forEach((x) => { x.classList.toggle("is-current", x === b); x.setAttribute("aria-pressed", String(x === b)); });
  }));
  $("#buy").onclick = () => showCheckout();
  bindResume();
  promo.tick($("#view"), () => void reloadCatalogue());
  scrollTo(0, 0);
}
// Checkout (canvas: PhoneGuestCheckout, #400; owner 26 Nov) in four steps in
// the sheet: how to check out, the details (one Mobile Money number, which is
// also the contact), "Approve on your phone" with Check status and Change
// payment, and "Order placed" with the private link and Track my order.
let checkoutCount = 1, checkoutPending = null, checkoutPlaced = null;
const sheetTitle = (key, back) => {
  $("#checkoutDialog .sheet-bar__title").textContent = t(key);
  if (back) $("#checkoutDialog .close").setAttribute("aria-label", t(back));
};
const maskedNumber = (value) => { const d = String(value || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, ""); return d.length === 9 ? `${d[0]}•• •• ${d.slice(5, 7)} ${d.slice(7)}` : value || ""; };
function showCheckout() {
  const pending = pendingCheckout();
  checkoutPending = pending;
  checkoutPlaced = null;
  if (pending) {
    selected = pending.product;
    checkoutKey = pending.input.checkoutKey;
  } else checkoutKey = crypto.randomUUID();
  checkoutCount = Number(pending?.input?.quantity) || qty || 1;
  // A deal goes straight to its checkout, as drawn (PhonePromoBuy, #411).
  if (pending || account.authenticated || selected.promotion) checkoutDetails(pending ? pending.input : account.customer || {});
  else checkoutChoose();
  $("#checkoutDialog").showModal();
}
function checkoutChoose() {
  sheetTitle("checkoutBar", "backProduct");
  $("#checkoutDialog").dataset.step = "choose";
  $("#checkoutDetail").innerHTML = `<div class="checkout-main"><h2 id="checkoutTitle" tabindex="-1">${h(t("checkoutHow"))}</h2><p class="checkout-line">${h(l(selected.name))} × ${h(checkoutCount)} · ${h(money(selected.price * checkoutCount))}</p><div class="checkout-choice"><button type="button" class="choice is-chosen" id="checkoutGuest"><span class="choice__icon">${ICON.store}</span><span><strong>${h(t("guestTitle"))}</strong><span>${h(t("guestChoice"))}</span></span></button><a class="choice" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener"><span class="choice__icon">${ICON.person}</span><span><strong>${h(t("signInstead"))}</strong><span>${h(t("signInsteadHelp"))}</span></span></a></div></div>`;
  $("#checkoutGuest").onclick = () => checkoutDetails({});
  $("#checkoutTitle").focus();
}
// A deal's checkout (canvas: PhonePromoBuy; owner 27 Nov, #411): the order,
// how the free bundle arrives and where to collect, as drawn, then the name
// and number, Pay with, the wallet note and Pay Now.
const shortName = (name) => { const words = String(name || "").trim().split(/\s+/).filter(Boolean); return words.length > 1 ? `${words[0]} ${words.at(-1)[0]}.` : words[0] || ""; };
const buyLabels = () => ({ fee: t("feeLabel"), feePlain: t("feeLabelPlain"), inPrompt: t("feeInPrompt"), total: t("totalToPay") });
function buyNote(p, count, network) {
  const q = quoteOf(p, network, count), method = METHODS[network];
  return `<p class="checkout-cost__balance buy-note" id="buyNote" role="note">${q ? h(tf("walletNote", { total: "\u0000", method })).replace("\u0000", `<strong>${h(money(q.total))}</strong>`) : h(tf("walletNoteNoFee", { price: money(p.price * count), method }))}</p>`;
}
const buyWho = (name, phone, guest) => [shortName(name), maskedNumber(phone), t(guest ? "guestWord" : "fromAccount")].filter(Boolean).join(" · ");
function promoCheckoutDetails(c, guest, pending) {
  const network = c.network === "orange" ? "orange" : "mtn", count = checkoutCount, payer = c.payerPhone || c.phone || "";
  $("#checkoutDetail").innerHTML =
    `<form id="checkoutForm" class="checkout-step"><div class="checkout-main buy-main"><h2 id="checkoutTitle" class="visually-hidden" tabindex="-1">${h(t("checkoutBar"))}</h2>${promo.buyLines(selected, count, quoteOf(selected, network, count), buyLabels())}${promo.buyHow(selected, maskedNumber(payer), !guest)}<div class="collect-box buy-collect"><strong>${h(place() ? t("collectAt").replace("{place}", place()) : t("pickup"))}</strong><span id="buyWho">${h(buyWho(c.name, payer, guest))}</span></div><div class="form-grid buy-fields"><div><label for="name">${h(t("name"))}</label><input id="name" name="name" required maxlength="120" autocomplete="name" value="${h(c.name || "")}"></div><div><label for="payerPhone">${h(t("payer"))} <span class="label-note">${h(t("payerNote"))}</span></label><input id="payerPhone" name="payerPhone" type="tel" required autocomplete="tel" value="${h(payer)}" placeholder="6XXXXXXXX"></div></div><input type="hidden" id="quantity" name="quantity" value="${h(count)}"><fieldset class="pay-with"><legend>${h(t("payWith"))}</legend><div class="pay-with__methods"><label class="method"><input type="radio" name="network" value="mtn" ${network === "mtn" ? "checked" : ""}><span>MTN MoMo</span></label><label class="method"><input type="radio" name="network" value="orange" ${network === "orange" ? "checked" : ""}><span>Orange Money</span></label></div></fieldset>${buyNote(selected, count, network)}</div><div class="checkout-foot"><button type="submit" id="payButton">${h(t("payNow"))}</button><p id="checkoutError" class="error" role="alert"></p></div></form>`;
  const form = $("#checkoutForm");
  // The collect box and the free bundle's words follow the name and number as typed.
  form.oninput = (e) => {
    if (!["name", "payerPhone"].includes(e.target.name)) return;
    $("#buyWho").textContent = buyWho(form.elements.name.value, form.elements.payerPhone.value, guest);
    if (guest && $("#buyHowText")) $("#buyHowText").textContent = promo.howText(selected, maskedNumber(form.elements.payerPhone.value));
  };
  form.querySelectorAll('input[name="network"]').forEach((radio) => {
    radio.onchange = () => {
      $("#checkoutCost").outerHTML = promo.buyLines(selected, count, quoteOf(selected, radio.value, count), buyLabels());
      $("#buyNote").outerHTML = buyNote(selected, count, radio.value);
    };
  });
  if (pending) form.querySelectorAll("input,select").forEach((el) => (el.disabled = true));
}
function checkoutDetails(c) {
  const pending = checkoutPending, guest = !(pending ? pending.account : account.authenticated);
  // Back goes to the choice for a guest, otherwise back to the product.
  sheetTitle(guest ? "guestCheckoutBar" : "checkoutBar", guest && !pending ? "backStep" : "backProduct");
  $("#checkoutDialog").dataset.step = "details";
  const network = c.network === "orange" ? "orange" : "mtn", count = checkoutCount;
  if (selected.promotion) { sheetTitle("checkoutBar", "backProduct"); promoCheckoutDetails(c, guest, pending); }
  else $("#checkoutDetail").innerHTML =
    `<form id="checkoutForm" class="checkout-step"><div class="checkout-main"><h2 id="checkoutTitle" class="visually-hidden" tabindex="-1">${h(t(guest ? "guestCheckoutBar" : "checkoutBar"))}</h2>${guest ? "" : `<p class="notice notice--quiet">${h(t("signed"))}</p>`}<div class="form-grid"><div><label for="name">${h(t("name"))}</label><input id="name" name="name" required maxlength="120" autocomplete="name" value="${h(c.name || "")}"></div><div><label for="payerPhone">${h(t("payer"))} <span class="label-note">${h(t("payerNote"))}</span></label><input id="payerPhone" name="payerPhone" type="tel" required autocomplete="tel" value="${h(c.payerPhone || c.phone || "")}" placeholder="6XXXXXXXX"></div><div><label for="email">${h(t("emailLabel"))} <span class="label-note">${h(t("emailNote"))}</span></label><input id="email" name="email" type="email" autocomplete="email" placeholder="you@example.com" value="${h(c.email || "")}"></div></div><input type="hidden" id="quantity" name="quantity" value="${h(count)}"><div class="collect-box"><strong>${h(place() ? t("collectAt").replace("{place}", place()) : t("pickup"))}</strong><span>${h(t("deliveryLaterShort"))}</span></div><fieldset class="pay-with"><legend>${h(t("payWith"))}</legend><div class="pay-with__methods"><label class="method"><input type="radio" name="network" value="mtn" ${network === "mtn" ? "checked" : ""}><span>MTN MoMo</span></label><label class="method"><input type="radio" name="network" value="orange" ${network === "orange" ? "checked" : ""}><span>Orange Money</span></label></div></fieldset>${promo.checkout(selected, !guest).note}</div><div class="checkout-foot">${checkoutCost(selected, count, network)}<button type="submit" id="payButton">${h(t("payNow"))}</button><p id="checkoutError" class="error" role="alert"></p></div></form>`;
  // The breakdown and the wallet note follow the chosen network.
  if (!selected.promotion) $("#checkoutForm").querySelectorAll('input[name="network"]').forEach((radio) => {
    radio.onchange = () => { $("#checkoutCost").outerHTML = checkoutCost(selected, count, radio.value); };
  });
  if (pending && !selected.promotion) $("#checkoutForm").querySelectorAll("input,select").forEach((el) => (el.disabled = true));
  $("#checkoutForm").onsubmit = async (e) => {
    e.preventDefault();
    await action(e.submitter, async () => {
      try {
        const fields = Object.fromEntries(new FormData(e.target));
        // One number: the paying number is also the contact (owner, 26 Nov).
        const input = pending ? pending.input : { ...fields, phone: fields.payerPhone, quantity: Number(fields.quantity), productId: selected.id, expectedPrice: selected.price, checkoutKey };
        sessionStorage.setItem("ndahi-store-checkout", JSON.stringify({ input, product: selected, account: pending ? pending.account : account.authenticated }));
        const result = await call((pending ? pending.account : account.authenticated) ? "/api/account/store/checkout" : "/api/store/checkout", input);
        remember(result.order.id, result.token);
        sessionStorage.removeItem("ndahi-store-checkout");
        checkoutPending = null;
        checkoutWait({ order: result.order, token: result.token, input, account: !guest });
      } catch (err) {
        if (err.checkoutNotCreated) sessionStorage.removeItem("ndahi-store-checkout");
        $("#checkoutError").textContent = err.message;
        throw err;
      }
    });
  };
}
function checkoutWait(placed) {
  checkoutPlaced = placed;
  const o = placed.order, method = METHODS[o.network] || "Mobile Money";
  sheetTitle("waitingBar");
  $("#checkoutDialog").dataset.step = "wait";
  const words = Number.isFinite(o.fee) && Number.isFinite(o.total)
    ? tf("approveText", { method, total: money(o.total), fee: money(o.fee), number: maskedNumber(placed.input.payerPhone) })
    : tf("approveTextNoFee", { method, price: money(o.amount), number: maskedNumber(placed.input.payerPhone) });
  $("#checkoutDetail").innerHTML = `<div class="checkout-main checkout-state"><span class="checkout-state__icon checkout-state__icon--wait" aria-hidden="true">${ICON.phone}</span><h2 id="checkoutTitle" tabindex="-1">${h(t("approveTitle"))}</h2><p>${h(words).replace(h(money(o.total)), `<strong>${h(money(o.total))}</strong>`)}</p><p id="checkoutError" class="error" role="alert"></p></div><div class="checkout-foot checkout-foot--actions"><button type="button" id="checkStatus">${h(t("checkStatus"))}</button><button type="button" class="secondary" id="changePayment">${h(t("changePayment"))}</button></div>`;
  $("#checkoutTitle").focus();
  const order = () => ({ orderId: o.id, ...(placed.account ? {} : { token: placed.token }) });
  $("#checkStatus").onclick = (e) => action(e.currentTarget, async () => {
    const result = await call(placed.account ? "/api/account/store/verify" : "/api/store/verify", order());
    const now = result.order;
    if (now.paymentStatus === "paid") return checkoutDone({ ...placed, order: now });
    $("#checkoutError").textContent = ["failed", "cancelled", "expired"].includes(now.paymentStatus) ? t("paymentEnded") : t("stillWaiting");
  });
  // Change payment (owner, 26 Nov; as #397): the unpaid request is cancelled,
  // unless the provider has just confirmed it, then the details come back.
  $("#changePayment").onclick = (e) => action(e.currentTarget, async () => {
    const result = await call(placed.account ? "/api/account/store/cancel" : "/api/store/cancel", order());
    if (result.order.paymentStatus === "paid") return checkoutDone({ ...placed, order: result.order });
    checkoutKey = crypto.randomUUID();
    checkoutPlaced = null;
    checkoutDetails(placed.input);
  });
}
function checkoutDone(placed) {
  checkoutPlaced = placed;
  const o = placed.order;
  sheetTitle("confirmedBar");
  $("#checkoutDialog").dataset.step = "done";
  // A deal (canvas: PhonePromoBuy): the timeline of the router and its free bundle.
  if (o.promotion) {
    $("#checkoutDetail").innerHTML = `<div class="checkout-main buy-done"><div class="buy-done__head"><span class="buy-done__icon" aria-hidden="true">${ICON.done}</span><h2 id="checkoutTitle" tabindex="-1">${h(t("placedTitle"))}</h2></div><p class="buy-done__text">${h(promo.words("placedBody", { ref: "\u0000" })).replace("\u0000", `<strong>${h(o.reference)}</strong>`)}</p>${promo.buyDone(o, place() || data.settings.name, maskedNumber(placed.input.payerPhone))}</div><div class="checkout-foot checkout-foot--actions"><button type="button" id="trackOrder">${h(promo.words("track"))}</button>${placed.account ? "" : `<a class="button secondary" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(promo.words("keepTogether"))}</a>`}</div>`;
    $("#checkoutTitle").focus();
    $("#trackOrder").onclick = () => openPlacedOrder();
    return;
  }
  $("#checkoutDetail").innerHTML = `<div class="checkout-main checkout-state checkout-state--done"><span class="checkout-state__icon checkout-state__icon--done" aria-hidden="true">${ICON.done}</span><h2 id="checkoutTitle" tabindex="-1">${h(t("placedTitle"))}</h2><p>${h(tf("placedText", { ref: "\u0000" })).replace("\u0000", `<strong>${h(o.reference)}</strong>`)}</p>${placed.account ? "" : `<div class="checkout-keep"><strong>${h(t("keepTitle"))}</strong><p>${h(t("keepText"))}</p></div><div class="checkout-account"><strong>${h(t("accountTitle"))}</strong><p>${h(t("accountText"))}</p><a class="button secondary" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(t("saveToAccount"))}</a></div>`}</div><div class="checkout-foot checkout-foot--actions"><button type="button" id="trackOrder">${h(t("trackOrder"))}</button></div>`;
  $("#checkoutTitle").focus();
  $("#trackOrder").onclick = () => openPlacedOrder();
}
// Track my order, or closing the sheet once a request was sent, opens the order.
function openPlacedOrder() {
  const placed = checkoutPlaced;
  checkoutPlaced = null;
  $("#checkoutDialog").close();
  if (placed) location.hash = orderHash(placed.order.id, placed.token);
}
// Item, the Mobile Money fee and the total to pay, then the wallet note. Without
// a quote from the server the fee is "shown in your prompt", never worked out here.
function checkoutCost(p, count, network) {
  const q = quoteOf(p, network, count), price = p.price * count, method = METHODS[network];
  return `<div class="checkout-cost" id="checkoutCost"><div class="checkout-cost__row"><span>${h(t("item"))}</span><span>${h(money(price))}</span></div>${promo.checkout(p, account.authenticated).line}<div class="checkout-cost__row"><span>${h(q ? t("feeLabel") : t("feeLabelPlain"))}</span><span>${h(q ? money(q.fee) : t("feeInPrompt"))}</span></div>${q ? `<div class="checkout-summary"><span>${h(t("totalToPay"))}</span><strong id="total">${h(money(q.total))}</strong></div>` : ""}<p class="checkout-cost__balance" role="note">${q ? h(tf("walletNote", { total: "\u0000", method })).replace("\u0000", `<strong>${h(money(q.total))}</strong>`) : h(tf("walletNoteNoFee", { price: money(price), method }))}</p></div>`;
}
// The request that was sent, with the amounts recorded on the order.
function requestSent(o) {
  const method = METHODS[o.network] || "Mobile Money";
  return Number.isFinite(o.fee) && Number.isFinite(o.total)
    ? tf("requestSent", { method, total: money(o.total), fee: money(o.fee) })
    : tf("requestSentNoFee", { method, price: money(o.amount) });
}
async function refreshAccount() {
  account = await call("/api/account/store/context");
}
// Collection point without a trailing full stop, for sentences that add their own.
function place() {
  return l(data?.settings?.pickup).replace(/[\s.]+$/, "");
}
// Paid orders show where they are (canvas: PhoneOrder, guest; #401): each
// step with when it happened, and "Held for you until" while ready.
const stamp = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" })}, ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`; };
const day = (iso) => new Date(iso).toLocaleDateString(lang === "fr" ? "fr-FR" : "en-GB", { day: "numeric", month: "short" });
function progress(o) {
  if (o.paymentStatus !== "paid" || ["review", "cancelled"].includes(o.status)) return "";
  const at = o.status === "collected" ? 4 : o.status === "ready" ? 2 : 1, p = o.progress || {};
  const times = [p.paidAt, p.readyAt, p.readyAt, p.collectedAt];
  return `<ol class="progress" aria-label="${h(t("progress"))}">${["stepPaid", "stepPreparing", "stepReady", "stepCollected"].map((key, i) => {
    const note = i < at ? (times[i] ? stamp(times[i]) : "") : i === at && i === 2 && o.holdUntil ? tf("heldUntil", { date: day(o.holdUntil) }) : "";
    return `<li class="${i < at ? "done" : i === at ? "current" : ""}"${i === at ? ' aria-current="step"' : ""}><span class="progress__dot" aria-hidden="true">${i < at ? ICON.tick : ""}</span><span><strong>${h(t(key))}</strong>${note ? `<span>${h(note)}</span>` : ""}</span></li>`;
  }).join("")}</ol>`;
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
// One order (canvas: PhoneOrder, guest; #401; owner 26 Nov): the bar, the line
// with the method and status, the collection code, progress with its times,
// the short private link for guests, then Receipt and Save to an account.
// id is null when the order opens from its short link (/o/<token>).
async function showOrder(id, token, verify = false) {
  const result = await call(
    account.authenticated
      ? `/api/account/store/${verify ? "verify" : "order"}`
      : `/api/store/${verify ? "verify" : "order"}`,
    { ...(id ? { orderId: id } : {}), token },
  );
  const o = result.order, paid = o.paymentStatus === "paid", guest = Boolean(token) && !account.authenticated;
  id = o.id;
  // store.ndahiconnect.net/o/<token>: shown without the scheme, copied whole.
  const link = token ? `${location.origin}/o/${encodeURIComponent(token)}` : "", shown = link.replace(/^https?:\/\//, "");
  const code = String(o.collectionCode || "").replace(/^(\d{3})(\d{3})$/, "$1 $2");
  $("#view").innerHTML =
    `<div class="order-page"><div class="bar"><a class="bar-back" href="${guest ? "#shop" : "#orders"}" aria-label="${h(t("backStep"))}">${ICON.back}</a><h1 class="bar-title">${h(t("order"))} ${h(o.reference)}</h1></div><div class="order-main"><div class="order-line">${visual(o.product)}<div><strong>${h(l(o.product.name))} × ${h(o.quantity)}</strong><span>${h(money(o.amount))}${METHODS[o.network] ? ` · ${h(METHODS[o.network])}` : ""}${o.refundStatus === "failed" ? ` · ${lang === "fr" ? "Échec du remboursement — contactez la boutique" : "Refund failed — contact the store"}` : ""}</span></div><span class="order-status is-${toneOf(o)}">${h(t(o.status))}</span></div>${o.paymentReview ? `<p class="notice">${h(t(o.paymentReview === "late_payment" ? "late" : "paymentReview"))}</p>` : ""}${o.paymentStatus === "pending" && o.status === "awaiting_payment" ? `<p class="notice notice--quiet" id="paymentRequest">${h(requestSent(o))}</p>` : ""}${o.collectionCode ? `<section class="code-card" aria-labelledby="codeTitle"><h2 class="eyebrow" id="codeTitle">${h(t("collection"))}</h2><p class="code-card__code">${h(code)}</p><p>${h(t("codeHelp").replace("{place}", (o.pickup || place()).replace(/[\s.]+$/, "")))}</p></section>` : ""}${promo.order(o, data.portalUrl)}${progress(o)}${o.serialNumbers ? `<p class="order-serials">${h(o.serialNumbers)}</p>` : ""}${guest ? `<section class="keep-link" aria-labelledby="keepTitle"><h2 id="keepTitle">${h(t("keepLink"))}</h2><p>${h(t("keepLinkText"))}</p><div class="keep-link__row"><input readonly id="privateLink" aria-label="${h(t("link"))}" value="${h(shown)}"><button type="button" id="copyLink">${h(t("copyShort"))}</button></div></section>` : ""}${paid ? "" : `<p class="form-help">${h(t("reserved"))}</p>`}<div class="order-actions">${paid ? "" : `<button id="checkPayment">${h(t("check"))}</button>`}${o.receiptAvailable ? `<button class="secondary" id="downloadStoreReceipt">${h(t("receiptShort"))}</button>` : ""}${token ? account.authenticated ? `<button class="secondary" id="claimOrder">${h(t("claimGuest"))}</button>` : `<a class="button secondary" id="signToClaim" href="${h(data.portalUrl)}/login" target="_blank" rel="noopener">${h(t("claimGuest"))}</a>` : ""}</div></div></div>`;
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
    $("#copyLink").onclick = async (e) => {
      const button = e.currentTarget;
      try { await navigator.clipboard.writeText(link); button.textContent = t("copied"); }
      catch { $("#privateLink").select(); $("#message").textContent = t("copyFailed"); }
    };
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
  const parts = location.hash.slice(1).split("/"), short = !location.hash.slice(1) && /^\/o\/([A-Za-z0-9_-]{40,100})$/.exec(location.pathname);
  const view = short || (parts[0] === "order" && parts[1]) ? "order" : parts[0] === "product" && parts[1] ? "product" : parts[0] === "orders" ? "orders" : "shop";
  document.body.dataset.view = view;
  document.querySelectorAll("[data-nav]").forEach((a) => {
    if (a.dataset.nav === (view === "orders" || view === "order" ? "orders" : "shop")) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
  try {
    if (view === "order" && short) await showOrder(null, short[1]);
    else if (view === "order")
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
  .forEach((b) => (b.onclick = () => {
    const dialog = b.closest("dialog");
    if (dialog.id === "checkoutDialog" && checkoutPlaced) return openPlacedOrder();
    if (dialog.id === "checkoutDialog" && dialog.dataset.step === "details" && !checkoutPending && !account.authenticated) return checkoutChoose();
    dialog.close();
  }));
// Escape once a request was sent opens the order instead of losing it.
$("#checkoutDialog")?.addEventListener("cancel", (event) => { if (checkoutPlaced) { event.preventDefault(); openPlacedOrder(); } });
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
// When a countdown reaches its moment the offer starts or ends: read the
// catalogue again so prices and stock come from the server.
async function reloadCatalogue() {
  data = await call("/api/store/catalogue");
  promo.setServerTime(data.serverTime);
  await route();
}
try {
  [data] = await Promise.all([call("/api/store/catalogue"), refreshAccount()]);
  promo.setServerTime(data.serverTime);
  await route();
} catch (e) {
  $("#view").textContent = e.message;
}
