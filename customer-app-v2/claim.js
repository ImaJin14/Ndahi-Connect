// Claim a bundle someone gave you (#254, canvas: PhoneClaimGift). The number
// and the code are both needed (no SMS: the code is the proof). Step 1 checks
// them; step 2 creates the account with a PIN (or signs an existing account
// in); step 3 starts the bundle on this phone now or keeps it for later.
import { requestJson } from "./compat.js";
import { responseError } from "./errors.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB");
const day = (at, year) => new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", ...(year ? { year: "numeric" } : {}) });
const deviceId = (() => {
  try { const saved = localStorage.getItem("ndahi-device"); if (saved) return saved; } catch (_) {}
  const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
  const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  try { localStorage.setItem("ndahi-device", id); } catch (_) {}
  return id;
})();
const STEPS = { code: "claimStep1", setup: "claimStep2", start: "claimStep3", online: "claimStepDone" };
const state = { phone: "", code: new URLSearchParams(location.search).get("code") || "", gift: null, token: "", mode: "setup", name: "", startBy: "", wrong: false };

async function call(path, data, csrf) {
  const { response, body } = await requestJson(api + path, data === undefined ? { credentials: "include" } : {
    method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) }, body: JSON.stringify(data) });
  if (!response.ok) throw responseError(response, body);
  return body;
}

const gift = `<svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12v9H4v-9M2 7h20v5H2ZM12 22V7M12 7S10.5 2 7.5 3.5 9 7 12 7ZM12 7s1.5-5 4.5-3.5S15 7 12 7Z"></path></svg>`;
const tick = `<svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"></path></svg>`;

// "5 GB · 7 days · up to 3 devices. The 7 days start when you choose."
function terms(plan) {
  const days = Math.round(plan.validityHours / 24), duration = days === 1 ? L("claimOneDay") : L("claimDays", { count: days });
  const data = plan.quotaBytes === null ? L("claimUnlimitedData") : `${+(plan.quotaBytes / 1e9).toFixed(1)} GB`;
  const devices = plan.deviceLimit === 1 ? L("claimOneDevice") : L("claimDevices", { count: plan.deviceLimit });
  return `${data} · ${duration} · ${devices}. ${days === 1 ? L("claimStartsOne") : L("claimStarts", { duration })}`;
}

function show(step) {
  $("#claimStep").textContent = L(STEPS[step]);
  $("#claimBarTitle").textContent = L("claimTitle");
  $("#claimBack").setAttribute("aria-label", L("claimBack"));
  const body = $("#claimBody");
  if (step === "code") body.innerHTML = `<form class="claim__form" id="claimCode" novalidate><main class="claim__main">
      <h1 class="claim__h1" id="claimHeading">${h(L("claimCodeTitle"))}</h1>
      <p class="claim__lede">${h(L("claimCodeLede"))}</p>
      <div><label class="claim__label" for="claimPhone">${h(L("claimPhone"))}</label>
        <div class="claim__phone"><span class="claim__prefix" aria-hidden="true">+237</span><input class="claim__input" id="claimPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="6XX XX XX XX" required value="${h(state.phone)}"></div></div>
      <div><label class="claim__label" for="claimCodeInput">${h(L("claimCode"))}</label>
        <input class="claim__input claim__input--code" id="claimCodeInput" name="code" autocomplete="off" autocapitalize="characters" spellcheck="false" required value="${h(state.code)}">
        <p class="claim__hint">${h(L("claimCodeHint"))}</p></div>
      <p class="claim__alert" id="claimError" role="alert"${state.wrong ? "" : " hidden"}>${state.wrong ? state.wrong : ""}</p>
    </main><div class="claim__foot"><button class="claim__btn" type="submit">${h(L("claimContinue"))}</button><a class="claim__btn claim__btn--secondary" href="/help#scan-qr">${h(L("claimScan"))}</a></div></form>`;
  if (step === "setup") {
    const g = state.gift, from = g.from.type === "friend" ? L("claimFromFriend", { name: g.from.name }) : L("claimFromNdahi");
    const login = state.mode === "login";
    body.innerHTML = `<form class="claim__form" id="claimSetup" novalidate><main class="claim__main claim__main--setup">
      <section class="claim__gift" aria-label="${h(L("claimYourBundle"))}"><p class="claim__from">${h(from)}</p>
        <p class="claim__plan">${h(L("claimWaiting", { plan: g.plan.name }))}</p><p class="claim__terms">${h(terms(g.plan))}</p>
        ${g.note ? `<p class="claim__note">"${h(g.note)}"</p>` : ""}</section>
      <h1 class="claim__h1 claim__h1--sm" id="claimHeading">${h(L(login ? "claimSignInTitle" : "claimSetupTitle"))}</h1>
      ${login ? `<div><label class="claim__label" for="claimPin">${h(L("claimYourPin"))}</label><input class="claim__input claim__input--pin" id="claimPin" name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4}" maxlength="4" required></div>`
      : `<div><label class="claim__label" for="claimName">${h(L("claimName"))}</label><input class="claim__input" id="claimName" name="name" autocomplete="name" required></div>
      <div class="claim__pins"><div><label class="claim__label" for="claimPin">${h(L("claimCreatePin"))}</label><input class="claim__input claim__input--pin" id="claimPin" name="pin" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4}" maxlength="4" required></div>
        <div><label class="claim__label" for="claimPin2">${h(L("claimRepeatPin"))}</label><input class="claim__input claim__input--pin" id="claimPin2" name="confirmPin" type="password" inputmode="numeric" autocomplete="new-password" pattern="[0-9]{4}" maxlength="4" required></div></div>
      <div><label class="claim__label" for="claimEmail">${h(L("claimEmail"))} <span class="claim__label-note">${h(L("claimEmailNote"))}</span></label><input class="claim__input" id="claimEmail" name="email" type="email" autocomplete="email" placeholder="you@example.com"></div>`}
      <p class="claim__alert" id="claimError" role="alert" hidden></p>
    </main><div class="claim__foot"><button class="claim__btn" type="submit">${h(L(login ? "claimSignInClaim" : "claimCreate"))}</button></div></form>`;
  }
  if (step === "start") body.innerHTML = `<main class="claim__main claim__main--done"><div class="claim__badge">${gift}</div>
      <h1 class="claim__h1" id="claimHeading">${h(L("claimYours", { name: state.name }))}</h1>
      <p class="claim__done-text">${h(L("claimSaved", { plan: state.gift.plan.name, date: day(state.startBy, true) }))}</p>
      <p class="claim__alert" id="claimError" role="alert" hidden></p></main>
    <div class="claim__foot"><button class="claim__btn" type="button" id="claimStart">${h(L("claimStartNow"))}</button><a class="claim__btn claim__btn--secondary" href="/dashboard#home">${h(L("claimLater"))}</a></div>`;
  if (step === "online") {
    const plan = state.gift.plan, ends = state.endsAt ? day(state.endsAt) : "";
    body.innerHTML = `<main class="claim__main claim__main--done"><div class="claim__badge">${tick}</div>
      <h1 class="claim__h1" id="claimHeading">${h(L("claimOnline"))}</h1>
      <p class="claim__done-text">${h(plan.quotaBytes === null ? L("claimStartedUnlimited", { plan: plan.name, date: ends }) : L("claimStarted", { plan: plan.name, date: ends, quota: `${+(plan.quotaBytes / 1e9).toFixed(1)} GB` }))}</p>
      <p class="claim__next">${h(L("claimNextTime"))}</p></main>
    <div class="claim__foot"><a class="claim__btn" href="/dashboard#home">${h(L("claimHome"))}</a></div>`;
  }
  $("#claimBack").href = step === "code" ? "/login" : step === "setup" ? "/claim.html" : "/dashboard#home";
  bind(step);
}

const fail = (error) => {
  const box = $("#claimError");
  box.textContent = error && error.message ? error.message : L("claimFailed");
  box.hidden = false;
};
async function busy(button, work) {
  button.disabled = true;
  try { await work(); } catch (error) { fail(error); } finally { if (button.isConnected) button.disabled = false; }
}

function bind(step) {
  const form = $("#claimCode") || $("#claimSetup");
  if (step === "code") form.onsubmit = (event) => {
    event.preventDefault();
    state.phone = form.elements.phone.value.trim();
    state.code = form.elements.code.value.trim();
    void busy(form.querySelector("[type=submit]"), async () => {
      try {
        const result = await call("/api/account/claim/check", { phone: state.phone, code: state.code });
        Object.assign(state, { token: result.token, mode: result.mode, gift: result.gift, wrong: false });
        show("setup");
        $("#claimHeading").focus?.();
      } catch (error) {
        if (error.code !== "CLAIM_MISMATCH") throw error;
        const box = $("#claimError");
        box.innerHTML = `<strong>${h(L("claimMismatch"))}</strong> ${h(L("claimMismatchHelp"))}`;
        box.hidden = false;
      }
    });
  };
  if (step === "setup") form.onsubmit = (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    void busy(form.querySelector("[type=submit]"), async () => {
      const done = await call("/api/account/claim/complete", { token: state.token, ...values });
      Object.assign(state, { name: done.claimed.name, startBy: done.claimed.startBy });
      // The email is optional: it is confirmed the usual way, with the new PIN as proof.
      if (values.email) {
        try {
          const { csrfToken } = await call("/api/account/dashboard");
          await call("/api/account/profile/email", { email: values.email.trim().toLowerCase(), pin: values.pin }, csrfToken);
        } catch (_) { /* Account settings can add it later. */ }
      }
      show("start");
    });
  };
  if (step === "start") $("#claimStart").onclick = (event) => void busy(event.currentTarget, async () => {
    const result = await call("/api/vouchers/redeem", { phone: state.phone, code: state.code, deviceId, label: L("claimThisPhone") });
    state.endsAt = result.voucher && result.voucher.expiresAt;
    show("online");
  });
}

show("code");
