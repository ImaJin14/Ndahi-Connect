import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton } from "/shared/pending.js";
import { showError } from "./errors.js";

// The reference both screens compare, "PR-7Q4" as drawn (owner, #370): three
// characters from the voucher alphabet (no 0/O or 1/I), derived the same way on
// the requesting device and the owner's phone from the request's 6-digit code,
// which the server still checks in full. v1 keeps showing the 6 digits.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function matchingCodeText(value) {
  if (!/^\d{6}$/.test(value || "")) return "Unavailable";
  let n = Number(value), out = "";
  for (let i = 0; i < 3; i++) { out += ALPHABET[n % ALPHABET.length]; n = Math.floor(n / ALPHABET.length); }
  return "PR-" + out;
}
export function matchingRequestContent(request) {
  return `<p>Do these codes match? Check the code on the device you want to connect.</p><output class="pairing-code pair-review-code" aria-label="Matching request code">${h(matchingCodeText(request.comparisonCode))}</output><p>Expires ${h(new Date(request.expiresAt).toLocaleTimeString())}. Approval grants Wi-Fi access, not account settings.</p>`;
}
export function mountMatchActions({ form, request, call, onChanged }) {
  const output = form.querySelector("[data-pairing-error]");
  async function act(decline) {
    output.textContent = "";
    try { await runButton(form.querySelector(decline ? "[data-pairing-decline]" : '[type="submit"]'), decline ? "Declining…" : "Approving…", async () => {
      const reply = await call("/api/account/device-management/pairing/" + (decline ? "decline" : "approve"), { method: "POST", body: JSON.stringify({ id: request.id, ...(!decline ? { comparisonCode: request.comparisonCode, confirmMatch: true } : {}) }) });
      await onChanged(reply);
    }, { controls: Array.from(form.elements) }); } catch (error) { showError(output, error); }
  }
  form.onsubmit = event => { event.preventDefault(); void act(false); };
  form.querySelector("[data-pairing-decline]").onclick = () => { void act(true); };
}
