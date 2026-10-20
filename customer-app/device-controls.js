import { escapeHtml as h } from "/shared/safe-html.js";
import { formValues, loadPasskeys } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { showError } from "./errors.js";
import { mountPairingControls } from "./wifi-pairing.js";

export async function mountDeviceControls({ container, call, onChanged }) {
  if (!container) return;
  let info;
  const message = document.createElement("div");
  message.setAttribute("role", "status");
  try {
    info = await call("/api/account/device-management");
    const main = info.mainDevice;
    container.innerHTML = `<p>${main ? `Main device: <strong>${h(main.name || "Unnamed device")} · ending ${h(main.mac.slice(-5))}</strong>. ${info.isMainController ? "This browser controls connection approvals." : "Use its controlling browser for connection approvals."}${main.routerChanged ? " Router settings changed; select the main device again." : ""}` : "Choose a main device to control assisted connections."}</p>
      <button type="button" data-select-main>${main ? "Select / recover main device" : "Select main device"}</button><div data-device-proof hidden></div><div data-pairing-controls></div>`;
    container.appendChild(message);
  } catch (error) {
    container.textContent = "Main-device controls could not load. Refresh to try again.";
    return;
  }
  async function showProof(mac, disconnect) {
    const list = await call("/api/account/wifi-devices"), devices = list.devices || [], formHost = container.querySelector("[data-device-proof]");
    if (!devices.length) { message.textContent = "Connect to Wi-Fi, refresh devices, then select your main device."; return; }
    const choices = disconnect ? devices.filter((d) => d.mac === mac) : devices;
    formHost.innerHTML = `<form data-main-proof><h3>${disconnect ? "Disconnect main device" : "Select main device and controlling browser"}</h3>
      <label>Wi-Fi device<select name="mac" required>${choices.map((d) => `<option value="${h(d.mac)}">${h(d.name || "Unnamed device")} · ending ${h(d.mac.slice(-5))}</option>`).join("")}</select></label>
      ${disconnect ? "" : '<p>Select the device you are using. This browser will control approvals. Selecting a replacement revokes the previous browser’s control.</p><label><input type="checkbox" name="confirm" required> I am using the selected device and want this browser to control approvals.</label>'}
      <label>Account PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password"></label>
      ${info.authenticatorEnrolled ? `<label>Authenticator code${disconnect ? "" : " (optional)"}<input name="otp" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" ${disconnect ? "required" : ""}></label>${disconnect ? "" : "<p>You can select this device using your PIN or passkey without an authenticator code.</p>"}` : ""}
      <button type="submit">${disconnect ? "Verify and disconnect" : "Verify and select"}</button>
      ${info.passkeys && window.PublicKeyCredential && navigator.credentials ? '<button type="button" data-device-passkey>Verify with passkey</button>' : ""}
      <button type="button" data-close-proof>Cancel</button><div data-proof-message role="status" aria-live="polite"></div></form>`;
    formHost.hidden = false;
    const form = formHost.querySelector("form"), output = form.querySelector("[data-proof-message]");
    async function submit(usePasskey) {
      const input = formValues(form), selected = choices.find((d) => d.mac === input.mac);
      if (!form.reportValidity()) return;
      if (!usePasskey && !/^\d{4}$/.test(input.pin || "")) { output.textContent = "Enter your four-digit PIN."; return; }
      try {
        await runButton(form.querySelector(usePasskey ? "[data-device-passkey]" : '[type="submit"]'), "Verifying…", async () => {
          let payload = { mac: input.mac, pin: input.pin, otp: input.otp,
            sessionId: selected.sessionId, startedAt: selected.startedAt };
          const path = "/api/account/device-management/" + (disconnect ? "disconnect" : "main");
          if (usePasskey) {
            const browser = await loadPasskeys(), challenge = await call(path + "/options", { method: "POST", body: JSON.stringify({ mac: input.mac }) });
            delete payload.pin;
            payload.challengeId = challenge.challengeId;
            payload.response = await browser.startAuthentication({ optionsJSON: challenge.options });
          }
          await call(path, { method: "POST", body: JSON.stringify(payload) });
          form.reset(); formHost.hidden = true;
          if (!disconnect) {
            const check = await call("/api/account/device-management");
            if (!check.isMainController) { output.textContent = "Your browser could not remember its control credential. Allow site cookies and select it again."; formHost.hidden = false; return; }
          }
          message.textContent = disconnect ? "Disconnection requested. Waiting for router confirmation." : "Main device selected. This browser now controls assisted connections.";
          await onChanged();
        }, { controls: Array.from(form.elements) });
      } catch (error) { showError(output, error); }
    }
    form.onsubmit = (event) => { event.preventDefault(); void submit(false); };
    const passkey = form.querySelector("[data-device-passkey]");
    if (passkey) passkey.onclick = () => { void submit(true); };
    form.querySelector("[data-close-proof]").onclick = () => { form.reset(); formHost.hidden = true; };
    form.scrollIntoView({ block: "nearest" });
  }
  container.querySelector("[data-select-main]").onclick = () => showProof(null, false).catch((error) => showError(message, error));
  void mountPairingControls({ container: container.querySelector("[data-pairing-controls]"), call });
  container.closest("section").addEventListener("click", (event) => {
    const button = event.target.closest("[data-main-disconnect]");
    if (button) void showProof(button.dataset.mainDisconnect, true).catch((error) => showError(message, error));
  });
}
