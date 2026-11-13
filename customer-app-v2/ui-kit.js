// Design-kit reference page (redesign Phase 1). Sample content only: this page
// calls no API. Component strings come from shared-app/i18n.js; the sample
// copy below is page-only (English is read from the HTML, French is here).
import { format, getPreferredLanguage, setPreferredLanguage, t } from "/shared/i18n.js";
import { announce, clear, h, localize, setDocumentLanguage } from "/shared/ui/dom.js";
import { icon, renderIcons } from "/shared/ui/icons.js";
import { enhancePinToggles, focusFirstError, setBusy, setFieldError } from "/shared/ui/field.js";
import { enhanceChoiceGroup, enhanceTabs } from "/shared/ui/choice.js";
import { notificationsLabel, renderAdminMenu, renderBackButton, renderBrand, renderNetworkStatus, renderPortalHeader } from "/shared/ui/navigation.js";
import { renderMeter, renderStepper, renderSteps, stepCount } from "/shared/ui/progress.js";
import { renderState } from "/shared/ui/states.js";

const NB = " "; // French puts a non-breaking space before : ? !

// Sample copy used only from JavaScript; HTML copy is read from the page.
const EN = {
  kitOrderProgress: "Order progress",
  kitStepPaid: "Paid",
  kitStepPrepared: "Prepared and tested",
  kitStepCollected: "Collected",
  kitHeldUntil: "Held for you until 23 Nov",
  kitSetupSteps: "Setup steps",
  kitStepRouter: "Router",
  kitStepAps: "Access points",
  kitStepWifi: "Wi-Fi",
  kitStepReview: "Review",
  kitBuyBundle: "Buy a bundle",
  kitDemoOnly: "Demo only: nothing was sent.",
  kitOnline: "You're online",
  kitOnlineBody: "[PLAN 2] is active on this device. Your receipt is in Activity.",
  kitGoHome: "Go to my home",
  kitViewReceipt: "View receipt",
  kitApproveTitle: "Approve on your phone",
  kitApproveBody: "An MTN MoMo request for [PRICE] FCFA was sent to 6•• •• 12 45. Approve it there — this screen updates by itself.",
  kitApprove1: "Open the payment prompt on your phone",
  kitApprove2: "Check the amount and enter your PIN there",
  kitApprove3: "Come back here — no need to refresh",
  kitNotCompleted: "Payment not completed",
  kitNotCompletedBody: "The payment was cancelled or timed out. Try again or choose another method.",
  kitTryAgain: "Try again",
  kitGetHelp: "Get help",
  kitJoinWifi: "Join NDAHI Wi-Fi first",
  kitJoin1: "Open Wi-Fi settings and join NDAHI",
  kitJoin2: "Tap Open Wi-Fi sign-in below",
  kitJoin3: "Come back here and tap Check again",
  kitOpenWifi: "Open Wi-Fi sign-in",
  kitCheckAgain: "Check again",
  kitNoOrders: "No orders yet",
  kitNoOrdersBody: "Devices you buy from the Shop appear here.",
  kitBrowseShop: "Browse the shop",
  kitStatusChecked: "Status checked (demo).",
  kitPhoneError: "Enter the phone number you pay with.",
  kitPhoneInvalid: "Enter 9 digits, starting with 6.",
  kitPinError: "Enter your PIN: 4 to 6 digits.",
};

const FR = {
  kitDocTitle: "Kit de design — NDAHI Connect",
  kitSkip: "Aller aux composants",
  kitEyebrow: "Refonte · Phase 1",
  kitTitle: "Kit de design NDAHI",
  kitIntro: "Jetons et composants de shared-app/ui. Contenu d'exemple uniquement.",
  kitTokens: "Jetons",
  kitSampleEyebrow: "NDAHI Connect",
  kitSampleH1xl: "Paiements et revenus.",
  kitSampleH1lg: "Bon retour",
  kitSampleH1: "Choisissez le forfait qui vous convient",
  kitSampleH2: "Tous les paiements",
  kitSampleH3: "Un meilleur signal chez vous",
  kitSampleSubhead: "Forfaits précédents",
  kitSampleLede: "Connectez-vous pour voir votre forfait, vos appareils et vos commandes.",
  kitSampleText: "Une demande de paiement a été envoyée sur votre téléphone. Validez-la — cet écran se met à jour tout seul.",
  kitSampleMeta: "29 oct. – 5 nov. · 5 Go utilisés",
  kitFigure: "3,2 Go",
  kitOfLeft: "restants sur 5 Go",
  kitButtons: "Boutons",
  kitSignIn: "Se connecter",
  kitPasskey: "Se connecter avec une clé d'accès",
  kitSignOutOthers: "Déconnecter tous les autres appareils",
  kitShowQr: "Afficher le QR",
  kitDisconnect: "Déconnecter",
  kitConfirmRefund: "Confirmer le remboursement",
  kitCopy: "Copier",
  kitChangePayment: "Changer de paiement",
  kitCheckProvider: "Vérifier auprès de l'opérateur",
  kitPay: "Payer",
  kitCheckStatus: "Vérifier le statut",
  kitPills: "Pastilles d'état, badges et état du réseau",
  kitConnected: "Connecté",
  kitWaiting: "En attente",
  kitFailed: "Échoué",
  kitReady: "Prête à retirer",
  kitFinished: "Terminé",
  kitPopular: "Populaire",
  kitCards: "Cartes, notes et encadrés",
  kitEndsIn: "Se termine dans 2 jours",
  kitDevicesUsed: "2 appareils sur 3",
  kitBundleDetails: "Détails du forfait",
  kitDevices: "Appareils",
  kitEnterVoucher: "Saisir un ticket",
  kitAddDevice: "Ajouter un appareil",
  kitPhoto: "Photo",
  kitCollectLocally: "[PRICE] FCFA · Retrait sur place",
  kitActivePlan: "Actif · [PLAN 2]",
  kitEnds: "Se termine le 12 nov.",
  kitBuyRule: "Vous pourrez acheter votre prochain forfait quand celui-ci sera terminé ou ses données épuisées.",
  kitWhy: "Pourquoi" + NB + "?",
  kitPinUpdated: "Code PIN modifié. Utilisez-le à votre prochaine connexion.",
  kitInfoCallout: "Votre commande est prête à être retirée à [PICKUP LOCATION].",
  kitKeepLink: "Gardez ce lien privé",
  kitKeepLinkBody: "Vous avez acheté en tant qu'invité. Ce lien est le seul moyen de retrouver cette commande — copiez-le ou ajoutez-le à vos favoris.",
  kitTrackingLink: "Lien de suivi privé",
  kitRefundTitle: "Rembourser le montant total sur MTN MoMo" + NB + "?",
  kitKeepOrder: "Garder la commande",
  kitLists: "Listes, interrupteurs et contrôles segmentés",
  kitSecurity: "Sécurité",
  kitChangePin: "Changer le code PIN",
  kitPasskeySignIn: "Connexion par clé d'accès",
  kitOn: "Activée",
  kitSignedInDevices: "Appareils connectés au compte",
  kitTwoActive: "2 actifs",
  kitNotificationsHeading: "Notifications",
  kitLowData: "Alertes de données faibles",
  kitEndingSoon: "Forfait bientôt terminé",
  kitOrderUpdates: "Suivi des commandes boutique",
  kitHomeRouter: "Routeur NDAHI Home",
  kitLinked: "Associé",
  kitHelp: "Aide et assistance",
  kitBundles: "Forfaits",
  kitVouchers: "Tickets",
  kitRowMeta2: "28 oct. · 0,6 Go utilisés",
  kitExpired: "Expiré",
  kitUsedVouchers: "Tickets utilisés",
  kitRedeemed: "Utilisé le 29 oct.",
  kitUsed: "Utilisé",
  kitStatus: "Statut",
  kitAll: "Tous",
  kitPaid: "Payé",
  kitForms: "Formulaires",
  kitPhone: "Numéro de téléphone",
  kitPhoneHint: "Le numéro avec lequel vous payez par Mobile Money.",
  kitPin: "Code PIN",
  kitForgotPin: "Code PIN oublié" + NB + "?",
  kitUseVoucher: "Utiliser un code ticket",
  kitPlans: "Forfaits",
  kitPlanMeta1: "1 Go · 1 jour · 1 appareil",
  kitPlanMeta2: "5 Go · 7 jours · 3 appareils",
  kitPlanMeta3: "15 Go · 30 jours · 3 appareils",
  kitPayWith: "Payer avec",
  kitMomoNumber: "Numéro Mobile Money",
  kitMomoHint: "Nouveau" + NB + "? Nous créerons votre compte NDAHI avec ce numéro.",
  kitPickup: "Retrait",
  kitProgress: "Progression",
  kitReviewPay: "Vérifier et payer",
  kitPayPrice: "Payer [PRICE] FCFA",
  kitApproveNote: "Vous validerez sur votre téléphone. Nous ne vous demandons jamais votre code PIN.",
  kitNavigation: "Navigation",
  kitWelcome: "Bon retour.",
  kitStates: "États de réussite, d'attente, d'erreur et vides",
  kitAdmin: "Données d'administration",
  kitExport: "Exporter en CSV",
  kitTodayBundles: "Aujourd'hui, forfaits",
  kitTodayStore: "Aujourd'hui, boutique",
  kitWaitingLong: "En attente depuis plus de 10 min",
  kitFailedToday: "Échoués aujourd'hui",
  kitSearchLabel: "Rechercher des paiements",
  kitSearchPlaceholder: "Téléphone, commande ou référence",
  kitWhen: "Quand",
  kitCustomer: "Client",
  kitMethod: "Moyen",
  kitAmount: "Montant",
  kitAction: "Action",
  // JavaScript-only copy
  kitOrderProgress: "Suivi de la commande",
  kitStepPaid: "Payée",
  kitStepPrepared: "Préparée et testée",
  kitStepCollected: "Retirée",
  kitHeldUntil: "Réservée pour vous jusqu'au 23 nov.",
  kitSetupSteps: "Étapes de configuration",
  kitStepRouter: "Routeur",
  kitStepAps: "Points d'accès",
  kitStepWifi: "Wi-Fi",
  kitStepReview: "Vérification",
  kitBuyBundle: "Acheter un forfait",
  kitDemoOnly: "Démo uniquement" + NB + ": rien n'a été envoyé.",
  kitOnline: "Vous êtes en ligne",
  kitOnlineBody: "[PLAN 2] est actif sur cet appareil. Votre reçu est dans Activité.",
  kitGoHome: "Aller à l'accueil",
  kitViewReceipt: "Voir le reçu",
  kitApproveTitle: "Validez sur votre téléphone",
  kitApproveBody: "Une demande MTN MoMo de [PRICE] FCFA a été envoyée au 6•• •• 12 45. Validez-la — cet écran se met à jour tout seul.",
  kitApprove1: "Ouvrez la demande de paiement sur votre téléphone",
  kitApprove2: "Vérifiez le montant et saisissez votre code PIN",
  kitApprove3: "Revenez ici — inutile d'actualiser",
  kitNotCompleted: "Paiement non abouti",
  kitNotCompletedBody: "Le paiement a été annulé ou a expiré. Réessayez ou choisissez un autre moyen.",
  kitTryAgain: "Réessayer",
  kitGetHelp: "Obtenir de l'aide",
  kitJoinWifi: "Connectez-vous d'abord au Wi-Fi NDAHI",
  kitJoin1: "Ouvrez les réglages Wi-Fi et rejoignez NDAHI",
  kitJoin2: "Touchez «" + NB + "Ouvrir la connexion Wi-Fi" + NB + "» ci-dessous",
  kitJoin3: "Revenez ici et touchez «" + NB + "Vérifier à nouveau" + NB + "»",
  kitOpenWifi: "Ouvrir la connexion Wi-Fi",
  kitCheckAgain: "Vérifier à nouveau",
  kitNoOrders: "Aucune commande pour l'instant",
  kitNoOrdersBody: "Les appareils achetés dans la Boutique apparaissent ici.",
  kitBrowseShop: "Voir la boutique",
  kitStatusChecked: "Statut vérifié (démo).",
  kitPhoneError: "Saisissez le numéro avec lequel vous payez.",
  kitPhoneInvalid: "Saisissez 9 chiffres, en commençant par 6.",
  kitPinError: "Saisissez votre code PIN" + NB + ": 4 à 6 chiffres.",
};

// English sample copy comes from the HTML, captured before the first switch.
const ATTRIBUTES = ["aria-label", "placeholder", "title", "alt"];
document.querySelectorAll("[data-i18n]").forEach((element) => {
  const key = element.getAttribute("data-i18n");
  if (key.indexOf("kit") === 0 && !(key in EN)) EN[key] = element.textContent;
});
ATTRIBUTES.forEach((attribute) => {
  document.querySelectorAll("[data-i18n-" + attribute + "]").forEach((element) => {
    const key = element.getAttribute("data-i18n-" + attribute);
    if (key.indexOf("kit") === 0 && !(key in EN)) EN[key] = element.getAttribute(attribute);
  });
});
EN.kitDocTitle = document.title;

let lang = "en";
const L = (key, language) => {
  const selected = language || lang;
  if (key.indexOf("kit") !== 0) return t(key, selected);
  return (selected === "fr" && FR[key]) || EN[key] || key;
};

// ---------- Tokens ----------
const COLOURS = ["forest", "forest-deep", "lime", "lime-hover", "lime-ink", "lime-text", "meter", "ivory", "paper", "white", "sage", "sage-strong", "track",
  "ink", "ink-soft", "muted", "on-forest-soft", "on-forest-muted", "on-forest-faint", "line", "line-strong", "success-bg", "success-fg", "warning-bg", "warning-fg",
  "warning-line", "danger", "danger-bg", "danger-fg", "danger-line", "danger-soft", "info-bg", "info-fg", "neutral-bg", "neutral-fg", "switch-off",
  "status-degraded", "status-maintenance"];
const SPACES = [4, 6, 8, 10, 12, 14, 16, 18, 20, 22, 24, 28, 32, 48];
const RADII = ["sm", "control", "panel", "card", "card-lg", "hero", "pill"];

function renderTokens() {
  const styles = getComputedStyle(document.documentElement);
  const colours = document.getElementById("kit-colours");
  COLOURS.forEach((name) => {
    const variable = "--nd-" + name;
    colours.appendChild(h("div", { class: "kit-swatch" },
      h("div", { class: "kit-swatch__chip", style: { background: "var(" + variable + ")" } }),
      h("code", { class: "kit-swatch__name", text: variable }),
      h("span", { class: "kit-swatch__value", text: styles.getPropertyValue(variable).trim() })));
  });
  const space = document.getElementById("kit-space");
  SPACES.forEach((size) => {
    const value = "var(--nd-space-" + size + ")";
    space.appendChild(h("span", { class: "kit-scale__item" }, h("span", { class: "kit-scale__box", style: { width: value, height: value } }), String(size)));
  });
  const radii = document.getElementById("kit-radii");
  RADII.forEach((name) => {
    radii.appendChild(h("span", { class: "kit-scale__item" }, h("span", { class: "kit-scale__radius", style: { borderRadius: "var(--nd-radius-" + name + ")" } }), name));
  });
}

// ---------- Components built in JavaScript (rebuilt on language change) ----------
let stepperIndex = 1;

function link(text, className, href) {
  return h("a", { class: "nd-btn nd-btn--block" + (className ? " " + className : ""), href: href || "#kit-states", text });
}

function mount(id, ...children) {
  const target = clear(document.getElementById(id));
  children.forEach((child) => target.appendChild(child));
  return target;
}

function renderStepperDemo(focus) {
  const labels = ["kitStepRouter", "kitStepAps", "kitStepWifi", "kitStepReview"].map((key) => L(key));
  const stepper = renderStepper(labels, {
    current: stepperIndex,
    label: L("kitSetupSteps"),
    lang,
    onSelect: (index) => { stepperIndex = index; renderStepperDemo(true); },
  });
  mount("kit-stepper", stepper);
  if (focus) stepper.querySelector('[aria-current="step"]').focus();
}

function renderDynamic() {
  const status = clear(document.getElementById("kit-status"));
  ["online", "degraded", "offline", "maintenance", "unknown"].forEach((state) => status.appendChild(renderNetworkStatus(state, lang)));

  mount("kit-steps", renderSteps([
    { title: L("kitStepPaid"), meta: "8 Nov, 10:14", state: "done" },
    { title: L("kitStepPrepared"), meta: "9 Nov, 16:02", state: "done" },
    { title: L("kitReady"), meta: L("kitHeldUntil"), state: "current" },
    { title: L("kitStepCollected"), state: "todo" },
  ], { label: L("kitOrderProgress"), lang }));
  renderStepperDemo(false);

  mount("kit-topbar",
    renderBackButton({ href: "#kit-progress", lang }),
    h("p", { class: "nd-topbar__title", text: L("kitBuyBundle") }),
    h("span", { class: "nd-topbar__aside nd-step-count", text: stepCount(2, 3, lang) }));

  mount("kit-hero-bar",
    renderBrand(),
    h("a", { class: "nd-icon-btn nd-icon-btn--on-forest", href: "#kit-navigation", "aria-label": notificationsLabel(2, lang) },
      icon("bell", { size: 20 }), h("span", { class: "nd-icon-btn__dot", "aria-hidden": "true" })));
  mount("kit-hero-status", renderNetworkStatus("online", lang));
  mount("kit-sidemenu", renderAdminMenu({
    current: "payments",
    badges: { payments: 2, store: 3 },
    lang,
    onSignOut: () => announce(L("kitDemoOnly")),
  }));
  mount("kit-portalnav", renderPortalHeader({
    current: "home",
    network: "online",
    notifications: { count: 2, href: "#kit-navigation" },
    badges: { activity: { count: 1, label: format("portalPendingOne", { count: 1 }, lang) } },
    phoneBar: true,
    lang,
  }));

  const states = [
    ["success", { tone: "success", title: L("kitOnline"), body: L("kitOnlineBody"), actions: [link(L("kitGoHome")), link(L("kitViewReceipt"), "nd-btn--secondary")] }],
    ["waiting", { tone: "waiting", title: L("kitApproveTitle"), body: L("kitApproveBody"), list: [L("kitApprove1"), L("kitApprove2"), L("kitApprove3")], actions: [link(L("kitCheckStatus")), link(L("kitChangePayment"), "nd-btn--secondary")], announce: false }],
    ["error", { tone: "error", title: L("kitNotCompleted"), body: L("kitNotCompletedBody"), actions: [link(L("kitTryAgain")), link(L("kitGetHelp"), "nd-btn--secondary")] }],
    ["info", { tone: "info", title: L("kitJoinWifi"), list: [L("kitJoin1"), L("kitJoin2"), L("kitJoin3")], actions: [link(L("kitOpenWifi"), "nd-btn--secondary"), link(L("kitCheckAgain"))] }],
    ["empty, compact", { tone: "empty", compact: true, title: L("kitNoOrders"), body: L("kitNoOrdersBody"), actions: [link(L("kitBrowseShop"), "nd-btn--secondary")] }],
  ];
  const grid = clear(document.getElementById("kit-state-grid"));
  states.forEach(([name, options]) => {
    grid.appendChild(h("div", { class: "kit-demo" },
      h("p", { class: "kit-demo__label", text: "tone: " + name }),
      h("div", { class: "kit-frame kit-frame--phone" }, renderState(Object.assign({ headingLevel: 3 }, options)))));
  });
}

// ---------- Form demo ----------
let validated = false;
function validate() {
  const phone = document.getElementById("kit-phone"), pin = document.getElementById("kit-pin");
  const digits = phone.value.replace(/\D/g, "");
  setFieldError(phone, !digits ? L("kitPhoneError") : /^6\d{8}$/.test(digits) ? "" : L("kitPhoneInvalid"));
  setFieldError(pin, /^\d{4,6}$/.test(pin.value) ? "" : L("kitPinError"));
  return !document.querySelector('#kit-form [aria-invalid="true"]');
}

// ---------- Language ----------
const languageGroups = [];
function applyLanguage(next, persist) {
  lang = setDocumentLanguage(persist ? setPreferredLanguage(next) : next);
  localize(document, lang, L);
  document.title = L("kitDocTitle");
  languageGroups.forEach((group) => group.select(lang));
  enhancePinToggles(document);
  renderDynamic();
  if (validated) validate();
}

// ---------- Start ----------
renderIcons(document);
renderTokens();
document.querySelectorAll("[data-kit-meter]").forEach((slot) => slot.appendChild(renderMeter(Number(slot.getAttribute("data-kit-meter")))));
["kit-language", "kit-language-2"].forEach((id) => {
  languageGroups.push(enhanceChoiceGroup(document.getElementById(id), { onChange: (value) => applyLanguage(value, true) }));
});
["kit-plans", "kit-methods", "kit-chips"].forEach((id) => enhanceChoiceGroup(document.getElementById(id)));
enhanceTabs(document.getElementById("kit-tabs"));

document.getElementById("kit-form").addEventListener("submit", (event) => {
  event.preventDefault();
  validated = true;
  if (validate()) announce(L("kitDemoOnly"));
  else focusFirstError(event.currentTarget);
});

const busy = document.getElementById("kit-busy");
busy.addEventListener("click", () => {
  setBusy(busy, true);
  setTimeout(() => { setBusy(busy, false); busy.focus(); announce(L("kitStatusChecked")); }, 1200);
});

applyLanguage(getPreferredLanguage(), false);
