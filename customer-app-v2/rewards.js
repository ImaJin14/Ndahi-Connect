// Rewards (#528, canvas: PhoneRewards), opened from Account. The points card,
// then Redeem (bundles with their points prices; the ones out of reach say how
// many points are still needed), Invite friends (the code, Share and Copy link,
// the three steps and the friends) and History (the ledger). Redeeming asks
// first, then says the bundle is saved, with Start now (only once no bundle is
// running; the server checks) and the start-by date. Every figure comes from
// GET /api/account/rewards; the browser never sends a points amount.
import { requestJson } from "./compat.js";
import { responseError } from "./errors.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { format, getPreferredLanguage } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

document.documentElement.lang = getPreferredLanguage();
const api = window.NDAHI_CONFIG.apiUrl, $ = (selector) => document.querySelector(selector);
const L = (key, values) => format(key, values || {}, currentLanguage());
const fr = () => currentLanguage() === "fr";
// "1,240" / "1 240" (a no-break space, as the board writes it).
const num = (n) => Number(n || 0).toLocaleString(fr() ? "fr-FR" : "en-US").replace(/[   ]/g, " ");
// Dates as the board writes them: "12 Feb 2027", "1 Sep" (browsers now write
// "Sept" in English), "Wed 25 Nov"; French: "12 févr. 2027", "mer. 25 nov.".
const MONTHS = { en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
  fr: ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."] };
const DAYS = { en: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], fr: ["dim.", "lun.", "mar.", "mer.", "jeu.", "ven.", "sam."] };
const parts = (at) => { const d = new Date(at), lang = fr() ? "fr" : "en"; return { d: d.getDate(), m: MONTHS[lang][d.getMonth()], y: d.getFullYear(), w: DAYS[lang][d.getDay()] }; };
const day = (at) => { const p = parts(at); return `${p.d} ${p.m}`; };
const fullDay = (at) => { const p = parts(at); return `${p.d} ${p.m} ${p.y}`; };
const weekDay = (at) => { const p = parts(at); return `${p.w} ${p.d} ${p.m}`; };
const monthYear = (at) => { const p = parts(at); return `${p.m} ${p.y}`; };
const points = (n) => L(Math.abs(n) === 1 ? "rwPoint" : "rwPoints", { count: num(n) });
const length = (hours) => hours >= 48 && hours % 24 === 0 ? L("rwDays", { count: hours / 24 }) : hours === 1 ? L("rwHour") : L("rwHours", { count: hours });
const devices = (n) => (n === 1 ? L("rwDevice") : L("rwDevices", { count: n }));
const HOME = "home_wisp_unlimited";
// "24 hours · 1 device"; Home WISP: "30 days".
const line = (b) => [length(b.validityHours), b.accessType === HOME ? null : devices(b.deviceSlots || 1)].filter(Boolean).join(" · ");
const signed = (n) => (n > 0 ? `+${num(n)}` : `−${num(-n)}`);
const state = { data: null, tab: "redeem", view: "overview", offer: null, saved: null, key: "", shared: false, copied: false, error: "" };

async function call(path, data) {
  const { response, body } = await requestJson(api + path, data === undefined ? { credentials: "include", cache: "no-store" } : {
    method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": state.data?.csrfToken || "" }, body: JSON.stringify(data) });
  if (!response.ok) throw responseError(response, body);
  return body;
}

function card(d) {
  const next = d.nextExpiry, months = d.rules.expiryMonths;
  const expiry = next ? L(next.points === 1 ? "rwExpiryOne" : "rwExpiry", { points: points(next.points), date: fullDay(next.at), months }) : L("rwLast", { months });
  return `<section class="rewards__card-points" aria-label="${h(L("rwYourPoints"))}">
    <p class="rewards__kicker">${h(L("rwYourPoints"))}</p>
    <p class="rewards__balance" id="rewardsBalance">${h(points(d.balance))}</p>
    <p class="rewards__worth">${h(L("rwWorth", { amount: num(d.valueXaf) }))}</p>
    <p class="rewards__expiry">${h(expiry)}</p>
  </section>`;
}

function tabs(d) {
  const list = [["redeem", "rwRedeem"], ...(d.referral ? [["invite", "rwInvite"]] : []), ["history", "rwHistory"]];
  return `<div class="rewards__tabs" role="tablist" aria-label="${h(L("rwTitle"))}">${list.map(([id, key]) =>
    `<button type="button" role="tab" id="rewardsTab-${id}" aria-controls="rewardsPanel" aria-selected="${state.tab === id}" data-tab="${id}">${h(L(key))}</button>`).join("")}</div>`;
}

function redeemPanel(d) {
  const offers = d.offers.map((o) => {
    const text = o.affordable ? line(o) : L("rwNeed", { line: line(o), count: num(o.need) });
    return `<div class="rewards__offer"><span><strong>${h(o.name)}</strong><span>${h(text)}</span></span><button type="button" class="rewards__pts" data-offer="${h(o.id)}" ${o.affordable ? "" : "disabled"} aria-label="${h(L("rwRedeemAria", { points: num(o.points), name: o.name, line: line(o) }))}">${h(L("rwPts", { count: num(o.points) }))}</button></div>`;
  }).join("");
  const earn = d.programme.referrals ? L("rwEarnLine", { xaf: num(d.rules.xafPerPoint), referrer: num(d.rules.referrerPoints) }) : L("rwEarnLineNoFriends", { xaf: num(d.rules.xafPerPoint) });
  return `<div class="rewards__panel" id="rewardsPanel" role="tabpanel" aria-labelledby="rewardsTab-redeem">
    <p class="rewards__muted">${h(L("rwRedeemIntro"))}</p>
    ${offers ? `<div class="rewards__box rewards__offers">${offers}</div>` : ""}
    <p class="rewards__small">${h(earn)}</p>
  </div>`;
}

function invitePanel(d) {
  const r = d.referral, friends = r.friends.filter((f) => f.status === "joined" || f.status === "pending").map((f) => {
    const joined = f.status === "joined";
    return `<div class="rewards__row"><span><strong>${h(f.phone)}</strong><span>${h(joined ? L("rwJoined", { date: day(f.at) }) : L("rwInvited"))}</span></span><span class="rewards__friend-pts${joined ? "" : " rewards__friend-pts--pending"}">${h(joined ? signed(f.points ?? d.rules.referrerPoints) : L("rwPending"))}</span></div>`;
  }).join("");
  return `<div class="rewards__panel rewards__panel--invite" id="rewardsPanel" role="tabpanel" aria-labelledby="rewardsTab-invite">
    <div class="rewards__box rewards__code-card">
      <p class="rewards__muted">${h(L("rwYourCode"))}</p>
      <p class="rewards__code" id="rewardsCode">${h(r.code)}</p>
      <div class="rewards__code-actions"><button type="button" class="rewards__btn" data-share>${h(L(state.shared ? "rwShared" : "rwShare"))}</button><button type="button" class="rewards__btn2" data-copy>${h(L(state.copied ? "rwCopied" : "rwCopy"))}</button></div>
    </div>
    <ol class="rewards__steps">
      <li><span class="rewards__n">1</span><span>${h(L("rwStep1"))}</span></li>
      <li><span class="rewards__n">2</span><span>${h(L("rwStep2"))}</span></li>
      <li><span class="rewards__n">3</span><span>${h(L("rwStep3", { referrer: num(d.rules.referrerPoints), welcome: num(d.rules.welcomePoints) }))}</span></li>
    </ol>
    ${friends ? `<div class="rewards__box rewards__list">${friends}</div>` : ""}
    <p class="rewards__small">${h(L("rwInviteRules", { cap: d.rules.monthlyCap }))}</p>
  </div>`;
}

const KINDS = { earned: "rwKindEarned", referral: "rwKindReferral", redeemed: "rwKindRedeemed", expired: "rwKindExpired", welcome: "rwKindWelcome", refunded: "rwKindRefunded", adjusted: "rwKindAdjusted" };
function historyLine(r) {
  const parts = [day(r.at)];
  if (r.bundle && (r.kind === "earned" || r.kind === "redeemed") && r.bundle.validityHours) parts.push(line(r.bundle));
  if (r.kind === "referral" && r.friend) parts.push(r.friend);
  if (r.kind === "expired" && r.earnedFrom) parts.push(L("rwEarnedIn", { month: monthYear(r.earnedFrom) }));
  if (r.kind === "welcome" && r.invitedBy?.name) parts.push(L("rwInvitedBy", { name: r.invitedBy.name }));
  return parts.join(" · ");
}
function historyPanel(d) {
  const rows = d.history.filter((r) => r.points !== 0).map((r) =>
    `<div class="rewards__row"><span><strong>${h(L(KINDS[r.kind] || "rwKindAdjusted"))}</strong><span>${h(historyLine(r))}</span></span><strong class="rewards__amount${r.points < 0 ? " rewards__amount--minus" : ""}">${h(signed(r.points))}</strong></div>`).join("");
  return `<div class="rewards__panel" id="rewardsPanel" role="tabpanel" aria-labelledby="rewardsTab-history">${rows ? `<div class="rewards__box rewards__list">${rows}</div>` : ""}</div>`;
}

function render() {
  const d = state.data;
  document.title = `${L("rwTitle")} — NDAHI Connect`;
  $("#rewardsBarTitle").textContent = L("rwTitle");
  $("#rewardsBack").setAttribute("aria-label", L("rwBack"));
  if (!d) { $("#rewardsMain").innerHTML = state.error ? `<p class="rewards__alert" role="alert">${h(state.error)}</p>` : ""; return; }
  if (state.tab === "invite" && !d.referral) state.tab = "redeem";
  const panel = state.tab === "invite" ? invitePanel(d) : state.tab === "history" ? historyPanel(d) : redeemPanel(d);
  $("#rewardsMain").innerHTML = card(d) + tabs(d) + panel;
  renderSheet();
}

function chosenLine(b) {
  const regs = b.accessType === HOME ? L("rwUnlimitedOnly") : L("rwUnlimitedData", { devices: b.deviceSlots === 1 ? L("rwRegisteredOne") : L("rwRegistered", { count: b.deviceSlots }) });
  return `<strong>${h([b.name, line(b)].join(" · "))}</strong><span>${h(regs)}</span>`;
}
function renderSheet() {
  const d = state.data, host = $("#rewardsSheet");
  if (state.view === "confirm" && state.offer) {
    const o = state.offer, running = Boolean(d.activeBundle);
    host.innerHTML = `<div class="rewards__scrim" data-close><section class="rewards__sheet" role="dialog" aria-modal="true" aria-labelledby="rewardsConfirmTitle">
      <h2 id="rewardsConfirmTitle">${h(L("rwConfirmTitle"))}</h2>
      <div class="rewards__chosen">${chosenLine(o)}</div>
      <div class="rewards__sums"><div><span>${h(L("rwCost"))}</span><strong>${h(points(o.points))}</strong></div><div><span>${h(L("rwAfter"))}</span><span>${h(points(d.balance - o.points))}</span></div></div>
      <p class="rewards__note">${h(L(running ? "rwConfirmNote" : "rwConfirmNoteFree", { days: d.rules.startWithinDays }))}</p>
      ${state.error ? `<p class="rewards__sheet-error" role="alert">${h(state.error)}</p>` : ""}
      <button type="button" class="rewards__btn" data-redeem>${h(L("rwRedeemButton", { count: num(o.points) }))}</button>
      <button type="button" class="rewards__btn2" data-cancel>${h(L("rwCancel"))}</button>
    </section></div>`;
    host.querySelector("[data-redeem]").focus();
    return;
  }
  if (state.view === "done" && state.saved) {
    const s = state.saved, running = d.activeBundle;
    const note = running ? (running.endsAt ? L("rwStartNote", { date: weekDay(running.endsAt) }) : L("rwStartNoteNoDate")) : "";
    host.innerHTML = `<div class="rewards__scrim"><section class="rewards__sheet rewards__sheet--done" role="dialog" aria-modal="true" aria-labelledby="rewardsDoneTitle">
      <div class="rewards__check"><svg width="32" height="32" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="#345000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"></path></svg></div>
      <h2 id="rewardsDoneTitle">${h(L("rwDoneTitle"))}</h2>
      <p class="rewards__done-line">${h(L("rwDoneLine", { bundle: [s.bundle.name, line(s.bundle)].join(" · "), date: fullDay(s.startBy) }))}</p>
      ${state.error ? `<p class="rewards__sheet-error" role="alert">${h(state.error)}</p>` : ""}
      <button type="button" class="rewards__btn" data-start ${running ? "disabled" : ""}>${h(L("rwStartNow"))}</button>
      ${note ? `<p class="rewards__start-note">${h(note)}</p>` : ""}
      <a class="rewards__btn2" href="/dashboard">${h(L("rwGoHome"))}</a>
    </section></div>`;
    host.querySelector("#rewardsDoneTitle").focus?.();
    return;
  }
  host.innerHTML = "";
}

function close() {
  state.view = "overview"; state.offer = null; state.error = "";
  render();
  document.querySelector(".rewards__tabs [aria-selected=true]")?.focus();
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button, [data-close]");
  if (!target) return;
  if (target.dataset.tab) { state.tab = target.dataset.tab; render(); $(`#rewardsTab-${state.tab}`)?.focus(); return; }
  if (target.dataset.offer) {
    state.offer = state.data.offers.find((o) => o.id === target.dataset.offer);
    // One key per redemption: a double tap (or a retry of the same one) spends once.
    state.key = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(36).slice(2, 12);
    state.view = "confirm"; state.error = "";
    renderSheet();
    return;
  }
  if (target.matches("[data-close]") && event.target === target) { close(); return; }
  if (target.matches("[data-cancel]")) { close(); return; }
  if (target.matches("[data-redeem]")) {
    target.disabled = true;
    try {
      const done = await call("/api/account/rewards/redeem", { offerId: state.offer.id, idempotencyKey: state.key });
      state.data = { ...done.rewards, csrfToken: state.data.csrfToken };
      state.saved = done.saved; state.view = "done"; state.error = "";
      render();
    } catch (error) { state.error = error.message || L("rwFailed"); renderSheet(); }
    return;
  }
  if (target.matches("[data-start]")) {
    target.disabled = true;
    try {
      await call("/api/account/rewards/start", { voucherId: state.saved.voucherId });
      location.assign("/dashboard");
    } catch (error) { state.error = error.message || L("rwFailed"); renderSheet(); }
    return;
  }
  if (target.matches("[data-share]")) {
    const r = state.data.referral, text = L("rwShareText", { code: r.code, points: num(state.data.rules.welcomePoints), link: r.link });
    try {
      // The device's share sheet (WhatsApp is usually first); without one, WhatsApp itself.
      if (navigator.share) await navigator.share({ title: "NDAHI Connect", text, url: r.link });
      else window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
      state.shared = true; render(); $("[data-share]")?.focus();
    } catch { /* closed without sharing */ }
    return;
  }
  if (target.matches("[data-copy]")) {
    try { await navigator.clipboard.writeText(state.data.referral.link); state.copied = true; render(); $("[data-copy]")?.focus(); } catch { /* clipboard refused */ }
  }
});
document.addEventListener("keydown", (event) => { if (event.key === "Escape" && state.view === "confirm") close(); });

async function start() {
  render();
  try {
    state.data = await call("/api/account/rewards");
    const tab = new URLSearchParams(location.search).get("tab");
    if (["redeem", "invite", "history"].includes(tab)) state.tab = tab;
  } catch (error) {
    if (error.status === 401) { location.replace("/login?next=" + encodeURIComponent("/rewards.html")); return; }
    state.error = error.message || L("rwFailed");
  }
  render();
}
start();
