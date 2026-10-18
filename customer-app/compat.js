// Critical sign-in code targets browsers with ES modules and async/await
// (Safari 12.1 / Chrome 73). Optional storage and newer DOM APIs are not required.
function safeStore(name) {
  const memory = Object.create(null);
  return {
    get(key) {
      try { return window[name].getItem(key) || memory[key] || null; }
      catch (_) { return memory[key] || null; }
    },
    set(key, value) {
      memory[key] = String(value);
      try { window[name].setItem(key, String(value)); return true; }
      catch (_) { return false; }
    },
    remove(key) {
      delete memory[key];
      try { window[name].removeItem(key); } catch (_) { /* Optional. */ }
    },
  };
}
export const sessionStore = safeStore("sessionStorage");
export const localStore = safeStore("localStorage");
export function randomId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function formValues(form) {
  const values = {};
  new FormData(form).forEach((value, key) => { values[key] = value; });
  return values;
}
export function replaceContent(target, child) {
  while (target.firstChild) target.removeChild(target.firstChild);
  if (child) target.appendChild(child);
}

export async function requestJson(url, options = {}, timeoutMs = 15000) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, Object.assign({}, options, controller ? { signal: controller.signal } : {}));
        const body = await response.json();
        return { response, body };
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error("The request took too long. Please try again.");
          error.name = "TimeoutError";
          reject(error);
          if (controller) controller.abort();
        }, timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}

let passkeys;
export function loadPasskeys() {
  if (!window.PublicKeyCredential || !navigator.credentials || !window.isSecureContext) {
    return Promise.reject(Object.assign(new Error("Use voucher and PIN on this browser."), { name: "NotSupportedError" }));
  }
  if (window.SimpleWebAuthnBrowser) return Promise.resolve(window.SimpleWebAuthnBrowser);
  if (!passkeys) passkeys = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    let timer;
    const failed = () => { clearTimeout(timer); script.remove(); passkeys = null; reject(new Error("Passkeys could not load. Use voucher and PIN or try again.")); };
    script.src = "/vendor/webauthn.js";
    script.onload = () => { clearTimeout(timer); if (window.SimpleWebAuthnBrowser) resolve(window.SimpleWebAuthnBrowser); else failed(); };
    script.onerror = failed;
    timer = setTimeout(failed, 15000);
    document.head.appendChild(script);
  });
  return passkeys;
}

export function markReady() {
  window.NDAHI_READY = true;
  const help = document.getElementById("startupHelp");
  if (help) help.hidden = true;
}
