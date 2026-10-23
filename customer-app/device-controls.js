import { escapeHtml as h } from "/shared/safe-html.js";
import { formValues, loadPasskeys } from "./compat.js";
import { runButton } from "/shared/pending.js";
import { showError } from "./errors.js";
import { mountPairingControls } from "./wifi-pairing.js";

// A passkey is an alternative proof; stale PIN text must not block its prompt.
function validProofForm(form, usePasskey) {
  const pin = form.elements.pin, disabled = pin.disabled;
  if (usePasskey) pin.disabled = true;
  try { return form.reportValidity(); } finally { pin.disabled = disabled; }
}
export async function mountDeviceControls({ container, call, onChanged }) {
  if (!container) return;
  let info;
  const message = document.createElement("div");
  message.setAttribute("role", "status");
  try {
    info = await call("/api/account/device-management");
    const main = info.mainDevice;
    container.innerHTML = `<p>${main ? `Main device: <strong>${h(main.name || "Unnamed device")} · ending ${h(main.mac.slice(-5))}</strong>. ${info.isMainController ? "This browser controls connection approvals." : "Use its controlling browser for connection approvals."}${main.routerChanged ? " Router settings changed; select the main device again." : ""}` : "Choose a main device to control assisted connections."}</p>
      <button type="button" data-select-main>${main ? "Select / recover main device" : "Select main device"}</button><div data-device-proof hidden></div><div data-pairing-controls></div>
      ${!document.getElementById("wifiDeviceList") && (info.approvedDevices || []).length ? `<section data-approved-devices><h3>Saved device approvals</h3><p>Forget a device to require fresh approval, even when it is offline. Router removal must finish before it can be approved again.</p>${info.approvedDevices.map((d) => `<div class="device"><div><strong>${h(d.name || "Unnamed device")} · ending ${h(d.mac.slice(-5))}${d.main ? " · Main device" : ""}</strong>${d.routerChanged ? "<p>Approval belongs to a previous router.</p>" : ""}${d.removal ? `<p role="status">${d.removal === "failed" ? "Saved approval revoked. Router removal needs support review." : "Saved approval revoked. Waiting for router removal; its slot is not confirmed free."}</p>` : ""}</div>${d.removal ? "" : `<button type="button" data-forget-device="${h(d.id)}">Forget device</button>`}</div>`).join("")}<button type="button" data-refresh-approvals>Refresh saved approvals</button></section>` : ""}`;
    container.appendChild(message);
    const query = new URLSearchParams(location.search), candidate = query.get("main-device");
    if ((!main || info.setupRequired) && /^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/i.test(candidate || "")) {
      const prompt = document.createElement("section"); prompt.className = "main-device-prompt";
      prompt.innerHTML = '<h3>Is this your main device?</h3><p>This device is connected. Choose whether this browser should manage other devices.</p><button type="button" data-main-yes>Yes, set as main device</button><button type="button" data-main-no class="secondary-action">No, skip for now</button>';
      container.prepend(prompt);
      const manage = container.closest("details");
      if (manage) manage.open = true;
      const clear = () => { const url = new URL(location.href); url.searchParams.delete("main-device"); history.replaceState(null, "", url.href); prompt.remove(); };
      prompt.querySelector("[data-main-yes]").onclick = async () => { await showProof(candidate.toUpperCase(), false); clear(); };
      prompt.querySelector("[data-main-no]").onclick = clear;
    }
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
      <button type="submit">${disconnect ? "Verify and disconnect" : "Verify and select"}</button>
      ${info.passkeys && window.PublicKeyCredential && navigator.credentials ? '<button type="button" data-device-passkey>Verify with passkey</button>' : ""}
      <button type="button" data-close-proof>Cancel</button><div data-proof-message role="status" aria-live="polite"></div></form>`;
    formHost.hidden = false;
    const form = formHost.querySelector("form"), output = form.querySelector("[data-proof-message]");
    if (mac && !disconnect) form.elements.mac.value = mac;
    async function submit(usePasskey) {
      const input = formValues(form), selected = choices.find((d) => d.mac === input.mac);
      if (!validProofForm(form, usePasskey)) return;
      if (!usePasskey && !/^\d{4}$/.test(input.pin || "")) { output.textContent = "Enter your four-digit PIN."; return; }
      try {
        await runButton(form.querySelector(usePasskey ? "[data-device-passkey]" : '[type="submit"]'), "Verifying…", async () => {
          let payload = { mac: input.mac, pin: input.pin, retainApproval: true,
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
  async function showForget(approvalId) {
    const device = (info.approvedDevices || []).find((d) => d.id === approvalId), host = container.querySelector("[data-device-proof]");
    if (!device || device.removal) return;
    host.innerHTML = `<form data-forget-proof><h3>Forget saved device</h3><p>${h(device.name || "Unnamed device")} · ending ${h(device.mac.slice(-5))} will need fresh approval to reconnect.${device.main ? " This also removes its main-device control." : ""}</p>
      <label><input type="checkbox" name="confirm" required> Remove this device's saved approval.</label>
      <label>Account PIN<input name="pin" type="password" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" autocomplete="current-password"></label>
      <button type="submit">Verify and forget</button>${info.passkeys && window.PublicKeyCredential && navigator.credentials ? '<button type="button" data-forget-passkey>Verify with passkey</button>' : ""}
      <button type="button" data-cancel-forget>Cancel</button><div role="status" data-forget-message></div></form>`;
    host.hidden = false;
    const form = host.querySelector("form"), output = form.querySelector("[data-forget-message]");
    async function submit(usePasskey) {
      if (!validProofForm(form, usePasskey)) return;
      const values = formValues(form);
      if (!usePasskey && !/^\d{4}$/.test(values.pin || "")) { output.textContent = "Enter your four-digit PIN."; return; }
      try {
        await runButton(form.querySelector(usePasskey ? "[data-forget-passkey]" : '[type="submit"]'), "Removing…", async () => {
          const payload = { approvalId, pin: values.pin };
          if (usePasskey) {
            const browser = await loadPasskeys(), challenge = await call("/api/account/device-management/forget/options", { method: "POST", body: JSON.stringify({ approvalId }) });
            delete payload.pin; payload.challengeId = challenge.challengeId;
            payload.response = await browser.startAuthentication({ optionsJSON: challenge.options });
          }
          await call("/api/account/device-management/forget", { method: "POST", body: JSON.stringify(payload) });
          form.reset(); host.hidden = true; await onChanged();
        }, { controls: Array.from(form.elements) });
      } catch (error) { showError(output, error); }
    }
    form.onsubmit = (event) => { event.preventDefault(); void submit(false); };
    const passkey = form.querySelector("[data-forget-passkey]");
    if (passkey) passkey.onclick = () => { void submit(true); };
    form.querySelector("[data-cancel-forget]").onclick = () => { form.reset(); host.hidden = true; };
    form.querySelector('[name="confirm"]').focus(); host.scrollIntoView({ block: "nearest" });
  }
  const saved = container.querySelector("[data-approved-devices]");
  if (saved) saved.onclick = (event) => {
    const refresh = event.target.closest("[data-refresh-approvals]");
    if (refresh) void runButton(refresh, "Refreshing…", onChanged).catch((error) => showError(message, error));
  };
  container.querySelector("[data-select-main]").onclick = () => showProof(null, false).catch((error) => showError(message, error));
  void mountPairingControls({ container: container.querySelector("[data-pairing-controls]"), call });
  container.closest("section").addEventListener("click", (event) => {
    const button = event.target.closest("[data-main-disconnect]");
    if (button) void showProof(button.dataset.mainDisconnect, true).catch((error) => showError(message, error));
    const forget = event.target.closest("[data-forget-device]");
    if (forget) void showForget(forget.dataset.forgetDevice).catch((error) => showError(message, error));
  });
  return { disconnect: (mac) => showProof(mac, true).catch((error) => showError(message, error)) };
}
