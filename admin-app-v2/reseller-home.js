// Reseller home (#261, canvas: ResellerHome). A reseller's Home is this phone
// screen instead of the admin shell: codes in hand, sales this week and what
// they owe NDAHI; "Sell a code" shows the code and its QR to the customer, then
// "Cash received" records the sale. Owner decision (19 Nov): a code redeemed
// before the cash is recorded still counts as sold, so the code may be shown
// first, as designed. Every amount comes from the server
// (GET /api/admin/resellers/ledger?view=home); the browser never works out a
// price, commission or balance. Other views (print, cash) keep the admin shell.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB");
const fcfa = (value) => `${Number(value || 0).toLocaleString(locale())} FCFA`;
const day = (iso) => new Date(iso).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "Africa/Douala" });
const operationKey = () => (crypto.randomUUID ? crypto.randomUUID().replaceAll("-", "") : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join(""));
// Answers that settle a cash sale for good: the saved attempt is dropped.
const FINAL = ["OPERATION_KEY_REQUIRED", "IDEMPOTENCY_CONFLICT", "VOUCHER_NOT_SELLABLE", "PRICE_UNAVAILABLE"];

export function mountResellerHome({ call, logout }) {
  let view = document.getElementById("resellerHome");
  if (!view) {
    view = document.createElement("section");
    view.id = "resellerHome";
    view.className = "reseller-home";
    view.setAttribute("aria-label", "Reseller home");
    document.body.append(view);
  }
  let data = null, error = "", planId = "", selling = null, sold = null, message = "", busy = false, asked = false, storageKey = "", onHome = true;
  // The admin navigation decides the view (a blocked page resolves to Home).
  const show = () => {
    view.hidden = !onHome;
    document.body.classList.toggle("reseller-home-on", onHome);
  };
  const saved = () => { try { return JSON.parse(sessionStorage.getItem(storageKey) || "null"); } catch { return null; } };
  const save = (value) => { try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey); } catch { /* best effort */ } };

  // Stock grouped by bundle, in the order the server lists it.
  function groups() {
    const map = new Map();
    for (const v of data?.stock || []) {
      const g = map.get(v.planId) || { planId: v.planId, name: v.plan?.name || v.planId, vouchers: [] };
      g.vouchers.push(v);
      map.set(v.planId, g);
    }
    return [...map.values()];
  }

  function render() {
    if (!data) {
      view.innerHTML = `<div class="reseller-home__screen"><main class="reseller-home__main"><p role="status">${h(error || L("resellerLoading"))}</p>
        ${error ? `<button type="button" class="reseller-home__btn2" data-reload>${h(L("resellerRetry"))}</button>` : ""}</main></div>`;
      view.querySelector("[data-reload]")?.addEventListener("click", load);
      return;
    }
    const r = data.reseller || {}, list = groups(), current = list.find((g) => g.planId === planId) || list[0];
    const paid = (r.remittances || [])[0];
    view.innerHTML = `<div class="reseller-home__screen">
  <header class="reseller-home__head">
    <div class="reseller-home__top">
      <span class="reseller-home__brand"><span class="reseller-home__mark">NC</span><span class="reseller-home__word"><strong>NDAHI</strong><small>${h(L("resellerBrand"))}</small></span></span>
      <a href="/login" class="reseller-home__out" data-sign-out>${h(L("resellerSignOut"))}</a>
    </div>
    <h1 class="reseller-home__title">${h(r.displayName || r.username || "")}</h1>
    <p class="reseller-home__sub">${h(L("resellerKeeps", { name: r.username || "", rate: r.commissionPercent ?? 0 }))}</p>
  </header>
  <main class="reseller-home__main">
    <div class="reseller-home__stats">
      <div class="reseller-home__st"><b data-stock-count>${h(data.stockCount ?? 0)}</b><span>${h(L("resellerInHandTile"))}</span></div>
      <div class="reseller-home__st"><b data-sold-count>${h(data.salesThisWeek ?? 0)}</b><span>${h(L("resellerSoldTile"))}</span></div>
      <div class="reseller-home__st reseller-home__st--owe"><b data-owed>${h(fcfa(r.outstandingBalance))}</b><span>${h(L("resellerOweTile"))}</span></div>
    </div>
    ${selling ? `<section class="reseller-home__sell" aria-label="${h(L("resellerSellLabel"))}">
      <p class="reseller-home__eyebrow">${h(L("resellerShowCustomer", { plan: selling.planName }))}</p>
      <p class="reseller-home__code" data-sell-code>${h(selling.code)}</p>
      ${selling.qr ? `<img class="reseller-home__qr" src="${h(selling.qr)}" alt="${h(L("resellerQrFor", { code: selling.code }))}" width="128" height="128">` : ""}
      <p class="reseller-home__take">${h(L("resellerTakeCash", { price: Number(selling.price || 0).toLocaleString(locale()) }))}</p>
      <div class="reseller-home__pair">
        <button type="button" class="reseller-home__cancel" data-cancel ${busy ? "disabled" : ""}>${h(L("resellerCancel"))}</button>
        <button type="button" class="reseller-home__received" data-received ${busy ? "disabled" : ""}>${h(L("resellerCashReceived"))}</button>
      </div>
    </section>` : `<div class="reseller-home__choose">
      ${sold ? `<p class="reseller-home__sold" role="status">${h(L("resellerSold", { code: sold.code, price: Number(sold.amount || 0).toLocaleString(locale()) }))}</p>` : ""}
      <label for="resellerPlan" class="reseller-home__label">${h(L("resellerBundleToSell"))}</label>
      <select id="resellerPlan" class="reseller-home__select" ${list.length ? "" : "disabled"}>${list.length
        ? list.map((g) => `<option value="${h(g.planId)}" ${g === current ? "selected" : ""}>${h(L("resellerPlanInHand", { plan: g.name, count: g.vouchers.length }))}</option>`).join("")
        : `<option>${h(L("resellerNoStock"))}</option>`}</select>
      <button type="button" class="reseller-home__btn" data-sell ${list.length && !busy ? "" : "disabled"}>${h(L("resellerSellCode"))}</button>
    </div>`}
    <p class="reseller-home__message" role="status" aria-live="polite">${h(message)}</p>
    <section aria-labelledby="resellerMoney" class="reseller-home__money">
      <h2 id="resellerMoney">${h(L("resellerYourMoney"))}</h2>
      <div class="reseller-home__row"><span>${h(L("resellerCollectedWeek"))}</span><strong data-collected>${h(fcfa(data.weeklyCollected))}</strong></div>
      <div class="reseller-home__row"><span>${h(L("resellerCommission"))}</span><strong data-commission>${h(fcfa(data.weeklyCommission))}</strong></div>
      <div class="reseller-home__row"><span>${h(paid ? L("resellerPaidOn", { date: day(paid.createdAt) }) : L("resellerPaid"))}</span><strong data-paid>${h(paid ? fcfa(paid.amount) : L("resellerNothingYet"))}</strong></div>
      <div class="reseller-home__row reseller-home__row--last"><span>${h(L("resellerStillToPay"))}</span><strong data-still>${h(fcfa(r.outstandingBalance))}</strong></div>
    </section>
    <div class="reseller-home__pair reseller-home__foot">
      <button type="button" class="reseller-home__btn2" data-ask ${asked || busy ? "disabled" : ""}>${h(L(asked ? "resellerRequestSent" : "resellerAskMore"))}</button>
      <a class="reseller-home__btn2" href="/dashboard#voucher-print">${h(L("resellerPrintCodes"))}</a>
    </div>
  </main>
</div>`;
    view.querySelector("#resellerPlan")?.addEventListener("change", (event) => { planId = event.target.value; sold = null; message = ""; render(); });
    view.querySelector("[data-sell]")?.addEventListener("click", () => sell(current));
    view.querySelector("[data-cancel]")?.addEventListener("click", () => { selling = null; message = ""; save(null); render(); });
    view.querySelector("[data-received]")?.addEventListener("click", received);
    view.querySelector("[data-ask]")?.addEventListener("click", ask);
    view.querySelector("[data-sign-out]")?.addEventListener("click", (event) => { event.preventDefault(); void logout(); });
  }

  async function load() {
    try {
      data = await call("/api/admin/resellers/ledger?view=home");
      error = "";
      storageKey = `ndahi-reseller-home:${data.reseller?.resellerId || "me"}`;
      const latest = (data.stockRequests || [])[0];
      asked = Boolean(latest && Date.now() - Date.parse(latest.createdAt) < 864e5);
    } catch (e) { error = e.message || L("resellerLoadFailed"); }
    render();
  }

  // The first code of the chosen bundle, with its QR, shown before the cash.
  async function sell(group) {
    if (!group || busy) return;
    const v = group.vouchers[0];
    busy = true; message = ""; sold = null; render();
    try {
      const { detail } = await call(`/api/admin/vouchers/${encodeURIComponent(v.id)}/details?full=1`);
      selling = { voucherId: v.id, code: detail?.code || v.code, qr: detail?.qr || "", price: v.faceValue ?? v.plan?.price, planName: group.name };
      save({ ...selling, key: operationKey() });
    } catch (e) { message = e.message || L("resellerFailed"); }
    busy = false; render();
  }

  // Records the sale once. The saved key makes a retry after a lost answer
  // safe: the server replays the same sale instead of recording another.
  async function received() {
    const pending = saved();
    if (!selling || !pending || busy) return;
    busy = true; message = ""; render();
    try {
      const result = await call("/api/admin/resellers/cash-sale", { method: "POST", headers: { "idempotency-key": pending.key },
        body: JSON.stringify({ voucherId: pending.voucherId, operationKey: pending.key }) });
      sold = { code: selling.code, amount: result.sale?.amount };
      selling = null; save(null);
      await load();
    } catch (e) {
      if (FINAL.includes(e.code)) { selling = null; save(null); message = `${e.message} ${L("resellerNotRecorded")}`; }
      else message = e.message || L("resellerRetrySale");
    }
    busy = false; render();
  }

  async function ask() {
    if (busy || asked) return;
    busy = true; render();
    try {
      const key = operationKey();
      await call("/api/admin/resellers/stock-requests", { method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify({ operationKey: key }) });
      asked = true; message = "";
    } catch (e) { message = e.message || L("resellerFailed"); }
    busy = false; render();
  }

  show();
  void load().then(() => {
    // A sale whose answer was lost: show the same code again, ready to confirm.
    const pending = saved();
    if (pending && !selling) { selling = pending; message = L("resellerResume"); render(); }
  });
  return { setView(name) { onHome = name === "home"; show(); } };
}
