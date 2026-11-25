// Buy a bundle on desktop (canvas: DesktopBuyBundle, #431). Signed-in
// customers on a wide screen, when the catalogue on sale is the Unlimited one
// (after the switch, #332), see every Personal Unlimited price as a table
// (validity by 1–6 devices; combinations not offered are disabled), the Home
// WISP card, and "Your choice" beside them: the same checkout form as the
// phone, shown inline, so Pay Now continues into the same payment flow.
// Everything comes from GET /api/plans: names, prices, terms and each
// network's quote (#297, #432). Owner decisions: no acknowledgement checkbox,
// signed-in customers only:
// https://github.com/ImaJin14/Ndahi-Connect/issues/431#issuecomment-7151368540
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { renderPortalHeader, renderNetworkStatus } from "/shared/ui/navigation.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const DEVICES = [1, 2, 3, 4, 5, 6];
const HREFS = { home: "/dashboard#home", internet: "/dashboard#internet", shop: "/dashboard#shop", activity: "/dashboard#activity", account: "/dashboard#account" };
export const WALLET_NAMES = { mtn: "MTN MoMo", orange: "Orange Money" };

// "4,000 XAF" / "4 000 XAF", as on the canvas.
export const xaf = (value) => `${Number(value).toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-US").replace(/[  ]/g, " ")} XAF`;
const devicesLabel = (n) => L(n === 1 ? "deskBuyOneDevice" : "deskBuyDevices", { count: n });
export function validityLabel(plan) {
  const value = Number(plan.validityValue), unit = plan.validityUnit;
  if (unit === "days") return L(value === 1 ? "deskBuyOneDay" : "deskBuyDays", { count: value });
  if (unit === "hours") return L(value === 1 ? "deskBuyOneHour" : "deskBuyHours", { count: value });
  const hours = Number(plan.validityHours) || 0;
  return hours % 24 === 0 ? L(hours === 24 ? "deskBuyOneDay" : "deskBuyDays", { count: hours / 24 }) : L("deskBuyHours", { count: hours });
}
const isPersonal = (plan) => plan.accessType === "personal_unlimited";
const isHome = (plan) => plan.accessType === "home_wisp_unlimited";

// The desktop layout applies when every bundle on sale is an Unlimited one.
export const unlimitedCatalogue = (plans) => plans.length > 0 && plans.every((plan) => isPersonal(plan) || isHome(plan));

// "Personal Unlimited · 7 days · 2 devices", "Home WISP Unlimited · 30 days".
export const planTitle = (plan) => [plan.name, validityLabel(plan), ...(isPersonal(plan) ? [devicesLabel(plan.deviceSlots)] : [])].join(" · ");

export function deskHeader() {
  const header = renderPortalHeader({ current: "internet", hrefs: HREFS, homeHref: "/dashboard#home", network: "unknown" });
  header.classList.add("buy-desk__header");
  return header;
}
export function setDeskNetwork(header, status) {
  const current = header?.querySelector("[data-network-status]");
  if (current) current.replaceWith(renderNetworkStatus(status === "unavailable" ? "unknown" : status));
}

// The Personal Unlimited table and the Home WISP card. `selectedId` is the
// bundle in "Your choice"; `disabled` when buying isn't possible right now.
export function deskCatalogue(plans, selectedId, disabled) {
  const personal = plans.filter(isPersonal), home = plans.filter(isHome);
  const rows = new Map();
  for (const plan of personal) {
    const key = `${plan.validityValue}:${plan.validityUnit}:${plan.validityHours}`;
    if (!rows.has(key)) rows.set(key, { hours: Number(plan.validityHours), sample: plan, cells: new Map() });
    if (!rows.get(key).cells.has(plan.deviceSlots)) rows.get(key).cells.set(plan.deviceSlots, plan);
  }
  const body = [...rows.values()].sort((a, b) => a.hours - b.hours).map((row) => {
    const label = validityLabel(row.sample);
    return `<tr><th scope="row" class="buy-desk__rowhead">${h(label)}</th>${DEVICES.map((n) => {
      const plan = row.cells.get(n);
      if (!plan) return `<td><button type="button" class="buy-desk__cell buy-desk__cell--none" disabled aria-label="${h(L("deskBuyCellNone", { validity: label, devices: devicesLabel(n) }))}">${h(L("deskBuyNotOffered"))}</button></td>`;
      return `<td><button type="button" class="buy-desk__cell" data-plan="${h(plan.id)}" aria-pressed="${plan.id === selectedId}"${disabled ? " disabled" : ""}
        aria-label="${h(L("deskBuyCell", { validity: label, devices: devicesLabel(n), price: xaf(plan.price) }))}">${h(xaf(plan.price))}</button></td>`;
    }).join("")}</tr>`;
  }).join("");
  const table = personal.length ? `<section class="buy-desk__panel" aria-labelledby="deskPersonal">
  <div><h2 class="buy-desk__h2" id="deskPersonal">${h(L("deskBuyPersonal"))}</h2><p class="buy-desk__sub">${h(L("deskBuyPersonalSub"))}</p></div>
  <table class="buy-desk__table"><caption class="visually-hidden">${h(L("deskBuyCaption"))}</caption>
    <thead><tr><th scope="col"><span class="visually-hidden">${h(L("deskBuyValidity"))}</span></th>${DEVICES.map((n) => `<th scope="col">${h(devicesLabel(n))}</th>`).join("")}</tr></thead>
    <tbody>${body}</tbody></table>
  <p class="buy-desk__note">${h(L("deskBuyNote"))}</p>
</section>` : "";
  const wisp = home.length ? `<section class="buy-desk__panel buy-desk__panel--wisp" aria-labelledby="deskHome">
  <h2 class="buy-desk__h2" id="deskHome">${h(L("deskBuyHome"))}</h2><p class="buy-desk__sub">${h(L("deskBuyHomeSub"))}</p>
  ${home.map((plan) => `<button type="button" class="buy-desk__wisp" data-plan="${h(plan.id)}" aria-pressed="${plan.id === selectedId}"${disabled ? " disabled" : ""}><span><strong>${h(validityLabel(plan))}</strong><span>${h(L("deskBuyHomeLine"))}</span></span><strong class="buy-desk__wisp-price">${h(xaf(plan.price))}</strong></button>`).join("")}
</section>` : "";
  return `<div class="buy-desk__catalogue">${table}${wisp}</div>`;
}

// "Your choice": the bundle chosen.
export const deskChoiceCard = (plan) => `<div class="buy-desk__choice"><strong>${h(planTitle(plan))}</strong><span>${h(L(isHome(plan) ? "deskBuyHomeLine" : "deskBuyPersonalLine"))}</span></div>`;

// The two networks, which set the form's network.
export const deskNetworks = (network) => `<div class="buy-desk__networks" role="radiogroup" aria-label="${h(L("deskBuyPayWith"))}">${Object.entries(WALLET_NAMES).map(([id, label]) =>
  `<button type="button" role="radio" class="buy-desk__network" data-desk-network="${id}" aria-checked="${network === id}">${h(label)}</button>`).join("")}</div>`;

// Bundle Price · Mobile Payment Fee (2%) · Total to Pay, from the server's
// quote for the chosen network. Without a verified fee: the price, and the fee
// shown in the operator prompt.
export function deskCost(plan, quote) {
  return `<div class="buy-desk__cost" id="deskCost">
  <div class="buy-desk__row"><span>${h(L("deskBuyPrice"))}</span><span>${h(xaf(plan.price))}</span></div>
  <div class="buy-desk__row"><span>${h(L(quote ? "deskBuyFee" : "deskBuyFeePlain"))}</span><span>${h(quote ? xaf(quote.fee) : L("deskBuyFeeInPrompt"))}</span></div>
  ${quote ? `<div class="buy-desk__row buy-desk__row--total"><strong>${h(L("deskBuyTotal"))}</strong><strong>${h(xaf(quote.total))}</strong></div>` : ""}
</div>`;
}
// The wallet notice above Pay Now, its amount in bold.
export function deskNotice(plan, network, quote) {
  const wallet = WALLET_NAMES[network];
  if (!wallet) return h(L("deskBuyChooseNetwork"));
  const amount = xaf(quote ? quote.total : plan.price);
  return h(L(quote ? "deskBuyNotice" : "deskBuyNoticeNoFee", { amount: "\u0000", wallet })).replace("\u0000", `<strong>${h(amount)}</strong>`);
}
