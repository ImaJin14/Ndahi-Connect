// Checkout keys live in short-lived cookies rather than localStorage: the browser
// deletes them on its own after a day, even if this device never opens the portal
// again. They hold only random keys and IDs, never contact details, and the API stops
// honouring a key once its payment no longer needs it (checkoutKeyActive in
// lib/billing.mjs). Imported by sign-in pages, so it avoids newer syntax.
export const savedCheckoutKey = "ndahi-checkout";
const lifetimeSeconds = 24 * 3600, legacySavedCheckout = "ndahi-interrupted-checkout", memory = {};

function write(name, value, maxAge) {
  try {
    document.cookie = name + "=" + encodeURIComponent(value) + "; Max-Age=" + maxAge + "; Path=/; SameSite=Strict" +
      (location.protocol === "https:" ? "; Secure" : "");
  } catch (_) { /* Cookies may be disabled; the in-memory copy still covers this page. */ }
}
function read(name) {
  let found = null;
  try {
    document.cookie.split("; ").forEach(function (part) {
      const split = part.indexOf("=");
      if (split > 0 && part.slice(0, split) === name) found = decodeURIComponent(part.slice(split + 1));
    });
  } catch (_) { /* Unreadable cookies behave as absent. */ }
  return found;
}

export const checkoutStore = {
  get: function (name) {
    const value = read(name);
    return value !== null ? value : memory[name] || null;
  },
  set: function (name, value) {
    memory[name] = String(value);
    write(name, String(value), lifetimeSeconds);
  },
  remove: function (name) {
    delete memory[name];
    write(name, "", 0);
  },
};

export function savedCheckout() {
  try {
    const saved = JSON.parse(checkoutStore.get(savedCheckoutKey));
    return saved && typeof saved.requestKey === "string" && saved.requestKey ? saved : null;
  } catch (_) { return null; }
}

// Earlier portal versions kept the guest's name, phone and email in localStorage with no
// expiry. Keep only the random key and IDs, in a short-lived cookie, and delete the rest.
export function migrateLegacyCheckout() {
  let storage;
  try { storage = window.localStorage; } catch (_) { return; }
  if (!storage) return;
  try {
    const names = [];
    for (let index = 0; index < storage.length; index++) names.push(storage.key(index));
    names.forEach(function (name) {
      if (name === legacySavedCheckout) {
        let saved = null;
        try { saved = JSON.parse(storage.getItem(name)); } catch (_) { /* Discard unreadable records. */ }
        const input = saved && saved.input;
        if (input && typeof input.requestKey === "string" && input.requestKey && !savedCheckout()) {
          checkoutStore.set(savedCheckoutKey, JSON.stringify({ requestKey: input.requestKey, planId: input.planId, paymentId: saved.paymentId }));
        }
        storage.removeItem(name);
      } else if (name && name.indexOf("ndahi-payment-") === 0) {
        if (!checkoutStore.get(name)) checkoutStore.set(name, storage.getItem(name));
        storage.removeItem(name);
      }
    });
  } catch (_) { /* Storage may be unavailable or read-only. */ }
}
