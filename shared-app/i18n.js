// Every user-facing string, in English and French. The strings live in one
// module per area under shared-app/i18n/ (#428), merged here into the same
// TRANSLATIONS, so t(), format() and every key work as before.
//
// A new screen adds its own module (for example shared-app/i18n/admin-bundles.js,
// exporting `en` and `fr` with the same keys) and lists it in AREAS below,
// instead of editing a shared module. A key lives in one module only
// (test/i18n-areas.test.mjs).
import * as common from "./i18n/common.js";
import * as customer from "./i18n/customer.js";
import * as admin from "./i18n/admin.js";
import * as adminKits from "./i18n/admin-kits.js";
import * as shopKits from "./i18n/shop-kits.js";
import * as promoBuy from "./i18n/promo-buy.js";

const AREAS = [common, customer, admin, adminKits, shopKits, promoBuy];

export const TRANSLATIONS = {
  en: Object.assign({}, ...AREAS.map((area) => area.en)),
  fr: Object.assign({}, ...AREAS.map((area) => area.fr)),
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

// t() with {name} placeholders filled from `values`, for example
// format("uiStepCount", { current: 1, total: 3 }) -> "Step 1 of 3".
export function format(key, values = {}, lang) {
  return t(key, lang).replace(/\{(\w+)\}/g, (match, name) => (
    Object.prototype.hasOwnProperty.call(values, name) ? String(values[name]) : match
  ));
}
