export const TRANSLATIONS = {
  en: {
    brandSmall: "CONNECT",
    portalTitle: "Your connection at a glance.",
    eyebrowDashboard: "Customer dashboard",
    navHome: "Home",
    navBundles: "Bundles",
    navAccount: "Account",
    navNotifications: "Notifications",
    navHelp: "Help",
    logout: "Logout",

    activeBundle: "Active bundle",
    noActiveBundle: "No active bundle",
    remaining: "Remaining",
    left: "Left",
    used: "Used",
    expires: "Expires",
    refreshBalance: "Refresh balance",
    renewBundle: "Renew bundle",
    renewPlan: "Renew plan",
    changePlan: "Change / switch plan",
    viewVoucher: "View voucher",
    managePlan: "Manage plan",
    availablePackages: "Available packages",

    myVouchers: "My vouchers",
    voucherCodes: "Your voucher codes",
    voucherCode: "Voucher code",
    copyCode: "Copy code",
    downloadPdf: "Download PDF",
    showQrCode: "Show QR Code",
    qrTitle: "Voucher QR Code",
    qrInstruction: "Scan with another phone or camera to connect",
    qrClose: "Close",

    networkOnline: "Network online",
    networkDegraded: "Network degraded",
    networkOffline: "Network offline",
    maintenance: "Scheduled maintenance",
    unavailable: "Status unavailable",
    activeStarlink: "Connected to NDAHI Wi-Fi • Starlink Active",
    preAuthCaptive: "Connected to NDAHI Wi-Fi • Select a bundle or enter voucher to unlock internet",
    mobileData: "Viewing via Mobile Data • Purchases require joining NDAHI Wi-Fi",

    manageDevices: "Manage devices",
    wifiDevices: "Wi-Fi devices",
    connectDevice: "Connect this device",
    activateDifferentCode: "Activate a different voucher code",
    accountSecurity: "Account security",
    paymentHistory: "Payment history",

    mtnMoMo: "MTN Mobile Money",
    orangeMoney: "Orange Money",
  },
  fr: {
    brandSmall: "CONNEXION",
    portalTitle: "Votre connexion en un coup d'œil.",
    eyebrowDashboard: "Tableau de bord client",
    navHome: "Accueil",
    navBundles: "Forfaits",
    navAccount: "Compte",
    navNotifications: "Notifications",
    navHelp: "Aide",
    logout: "Déconnexion",

    activeBundle: "Forfait actif",
    noActiveBundle: "Aucun forfait actif",
    remaining: "Restant",
    left: "Restant",
    used: "Utilisé",
    expires: "Expire le",
    refreshBalance: "Actualiser le solde",
    renewBundle: "Renouveler le forfait",
    renewPlan: "Renouveler le forfait",
    changePlan: "Changer de forfait",
    viewVoucher: "Voir le ticket",
    managePlan: "Gérer le forfait",
    availablePackages: "Forfaits disponibles",

    myVouchers: "Mes tickets",
    voucherCodes: "Vos codes tickets",
    voucherCode: "Code ticket",
    copyCode: "Copier le code",
    downloadPdf: "Télécharger PDF",
    showQrCode: "Afficher code QR",
    qrTitle: "Code QR du ticket",
    qrInstruction: "Scannez avec la caméra d'un autre appareil pour vous connecter",
    qrClose: "Fermer",

    networkOnline: "Réseau en ligne",
    networkDegraded: "Réseau dégradé",
    networkOffline: "Réseau hors ligne",
    maintenance: "Maintenance programmée",
    unavailable: "Statut indisponible",
    activeStarlink: "Connecté au Wi-Fi NDAHI • Starlink Actif",
    preAuthCaptive: "Connecté au Wi-Fi NDAHI • Choisissez un forfait ou entrez un code",
    mobileData: "Navigation par données mobiles • Connexion au Wi-Fi NDAHI requise",

    manageDevices: "Gérer les appareils",
    wifiDevices: "Appareils Wi-Fi",
    connectDevice: "Connecter cet appareil",
    activateDifferentCode: "Activer un autre code ticket",
    accountSecurity: "Sécurité du compte",
    paymentHistory: "Historique des paiements",

    mtnMoMo: "MTN Mobile Money",
    orangeMoney: "Orange Money",
  }
};

const STORAGE_KEY = "ndahi-lang";

export function getPreferredLanguage() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === "fr" || saved === "en") return saved;
  } catch (_) {}
  if (typeof navigator !== "undefined" && navigator.language && navigator.language.startsWith("fr")) {
    return "fr";
  }
  return "en";
}

export function setPreferredLanguage(lang) {
  const selected = lang === "fr" ? "fr" : "en";
  try {
    localStorage.setItem(STORAGE_KEY, selected);
  } catch (_) {}
  return selected;
}

export function t(key, lang) {
  const currentLang = lang || getPreferredLanguage();
  const dict = TRANSLATIONS[currentLang] || TRANSLATIONS.en;
  return dict[key] || TRANSLATIONS.en[key] || key;
}
