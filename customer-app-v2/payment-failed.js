// Payment problems (canvas: PhonePaymentFailed, #409; 24 Nov brief §3). One
// full-screen view per state the server gives (payment.state, #433):
// insufficient funds, expired, cancelled or wrong PIN, number not on this
// network, still pending, and unclear. Terminal states say no money was taken
// and offer Retry only once the server says the attempt is over; pending and
// unclear say not to pay again and keep checking. Every view shows the
// provider's reference (or NDAHI's payment id) to copy. Text goes in through
// textContent; the one bold amount is escaped before it is placed.
import { format } from "/shared/i18n.js";
import { currentLanguage, localize } from "/shared/ui/dom.js";
import { normalizeCameroonPhone } from "/shared/cameroon-phone.js";
import { escapeHtml } from "/shared/safe-html.js";

const ICON = {
  wallet: "M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3ZM3 7l12-4v4M17 13h.01",
  clock: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  cross: "M18 6 6 18M6 6l12 12",
  sim: "M6 3h9l4 4v14H6ZM9 12h6v5H9Z",
  question: "M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
};
// Each state as drawn: its tone, icon, title and second action.
const VIEWS = {
  insufficient_funds: { tone: "danger", icon: ICON.wallet, title: "payStateInsufficientTitle", secondary: "choose" },
  expired: { tone: "warning", icon: ICON.clock, title: "payStateExpiredTitle", secondary: "change" },
  cancelled_or_pin: { tone: "danger", icon: ICON.cross, title: "payStateCancelledTitle", secondary: "change" },
  invalid_subscriber: { tone: "danger", icon: ICON.sim, title: "payStateInvalidTitle", secondary: "choose" },
  pending: { tone: "warning", icon: ICON.clock, title: "payStatePendingTitle", secondary: "help", unresolved: true },
  unclear: { tone: "neutral", icon: ICON.question, title: "payStateUnclearTitle", secondary: "help", unresolved: true },
};
export const failureStates = Object.keys(VIEWS);
// Answers recorded before #433 carry only the older failure code.
const FROM_CODE = { declined: "cancelled_or_pin", low_balance: "insufficient_funds", check_balance: "insufficient_funds", wrong_network: "invalid_subscriber", timeout: "pending" };
// The state to show: the server's, unless it hasn't decided one (or the
// payment is paid); then the older code, or the reason asked for ("timeout"
// when the customer taps "Payment didn't go through?" on a live request).
export function shownState(payment, reason) {
  if (VIEWS[payment.state]) return payment.state;
  return FROM_CODE[reason] || VIEWS[reason] && reason || FROM_CODE[payment.failureCode] || null;
}
// Names as drawn: "MTN MoMo" for the wallet, "MTN" for the brand.
const NETWORKS = { mtn: { brand: "MTN", wallet: "MTN MoMo" }, orange: { brand: "Orange", wallet: "Orange Money" } };
const L = (key, values) => format(key, values || {}, currentLanguage());

// "Payment didn't go through?" under the waiting message (canvas: PhoneBuyBundle).
export const didntGoThroughButton = () =>
  `<button type="button" class="pay-failed-link" data-payment-failed>${escapeHtml(L("payFailedLink"))}</button>`;

// 670001245 -> "6•• •• 12 45", as on the canvas.
export function maskedNumber(value) {
  const digits = normalizeCameroonPhone(value);
  return /^6\d{8}$/.test(digits) ? `${digits[0]}•• •• ${digits.slice(5, 7)} ${digits.slice(7)}` : "";
}

// The words and actions for one state. `money` formats an amount ("4,080
// XAF"); the fee and total are the server's (#297, 24 Nov), and without them
// the body speaks of the fee in the operator prompt. `extra` carries the
// status's cheaper bundle and verified short codes.
export function failureContent(payment, state, { money = (value) => `${value} FCFA`, checks = 1, cheaperBundle = null, shortCodes = null } = {}) {
  const view = VIEWS[state], network = payment.network === "orange" ? "orange" : "mtn", other = network === "mtn" ? "orange" : "mtn";
  const n = NETWORKS[network], hasFee = Number.isFinite(payment.fee) && Number.isFinite(payment.total);
  const number = payment.payerPhoneMasked || maskedNumber(payment.payerPhone);
  // The body, with its one bold amount kept apart so it can be escaped.
  let body;
  if (state === "insufficient_funds") body = hasFee ? ["payStateInsufficientBody", { total: money(payment.total) }, "total"] : ["payStateInsufficientBodyNoFee", { price: money(payment.amount) }, null];
  else if (state === "expired") body = shortCodes ? ["payStateExpiredBodyCodes", { mtn: shortCodes.mtn, orange: shortCodes.orange }, null] : ["payStateExpiredBody", {}, null];
  else if (state === "cancelled_or_pin") body = ["payStateCancelledBody", {}, null];
  else if (state === "invalid_subscriber") body = ["payStateInvalidBody", { wallet: n.wallet }, null];
  else body = [state === "pending" ? "payStatePendingBody" : "payStateUnclearBody", { brand: n.brand }, null];
  const [bodyKey, bodyValues, bold] = body;
  const switchTo = state === "insufficient_funds" && hasFee && cheaperBundle && Number.isFinite(cheaperBundle.total) ? cheaperBundle : null;
  return {
    state, network, other, tone: view.tone, icon: view.icon, unresolved: Boolean(view.unresolved),
    title: L(view.title),
    // The body as safe HTML: escaped text with the amount in <strong>.
    bodyHtml: bold ? escapeHtml(L(bodyKey, { ...bodyValues, [bold]: "\u0000" })).replace("\u0000", `<strong>${escapeHtml(bodyValues[bold])}</strong>`) : escapeHtml(L(bodyKey, bodyValues)),
    money: L(view.unresolved ? "payStateDontPay" : "payStateNoMoney"),
    checks: view.unresolved ? L(checks === 1 ? "payStateCheckedOne" : "payStateCheckedMany", { count: checks }) : "",
    bundle: payment.plan?.name || payment.planId || "",
    price: money(payment.amount),
    fee: hasFee ? money(payment.fee) : "",
    total: hasFee ? money(payment.total) : "",
    method: [n.wallet, number].filter(Boolean).join(" · "),
    number: payment.payerPhone || "",
    // The provider's reference, or NDAHI's own payment id when there is none.
    reference: String(payment.reference || payment.providerReference || payment.id || ""),
    switchTo, switchLabel: switchTo ? L("payStateSwitch", { name: switchTo.name, total: money(switchTo.total) }) : "",
    // Retry only once the server says the attempt is over (#433).
    retry: !view.unresolved, retryAllowed: payment.retryAllowed !== false,
    otherWallet: state === "invalid_subscriber" ? L("payStateUseOther", { wallet: NETWORKS[other].wallet }) : "",
    secondary: { choose: L("payStateChooseBundle"), change: L("payStateChangeNumber"), help: L("payStateGetHelp") }[view.secondary],
    secondaryKind: view.secondary,
  };
}

const $ = (selector) => document.querySelector(selector);
const pageParts = () => ["body > header", "#pageContent", "body > .footer-note", "#checkout"].map((s) => $(s)).filter(Boolean);
let open = null;

// Shows the view. `actions` are called with the payment and the content:
// retry (with the number in the field, for a wrong network), otherNetwork,
// differentNumber, smallerBundle, switchBundle and checkAgain.
export function showPaymentFailed(payment, reason, actions = {}, options = {}) {
  const view = $("#paymentFailed"), state = shownState(payment, reason);
  if (!view || !state) return false;
  const content = failureContent(payment, state, options);
  const set = (id, text) => { $(id).textContent = text; };
  const show = (id, visible) => { $(id).hidden = !visible; };
  view.dataset.state = state;
  view.dataset.tone = content.tone;
  $("#paymentFailedIcon").setAttribute("d", content.icon);
  set("#paymentFailedTitle", content.title);
  $("#paymentFailedBody").innerHTML = content.bodyHtml;
  set("#paymentFailedMoney", content.money);
  // A number the network doesn't know: correct it here, masked until used.
  show("#paymentFailedNumberField", state === "invalid_subscriber");
  const number = $("#paymentFailedNumber");
  if (state === "invalid_subscriber" && document.activeElement !== number) number.value = String(content.number).replace(/^\+?237(?=6)/, "");
  // A closed checkout's outcome gives only the masked number: it shows until the field is used.
  number.dataset.masked = payment.payerPhoneMasked || "";
  maskFailedNumber();
  set("#paymentFailedBundle", content.bundle);
  set("#paymentFailedPrice", content.price);
  show("#paymentFailedFeeRow", Boolean(content.fee));
  show("#paymentFailedTotalRow", Boolean(content.total));
  set("#paymentFailedFee", content.fee);
  set("#paymentFailedTotal", content.total);
  set("#paymentFailedMethod", content.method);
  set("#paymentFailedReference", content.reference);
  show("#paymentFailedChecks", content.unresolved);
  set("#paymentFailedChecks", content.checks);
  // The actions, in the drawn order.
  const check = $("#paymentFailedCheck"), switchTo = $("#paymentFailedSwitch"), retry = $("#paymentFailedRetry"),
    otherNet = $("#paymentFailedOther"), secondary = $("#paymentFailedSecondary"), help = $("#paymentFailedHelpLink");
  show("#paymentFailedCheck", content.unresolved);
  show("#paymentFailedSwitch", Boolean(content.switchTo));
  switchTo.textContent = content.switchLabel;
  show("#paymentFailedRetry", content.retry);
  retry.disabled = !content.retryAllowed;
  // Retry is the lime button unless a cheaper bundle is offered first.
  retry.classList.toggle("nd-btn--secondary", Boolean(content.switchTo));
  show("#paymentFailedOther", Boolean(content.otherWallet));
  otherNet.textContent = content.otherWallet;
  show("#paymentFailedSecondary", content.secondaryKind !== "help");
  show("#paymentFailedHelpLink", content.secondaryKind === "help");
  if (content.secondaryKind === "help") help.textContent = content.secondary; else secondary.textContent = content.secondary;
  check.onclick = () => actions.checkAgain?.(payment, content);
  switchTo.onclick = () => actions.switchBundle?.(payment, content);
  retry.onclick = () => actions.retry?.(payment, { ...content, number: state === "invalid_subscriber" ? number.value.trim() : "" });
  otherNet.onclick = () => actions.otherNetwork?.(payment, content);
  secondary.onclick = () => actions[content.secondaryKind === "choose" ? "smallerBundle" : "differentNumber"]?.(payment, content);
  // Copy the reference; where the clipboard isn't allowed, select it instead.
  const copy = $("#paymentFailedCopy");
  copy.textContent = L("payStateCopy");
  copy.onclick = async () => {
    try { await navigator.clipboard.writeText(content.reference); copy.textContent = L("payStateCopied"); }
    catch { const range = document.createRange(); range.selectNodeContents($("#paymentFailedReference")); getSelection().removeAllRanges(); getSelection().addRange(range); }
  };
  if (!open) {
    if (!view.dataset.localized) { localize(view, currentLanguage()); view.dataset.localized = "true"; }
    open = { focus: document.activeElement };
    for (const part of pageParts()) { part.inert = true; part.setAttribute("aria-hidden", "true"); }
    view.hidden = false;
    document.body.classList.add("pay-failed-open");
    $("#paymentFailedTitle").focus();
  }
  return true;
}

// The corrected number shows masked ("6•• •• 12 45") until the field is used.
function maskFailedNumber() {
  const input = $("#paymentFailedNumber"), mask = $("#paymentFailedNumberMask");
  if (!input || !mask) return;
  const masked = document.activeElement === input ? "" : input.value ? maskedNumber(input.value) : input.dataset.masked || "";
  mask.textContent = masked;
  input.classList.toggle("pay-failed__number--masked", Boolean(masked) && Boolean(input.value));
}
document.addEventListener("focusin", (event) => { if (event.target?.id === "paymentFailedNumber") maskFailedNumber(); });
document.addEventListener("focusout", (event) => { if (event.target?.id === "paymentFailedNumber") maskFailedNumber(); });

export function hidePaymentFailed() {
  const view = $("#paymentFailed");
  if (!view || view.hidden) return;
  view.hidden = true;
  document.body.classList.remove("pay-failed-open");
  for (const part of pageParts()) { part.inert = false; part.removeAttribute("aria-hidden"); }
  open = null;
}

export const paymentFailedOpen = () => Boolean(open);
