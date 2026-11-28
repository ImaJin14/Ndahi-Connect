// Invited by a friend (#529, canvas: PhoneInvite), at /r/<code>. A valid code
// shows who invited you (first name only), the code with its bonus points and
// the three steps, and is saved on this device for the first checkout. A number
// that already has an account (signed in here) can't use it; an unknown code
// says so. Both actions lead on: choose a bundle, or sign in.
import { requestJson } from "./compat.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { format, getPreferredLanguage } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

document.documentElement.lang = getPreferredLanguage();
const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
const L = (key, values) => format(key, values || {}, currentLanguage());
const num = (n) => Number(n || 0).toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-US").replace(/[   ]/g, " ");
const code = decodeURIComponent((location.pathname.match(/^\/r\/([^/]+)$/) || [])[1] || new URLSearchParams(location.search).get("code") || "");
// "24-hour", "7-day" bundle; French "24 heures", "7 jours".
const length = (hours) => (hours % 24 === 0 && hours >= 48 ? L("invDays", { count: hours / 24 }) : L("invHours", { count: hours }));

async function lookup() {
  if (!/^[A-Za-z]{1,8}-[A-Za-z0-9]{3}$/.test(code)) return { valid: false };
  const { response, body } = await requestJson(`${api}/api/referrals/${encodeURIComponent(code)}`, { cache: "no-store" });
  return response.ok ? body : { valid: false };
}
// Signed in here means this number already has an account. (The store's context
// answers either way, so a signed-out visitor sees no error.)
async function signedIn() {
  try { const { response, body } = await requestJson(`${api}/api/account/store/context`, { credentials: "include", cache: "no-store" }); return response.ok && body?.authenticated === true; } catch { return false; }
}

function render(state, invite) {
  const name = invite?.firstName;
  $("#inviteTitle").textContent = state === "invalid" ? L("invWelcome") : name ? L("invTitle", { name }) : L("invTitleFriend");
  $("#inviteLead").textContent = state !== "valid" ? L("invLeadPlain") : invite.freeBundle
    ? L("invLead", { points: num(invite.welcomePoints), bundle: length(invite.freeBundle.validityHours) }) : L("invLeadPoints", { points: num(invite.welcomePoints) });
  $("#inviteBuy").textContent = L(state === "valid" ? "invFirst" : "invChoose");
  $("#inviteLogin").textContent = L("invHaveAccount");
  $("#inviteMain").innerHTML = state === "valid" ? `<div class="invite__valid">
      <div class="invite__code"><span><span class="invite__code-label">${h(L("invCode"))}</span><strong id="inviteCode">${h(invite.code)}</strong></span><strong class="invite__bonus">${h(L("invPoints", { count: num(invite.welcomePoints) }))}</strong></div>
      <ol class="invite__steps">
        <li><span class="invite__n">1</span><span>${h(L("invStep1"))}</span></li>
        <li><span class="invite__n">2</span><span>${h(L("invStep2"))}</span></li>
        <li><span class="invite__n">3</span><span>${h(L("invStep3", { points: num(invite.welcomePoints) }))}</span></li>
      </ol>
      <p class="invite__fine">${h(L("invFine"))}</p>
    </div>`
    : state === "notNew" ? `<p class="invite__note invite__note--warn" role="status"><strong>${h(L("invNotNewStrong"))}</strong> ${h(L("invNotNew"))}</p>`
    : `<p class="invite__note invite__note--error" role="status"><strong>${h(L("invInvalidStrong"))}</strong> ${h(L("invInvalid"))}</p>`;
}

async function start() {
  let invite = { valid: false };
  try { invite = await lookup(); } catch { /* shown as not found */ }
  const state = !invite.valid ? "invalid" : (await signedIn()) ? "notNew" : "valid";
  // Saved for this number's first checkout (Buy a bundle sends it with the payment).
  try { if (state === "valid") localStorage.setItem("ndahi-referral", invite.code); } catch {}
  render(state, invite);
  document.body.dataset.inviteState = state;
}
start();
