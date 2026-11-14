// Buy a bundle for someone else's number (#255, canvas: PhoneBuyForOther).
// Step 1: their number (and name); the matching case shows under it. Step 2:
// the bundle and a note, paid with the buyer's own Mobile Money. Step 3: approve
// on the phone; the page checks by itself. Done: what happened, the code and
// its QR to pass on. The recipient's stored details are never shown: the API
// says only which case applies.
import { requestJson } from "./compat.js";
import { responseError } from "./errors.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { suggestedPaymentNetwork } from "/shared/cameroon-phone.js";

const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB");
const day = (at) => new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short" });
const price = (amount) => Number(amount).toLocaleString(locale());
const masked = (phone) => {
  const d = String(phone || "").replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
  // Kept on one line (no-break spaces).
  return d.length === 9 ? `${d[0]}••\u00a0••\u00a0${d.slice(5, 7)}\u00a0${d.slice(7)}` : "";
};
const STEPS = { who: "giftStep1", plan: "giftStep2", wait: "giftStep3", done: "giftStepDone" };
const METHODS = { mtn: "giftMtn", orange: "giftOrange" };
const state = { phone: "", name: "", case: null, endsAt: null, plans: [], plan: null, note: "", csrf: "", buyer: null, payment: null, result: null, timer: 0 };

async function call(path, data) {
  const { response, body } = await requestJson(api + path, data === undefined ? { credentials: "include" } : {
    method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": state.csrf }, body: JSON.stringify(data) });
  if (!response.ok) throw responseError(response, body);
  return body;
}

const who = () => state.name || masked(state.phone);
const duration = (hours) => hours % 24 === 0 ? (hours === 24 ? L("giftOneDay") : L("giftDays", { count: hours / 24 })) : L("giftHours", { count: hours });
const data = (plan) => plan.quotaGb === null ? L("giftUnlimited") : `${plan.quotaGb} GB`;
const network = () => suggestedPaymentNetwork(state.buyer.phone) || "mtn";
const icon = (path, colour, size) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="${colour}" stroke-width="${size > 30 ? 1.8 : 2.4}" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"></path></svg>`;

// The one case that applies, under the number (the canvas shows all three as a design note).
function caseCard() {
  const c = state.case;
  if (!c) return "";
  if (c === "unavailable" || c === "self") return `<p class="gift__alert" role="alert">${h(L(c === "self" ? "giftSelf" : "giftUnavailable"))}</p>`;
  const [title, body] = c === "noAccount" ? [L("giftNoAccountTitle"), L("giftNoAccountBody")]
    : c === "hasAccount" ? [state.name ? L("giftHasAccountTitle", { name: state.name }) : L("giftHasAccountTitleAnon"), L("giftHasAccountBody")]
    : [state.name ? L("giftActiveTitle", { name: state.name, date: day(state.endsAt) }) : L("giftActiveTitleAnon", { date: day(state.endsAt) }), L("giftActiveBody")];
  return `<div class="gift__card gift__card--on" role="status"><span><strong>${h(title)}</strong><span>${h(body)}</span></span></div>`;
}

function show(step) {
  clearTimeout(state.timer);
  $("#giftStep").textContent = L(STEPS[step]);
  $("#giftBarTitle").textContent = L("giftTitle");
  $("#giftBack").setAttribute("aria-label", L("giftBack"));
  const body = $("#giftBody");
  if (step === "who") body.innerHTML = `<form class="gift__form" id="giftWho" novalidate><main class="gift__main">
      <h1 class="gift__h1" id="giftHeading">${h(L("giftWhoTitle"))}</h1>
      <div><label class="gift__label" for="giftPhone">${h(L("giftPhone"))}</label><input class="gift__input" id="giftPhone" name="phone" type="tel" inputmode="tel" autocomplete="off" placeholder="6XX XX XX XX" required value="${h(state.phone)}"></div>
      <div><label class="gift__label" for="giftName">${h(L("giftName"))} <span class="gift__label-note">${h(L("giftOptional"))}</span></label><input class="gift__input" id="giftName" name="name" autocomplete="off" value="${h(state.name)}"></div>
      <div id="giftCase">${caseCard()}</div>
    </main><div class="gift__foot"><button class="gift__btn" type="submit">${h(L("giftContinue"))}</button></div></form>`;
  if (step === "plan") {
    const net = network();
    body.innerHTML = `<form class="gift__form" id="giftPlan" novalidate><main class="gift__main gift__main--plans">
      <h1 class="gift__h1" id="giftHeading">${h(state.name ? L("giftPlanTitle", { name: state.name }) : L("giftPlanTitleAnon"))}</h1>
      <div class="gift__plans" role="radiogroup" aria-labelledby="giftHeading">${state.plans.map((p) => `<button type="button" class="gift__card${p.id === state.plan?.id ? " gift__card--on" : ""}" role="radio" aria-checked="${p.id === state.plan?.id}" data-plan="${h(p.id)}">
        <span><strong class="gift__plan-name">${h(p.name)}</strong><span>${h(`${data(p)} · ${duration(p.validityHours)}`)}</span></span><strong>${h(L("giftPrice", { price: price(p.price) }))}</strong></button>`).join("")}</div>
      <div class="gift__note-field"><label class="gift__label" for="giftNote">${h(L("giftNote"))} <span class="gift__label-note">${h(L("giftOptional"))}</span></label><input class="gift__input" id="giftNote" name="note" maxlength="140" autocomplete="off" value="${h(state.note)}"></div>
      <p class="gift__alert" id="giftError" role="alert" hidden></p>
    </main><div class="gift__foot"><button class="gift__btn" type="submit"${state.plan ? "" : " disabled"}>${h(state.plan ? L("giftPay", { price: price(state.plan.price), method: L(METHODS[net]) }) : L("giftChoose"))}</button>
      <p class="gift__charged">${h(L("giftCharged", { number: masked(state.buyer.phone) }))}</p></div></form>`;
  }
  if (step === "wait") {
    const body2 = h(L("giftWaitBody", { method: L(METHODS[network()]), price: "\u0000" })).replace("\u0000", `<strong>${h(L("giftPrice", { price: price(state.plan.price) }))}</strong>`);
    body.innerHTML = `<main class="gift__main gift__main--center"><div class="gift__badge gift__badge--wait">${icon("M5 2h14v20H5ZM10 18h4M12 7v4l2 2", "currentColor", 38)}</div>
      <h1 class="gift__h1" id="giftHeading">${h(L("giftWaitTitle"))}</h1><p class="gift__text">${body2}</p>
      <p class="gift__alert" id="giftError" role="alert" hidden></p></main>
    <div class="gift__foot"><button class="gift__btn" type="button" id="giftCheck">${h(L("giftCheck"))}</button><a class="gift__btn gift__btn--secondary" href="/help#payment">${h(L("giftDidntGo"))}</a></div>`;
  }
  if (step === "done") {
    const g = state.result.gift, code = state.result.access.code, name = who();
    const [title, text] = g.outcome === "reserved" ? [L("giftDoneReserved"), L("giftDoneReservedBody", { name, number: masked(g.recipientPhone), duration: duration(state.plan.validityHours) })]
      : g.outcome === "savedUntilEnd" ? [L("giftDoneUntilEnd", { name }), L("giftDoneUntilEndBody", { date: day(g.recipientBundleEndsAt) })]
      : [L("giftDoneSaved", { name }), L("giftDoneSavedBody")];
    body.innerHTML = `<main class="gift__main gift__main--done"><div class="gift__done-head"><span class="gift__badge gift__badge--sm">${icon("m5 12 5 5 9-10", "currentColor", 26)}</span>
        <h1 class="gift__h1 gift__h1--done" id="giftHeading">${h(title)}</h1></div>
      <p class="gift__text gift__text--left">${h(text)}</p>
      <section class="gift__voucher" aria-label="${h(L("giftVoucher"))}"><p class="gift__for">${h(L("giftFor", { name, plan: state.plan.name }))}</p>
        <p class="gift__code">${h(code)}</p>${g.qr ? `<img class="gift__qr" src="${h(g.qr)}" alt="${h(L("giftQrFor", { code }))}">` : ""}</section></main>
    <div class="gift__foot"><button class="gift__btn" type="button" id="giftShare">${h(L(g.outcome === "reserved" ? "giftShare" : "giftShareAnyway"))}</button><a class="gift__btn gift__btn--secondary" href="/dashboard#activity">${h(L("giftActivity"))}</a></div>`;
  }
  $("#giftBack").href = step === "plan" ? "/gift.html" : "/dashboard#internet";
  bind(step);
}

const fail = (error) => {
  const box = $("#giftError");
  if (!box) return;
  box.textContent = error && error.message ? error.message : L("giftFailed");
  box.hidden = false;
};

function bind(step) {
  if (step === "who") {
    const form = $("#giftWho");
    // The case is looked up once the number is complete, and again if it changes.
    let looked = "";
    const lookup = async () => {
      const value = form.elements.phone.value.trim(), digits = value.replace(/\D/g, "").replace(/^237(?=\d{9}$)/, "");
      if (digits.length !== 9 || digits === looked) return;
      looked = digits;
      try {
        const found = await call("/api/account/gift/recipient", { phone: value });
        Object.assign(state, { phone: value, case: found.case, endsAt: found.endsAt || null });
      } catch (error) { state.case = null; $("#giftCase").innerHTML = `<p class="gift__alert" role="alert">${h(error.message || L("giftFailed"))}</p>`; return; }
      $("#giftCase").innerHTML = caseCard();
    };
    form.elements.phone.addEventListener("input", () => { if (form.elements.phone.value.replace(/\D/g, "").length < 9) { state.case = null; looked = ""; $("#giftCase").innerHTML = ""; } else void lookup(); });
    form.elements.phone.addEventListener("change", () => void lookup());
    form.elements.name.addEventListener("input", () => { state.name = form.elements.name.value.trim(); $("#giftCase").innerHTML = caseCard(); });
    form.onsubmit = async (event) => {
      event.preventDefault();
      state.name = form.elements.name.value.trim();
      await lookup();
      if (["noAccount", "hasAccount", "activeBundle"].includes(state.case)) { show("plan"); $("#giftHeading").focus?.(); }
      else if (!state.case) $("#giftCase").innerHTML = `<p class="gift__alert" role="alert">${h(L("giftEnterNumber"))}</p>`;
    };
  }
  if (step === "plan") {
    const form = $("#giftPlan");
    form.querySelectorAll("[data-plan]").forEach((button) => { button.onclick = () => {
      state.note = form.elements.note.value;
      state.plan = state.plans.find((p) => p.id === button.dataset.plan);
      show("plan");
      $(`[data-plan="${CSS.escape(state.plan.id)}"]`).focus();
    }; });
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!state.plan) return;
      state.note = form.elements.note.value.trim();
      const button = form.querySelector("[type=submit]");
      button.disabled = true;
      try {
        const made = await call("/api/account/plan/purchase", { action: "gift", planId: state.plan.id, recipientPhone: state.phone, recipientName: state.name, note: state.note,
          payerPhone: state.buyer.phone, network: network(), requestKey: crypto.randomUUID().replaceAll("-", "") });
        state.payment = made.payment;
        show("wait");
        poll();
      } catch (error) { fail(error); button.disabled = false; }
    };
  }
  if (step === "wait") $("#giftCheck").onclick = () => void check(true);
  if (step === "done") $("#giftShare").onclick = async (event) => {
    const button = event.currentTarget, code = state.result.access.code;
    const text = L("giftShareText", { plan: state.plan.name, code, url: `${location.origin}/login?claim=${encodeURIComponent(code)}` });
    try {
      if (navigator.share) { await navigator.share({ text }); button.textContent = L("giftShared"); }
      else { await navigator.clipboard.writeText(text); button.textContent = L("giftCopied"); }
    } catch (_) { /* Sharing was cancelled; the code stays on screen. */ }
  };
}

// The page checks the payment by itself; "Check status" checks now.
async function check(now) {
  try {
    const result = await call(`/api/account/payments/${encodeURIComponent(state.payment.id)}/status`);
    if (result.payment.status === "paid" && result.access) { state.result = result; show("done"); return true; }
    if (["failed", "expired", "cancelled"].includes(result.payment.status)) { fail({ message: L("giftPaymentFailed") }); return true; }
  } catch (error) { if (now) fail(error); }
  return false;
}
function poll() {
  state.timer = setTimeout(async () => { if (!(await check(false))) poll(); }, 3000);
}

async function start() {
  try {
    const dashboard = await call("/api/account/dashboard");
    Object.assign(state, { csrf: dashboard.csrfToken, buyer: dashboard.customer, plans: (dashboard.availablePlans || []).filter((p) => p.price > 0 && !p.discontinued) });
    // The buyer's own plan is chosen to start with (the canvas has one chosen).
    state.plan = state.plans.find((p) => p.id === dashboard.currentPlan?.plan?.id) || state.plans[0] || null;
    show("who");
  } catch (error) {
    if (error.status === 401) { location.replace("/login?next=" + encodeURIComponent("/gift.html")); return; }
    $("#giftBody").innerHTML = `<main class="gift__main"><p class="gift__alert" role="alert">${h(error.message || L("giftFailed"))}</p></main>`;
  }
}
void start();
