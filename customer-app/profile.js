import { formValues, requestJson, loadPasskeys } from "./compat.js";
import { showError } from "./errors.js";
import { runButton } from "/shared/pending.js";

const lostResponse = (error) => ["TypeError", "TimeoutError", "SyntaxError"].includes(error.name);

export function mountEmailLink({ call, customer, onChanged }) {
  const form = document.getElementById("linkEmail"), confirm = document.getElementById("confirmEmail"),
    passkey = document.getElementById("linkEmailPasskey");
  if (passkey && (!window.PublicKeyCredential || !navigator.credentials)) passkey.hidden = true;
  async function request(usePasskey) {
    const input = formValues(form), message = document.getElementById("emailLinkMessage");
    if (!form.elements.email.reportValidity() || (customer.authenticatorEnrolled && !form.elements.otp.reportValidity())) return;
    try {
      await runButton(usePasskey ? passkey : form.querySelector('[type="submit"]'), "Verifying…", async () => {
        message.textContent = "";
        let payload = { email: input.email, pin: input.pin, otp: input.otp };
        if (usePasskey) {
          const browser = await loadPasskeys();
          const challenge = await call("/api/account/profile/email/options", { method: "POST", body: JSON.stringify({ email: input.email }) });
          payload = { email: input.email, otp: input.otp, challengeId: challenge.challengeId,
            response: await browser.startAuthentication({ optionsJSON: challenge.options }) };
        }
        try { await call("/api/account/profile/email", { method: "POST", body: JSON.stringify(payload) }); }
        catch (error) {
          if (!lostResponse(error)) throw error;
          const dashboard = await call("/api/account/dashboard");
          if (dashboard.customer.pendingEmail?.email !== input.email.trim().toLowerCase()) throw error;
        }
        form.reset();
        await onChanged(false);
      }, { controls: Array.from(form.elements) });
    } catch (error) { showError(message, error); }
  }
  form.onsubmit = (event) => { event.preventDefault(); void request(false); };
  if (passkey) passkey.onclick = () => { void request(true); };
  if (confirm) confirm.onsubmit = async (event) => {
    event.preventDefault();
    const input = formValues(confirm), message = document.getElementById("emailConfirmMessage");
    try {
      await runButton(confirm.querySelector('[type="submit"]'), "Confirming…", async () => {
        message.textContent = "";
        try { await call("/api/account/profile/email/confirm", { method: "POST", body: JSON.stringify(input) }); }
        catch (error) {
          if (!lostResponse(error)) throw error;
          const recovered = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
          if (!recovered.response.ok || !recovered.body.customer?.emailLinked || recovered.body.customer.email !== customer.pendingEmail?.email) throw error;
        }
        confirm.reset();
        await onChanged(true);
      }, { controls: Array.from(confirm.elements) });
    } catch (error) { showError(message, error); }
  };
}

export function mountPhoneChange({ call, customer, onChanged }) {
  const form = document.getElementById("changePhone");
  const submit = form.querySelector('[type="submit"]'), passkey = document.getElementById("changePhonePasskey");
  if (passkey && (!window.PublicKeyCredential || !navigator.credentials)) passkey.hidden = true;
  async function change(usePasskey) {
    const input = formValues(form), message = document.getElementById("phoneChangeMessage");
    if (!form.elements.phone.reportValidity() || !form.elements.confirmChange.reportValidity() ||
        (customer.authenticatorEnrolled && !form.elements.otp.reportValidity())) return;
    const button = usePasskey ? passkey : submit;
    try {
      await runButton(button, "Verifying…", async () => {
        message.textContent = "";
        let payload = { phone: input.phone, pin: input.pin, otp: input.otp };
        if (usePasskey) {
          const browser = await loadPasskeys();
          const challenge = await call("/api/account/profile/phone/options", { method: "POST", body: JSON.stringify({ phone: input.phone }) });
          const response = await browser.startAuthentication({ optionsJSON: challenge.options });
          payload = { phone: input.phone, otp: input.otp, challengeId: challenge.challengeId, response };
        }
        try {
          await call("/api/account/profile/phone", { method: "POST", body: JSON.stringify(payload) });
        } catch (error) {
          if (!["TypeError", "TimeoutError", "SyntaxError"].includes(error.name)) throw error;
          // A lost response may already have rotated this browser's session.
          const recovered = await requestJson(window.NDAHI_CONFIG.apiUrl + "/api/account/dashboard", { credentials: "include", cache: "no-store" });
          const normalize = (value) => String(value || "").replace(/\D/g, "").replace(/^237/, "");
          if (!recovered.response.ok || !recovered.body.customer || normalize(recovered.body.customer.phone) !== normalize(input.phone)) throw error;
        }
        form.reset();
        await onChanged();
      }, { controls: Array.from(form.elements) });
    } catch (error) { showError(message, error); }
  }
  form.onsubmit = (event) => { event.preventDefault(); void change(false); };
  if (passkey) passkey.onclick = () => { void change(true); };
}

export function mountNameChange({ call, onChanged }) {
  const form = document.getElementById("changeName");
  form.onsubmit = async (event) => {
    event.preventDefault();
    const input = formValues(form), message = document.getElementById("nameChangeMessage");
    try {
      await runButton(form.querySelector('[type="submit"]'), "Saving…", async () => {
        await call("/api/account/profile/name", { method: "POST", body: JSON.stringify(input) });
        form.reset(); await onChanged();
      }, { controls: Array.from(form.elements) });
    } catch (error) { showError(message, error); }
  };
}
