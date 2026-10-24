import { formValues, loadPasskeys, randomId, requestJson } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { ApiError, showError } from "./errors.js";

export const passkeysAvailable = () => Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
export function proofFields(customer, name = "currentPin") {
  return customer.pinConfigured === false ? "" : `<label>Current PIN<input name="${name}" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password" required></label>`;
}
export function proofButtons(customer, label) {
  return `${customer.pinConfigured === false ? "" : `<button type="submit">${label} with PIN</button>`}${customer.passkeys ? `<button type="button" data-proof-passkey>${label} with passkey</button>` : ""}`;
}
export function securityError(target, error) {
  if (["NotAllowedError", "AbortError"].includes(error.name)) {
    target.textContent = "Passkey not completed. Use your PIN or try your passkey again.";
  } else if (error.name === "NotSupportedError") {
    target.textContent = "Passkeys are unavailable in this browser. Use your PIN, open the secure portal in your browser, or use account recovery.";
  } else showError(target, error);
}

// Read a committed, session-scoped receipt. Never replay an assertion or
// automatically repeat a credential mutation after a lost response.
export async function credentialRequest(call, path, payload, action) {
  const operationId = randomId();
  try { return await call(path, { method: "POST", body: JSON.stringify({ ...payload, operationId }) }); }
  catch (error) {
    if (!["TimeoutError", "TypeError", "SyntaxError"].includes(error.name)) throw error;
    try {
      const { response, body } = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/account/security/actions/" + operationId,
        { credentials: "include", cache: "no-store" });
      if (response.ok && body.completed && body.action === action) return { confirmedByStatus: true };
    } catch (_) { /* Keep uncertainty; never manufacture a successful result. */ }
    throw new ApiError(409, "We could not confirm this change. Refresh security before trying again. If your PIN changed, sign in with the new PIN. Recovery remains available below.");
  }
}

export function mountVerifiedForm({ root, form, customer, call, options, perform, onSuccess }) {
  const passkey = form.querySelector("[data-proof-passkey]"), message = form.querySelector("[data-proof-message]");
  if (passkey && !passkeysAvailable()) passkey.hidden = true;
  async function submit(usePasskey) {
    const button = usePasskey ? passkey : form.querySelector('[type="submit"]');
    if (!button || button.disabled) return;
    const pin = form.querySelector('[name="currentPin"], [name="pin"]'), wasDisabled = pin?.disabled;
    if (usePasskey && pin) pin.disabled = true;
    const valid = form.reportValidity();
    if (pin) pin.disabled = wasDisabled;
    if (!valid) return;
    const input = formValues(form);
    try {
      await runButton(button, "Verifying…", async () => {
        root.setAttribute("aria-busy", "true"); message.textContent = "";
        let proof = input;
        if (usePasskey) {
          const browser = await loadPasskeys(), challenge = await options(input);
          proof = { ...input, pin: undefined, currentPin: undefined, challengeId: challenge.challengeId,
            response: await browser.startAuthentication({ optionsJSON: challenge.options }) };
        }
        const result = await perform(proof);
        form.reset(); form.removeAttribute("data-sensitive-output");
        await onSuccess(result);
      }, { controls: Array.from(root.querySelectorAll("button, input, select, textarea")) });
    } catch (error) { securityError(message, error); }
    finally { root.removeAttribute("aria-busy"); }
  }
  form.onsubmit = (event) => { event.preventDefault(); event.stopPropagation(); void submit(false); };
  if (passkey) passkey.onclick = (event) => { event.stopPropagation(); void submit(true); };
  form.oninput = () => form.setAttribute("data-sensitive-output", "");
}
