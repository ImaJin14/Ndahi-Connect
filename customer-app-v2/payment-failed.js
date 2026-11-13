// "Payment didn't go through" (canvas: PhonePaymentFailed). One full-screen
// view per reason the API gives (payment.failureCode): declined, low_balance,
// wrong_network after the provider confirmed the failure (no money taken), and
// timeout while a request is unresolved (don't pay again yet). Text only through
// textContent; the API's values are never parsed as HTML.
import { format } from "/shared/i18n.js";
import { currentLanguage, localize } from "/shared/ui/dom.js";
import { normalizeCameroonPhone } from "/shared/cameroon-phone.js";
import { escapeHtml } from "/shared/safe-html.js";

const ICONS = {
  declined: "M18 6 6 18M6 6l12 12",
  low_balance: "M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H3ZM3 7l12-4v4M17 13h.01",
  timeout: "M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  wrong_network: "M6 3h9l4 4v14H6ZM9 12h6v5H9Z",
};
// Names as the canvas writes them: "MTN MoMo" in buttons, "MoMo" for the balance.
const NETWORKS = {
  mtn: { brand: "MTN", wallet: "MTN MoMo", balance: "MoMo" },
  orange: { brand: "Orange", wallet: "Orange Money", balance: "Orange Money" },
};
export const failureReasons = Object.keys(ICONS);
const L = (key, values) => format(key, values, currentLanguage());

// "Payment didn't go through?" under the waiting message (canvas: PhoneBuyBundle).
export const didntGoThroughButton = () =>
  `<button type="button" class="pay-failed-link" data-payment-failed>${escapeHtml(L("payFailedLink"))}</button>`;

// 670001245 -> "6•• •• 12 45", as on the canvas.
export function maskedNumber(value) {
  const digits = normalizeCameroonPhone(value);
  return /^6\d{8}$/.test(digits) ? `${digits[0]}•• •• ${digits.slice(5, 7)} ${digits.slice(7)}` : "";
}

// The words for one reason; `money` formats the amount ("1 500 FCFA").
export function failureContent(payment, reason, { money = (value) => `${value} FCFA`, checks = 1 } = {}) {
  const network = payment.network === "orange" ? "orange" : "mtn", other = network === "mtn" ? "orange" : "mtn";
  const n = NETWORKS[network], o = NETWORKS[other];
  const values = { brand: n.brand, wallet: n.wallet, balance: n.balance, otherBrand: o.brand, otherWallet: o.wallet,
    price: money(payment.amount), number: payment.payerPhoneMasked || maskedNumber(payment.payerPhone) };
  const key = { declined: "Declined", low_balance: "LowBalance", timeout: "Timeout", wrong_network: "WrongNetwork" }[reason];
  const timeout = reason === "timeout";
  return {
    reason, network, other, timeout,
    tone: timeout ? "warning" : "danger",
    icon: ICONS[reason],
    title: L(`payFailed${key}Title`, values),
    body: L(`payFailed${key}Body`, values),
    money: L(timeout ? "payFailedTimeoutMoney" : "payFailedNoMoney", values),
    primary: timeout ? L("payFailedCheckAgain", values) : L(`payFailed${key}Primary`, values),
    secondary: L(`payFailed${key}Secondary`, values),
    checks: timeout ? L(checks === 1 ? "payFailedCheckedOne" : "payFailedCheckedMany", { count: checks }) : "",
    bundle: [payment.plan?.name, money(payment.amount)].filter(Boolean).join(" · "),
    method: [n.wallet, values.number].filter(Boolean).join(" · "),
    reference: String(payment.id || ""),
  };
}

const $ = (selector) => document.querySelector(selector);
const pageParts = () => ["body > header", "#pageContent", "body > .footer-note", "#checkout"].map((s) => $(s)).filter(Boolean);
let open = null;

// Shows the view. `actions` are called with the payment: tryAgain,
// otherNetwork, smallerBundle, differentNumber and checkAgain (timeout).
export function showPaymentFailed(payment, reason, actions = {}, options = {}) {
  const view = $("#paymentFailed");
  if (!view || !failureReasons.includes(reason)) return false;
  const content = failureContent(payment, reason, options);
  const set = (id, text) => { $(id).textContent = text; };
  view.dataset.reason = reason;
  view.dataset.tone = content.tone;
  $("#paymentFailedIcon").setAttribute("d", content.icon);
  set("#paymentFailedTitle", content.title);
  set("#paymentFailedBody", content.body);
  set("#paymentFailedMoney", content.money);
  set("#paymentFailedBundle", content.bundle);
  set("#paymentFailedMethod", content.method);
  set("#paymentFailedReference", content.reference);
  $("#paymentFailedChecks").hidden = !content.timeout;
  set("#paymentFailedChecks", content.checks);
  const primary = $("#paymentFailedPrimary"), secondary = $("#paymentFailedSecondary"), help = $("#paymentFailedHelpLink");
  primary.textContent = content.primary;
  // Timeout's second action is a link to help; the others are buttons.
  secondary.hidden = content.timeout;
  help.hidden = !content.timeout;
  if (content.timeout) help.textContent = content.secondary; else secondary.textContent = content.secondary;
  const run = { declined: ["tryAgain", "otherNetwork"], low_balance: ["tryAgain", "smallerBundle"],
    wrong_network: ["otherNetwork", "differentNumber"], timeout: ["checkAgain"] }[reason];
  primary.onclick = () => actions[run[0]]?.(payment, content);
  secondary.onclick = () => actions[run[1]]?.(payment, content);
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

export function hidePaymentFailed() {
  const view = $("#paymentFailed");
  if (!view || view.hidden) return;
  view.hidden = true;
  document.body.classList.remove("pay-failed-open");
  for (const part of pageParts()) { part.inert = false; part.removeAttribute("aria-hidden"); }
  open = null;
}

export const paymentFailedOpen = () => Boolean(open);
