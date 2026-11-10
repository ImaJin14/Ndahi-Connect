// Request-bound cookies and memory, with no contact fields. The API is the
// authority for expiry. Sign-in pages import this, so keep older-browser syntax.
export const savedCheckoutKey = "ndahi-checkout";
const legacySavedCheckout = "ndahi-interrupted-checkout", memory = {};
// A conservative migration fallback until the catalogue supplies its policy.
let lifetimeMs = 60000;
export function configureCheckoutStore(seconds) {
  if (Number.isFinite(Number(seconds)) && Number(seconds) > 0) lifetimeMs = Number(seconds) * 1000;
}

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
function entry(name) {
  const raw = read(name);
  let record = raw === null ? memory[name] : null;
  if (raw !== null) {
    try { record = JSON.parse(raw); } catch (_) { /* Older cookies held raw keys. */ }
    if (!record || typeof record.value !== "string" || !Number.isFinite(record.expiresAt)) {
      record = { value: raw, expiresAt: Date.now() + lifetimeMs, legacy: true };
      write(name, JSON.stringify(record), Math.floor(lifetimeMs / 1000));
    }
    memory[name] = record;
  }
  if (record && record.expiresAt <= Date.now()) { delete memory[name]; write(name, "", 0); return null; }
  return record || null;
}

export const checkoutStore = {
  get: function (name) {
    const record = entry(name);
    return record ? record.value : null;
  },
  set: function (name, value, options) {
    options = options || {};
    const existing = entry(name), requested = Number.isFinite(options.expiresAt) ? options.expiresAt : Date.now() + lifetimeMs;
    const expiresAt = existing && !existing.legacy ? Math.min(existing.expiresAt, requested) : requested;
    const record = { value: String(value), expiresAt: expiresAt };
    if (options.legacy) record.legacy = true;
    memory[name] = record;
    write(name, JSON.stringify(record), Math.max(0, Math.floor((expiresAt - Date.now()) / 1000)));
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
// expiry. Keep only the random key and IDs; the first API reading supplies their deadline.
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
          checkoutStore.set(savedCheckoutKey, JSON.stringify({ requestKey: input.requestKey, planId: input.planId, paymentId: saved.paymentId }), { legacy: true });
        }
        storage.removeItem(name);
      } else if (name && name.indexOf("ndahi-payment-") === 0) {
        if (!checkoutStore.get(name)) checkoutStore.set(name, storage.getItem(name), { legacy: true });
        storage.removeItem(name);
      }
    });
  } catch (_) { /* Storage may be unavailable or read-only. */ }
}
