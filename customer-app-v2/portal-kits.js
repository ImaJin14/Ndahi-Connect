// Kits in the portal's Shop (#427), as drawn, with the owner's decisions of 27 Nov:
//   #kit/<id>                 the kit (PhoneStarterKit, #373): what's in it,
//                             Setup and How to pay, today's total and the next step
//   #kit/<id>/when, /where    booking the installation (PhoneInstallBooking, #374)
//   #kit/<id>/plan            Pay in 3's schedule (PhoneInstalments "choose", #375)
//   #kit/<id>/pay[/<order>]   the existing Checkout with the kit's parts, then
//                             waiting, and the screen for what was bought
//   #booking/<order>[/move]   Installation booked; Move or cancel reuses "When"
//   #plan/<order>[/pay/<id>]  the running plan (active), or fully paid
// Every amount comes from the server (/api/store/kits/quote, the order and its
// planQuotes); the screens never add prices up themselves.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { runButton } from "/shared/pending.js";
import { text, money, photo, METHOD_NAMES, shortName, maskedPhone, waitView, doneView, placedState, codeShown, place } from "./portal-shop.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const ZONE = "Africa/Douala", DAY = 864e5;
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB");
const svg = (d, size, width = 1.8, stroke = "currentColor") => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"><path d="${d}"></path></svg>`;
const BACK = "M15 18 9 12l6-6", CHECK = "m5 12 5 5 9-10";
const ICONS = { router: "M4 14h16v6H4ZM8 17h.01M12 14V9M8 9a6 6 0 0 1 8 0", bundle: "M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01", warranty: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" };
// "Sat 21 Nov" on the network's clock; a "YYYY-MM-DD" day is read at noon there.
const noon = (key) => new Date(key + "T11:00:00Z");
const dayName = (at) => new Date(at).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
const dayKey = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE });
const whenLine = (day, slot) => L("bookWhenLine", { day: dayName(noon(day)), slot: L("bookSlot_" + slot) });
// "28,000" without the currency, as the plan's list draws it.
const figure = (value) => Number(value || 0).toLocaleString(currentLanguage() === "fr" ? "fr-CM" : "en-CM");
const back = (href, label = L("kitBack")) => `<a class="portal-kit__back" href="${href}" aria-label="${h(label)}">${svg(BACK, 22, 2)}</a>`;
const bar = (href, title, extra = "") => `<div class="portal-kit__bar">${href ? back(href) : ""}<h2 class="portal-kit__bar-title" id="shopTitle" tabindex="-1">${h(title)}</h2>${extra}</div>`;
const option = (attrs, pressed, inner) => `<button type="button" class="portal-kit__opt" ${attrs} aria-pressed="${pressed}">${inner}</button>`;

let deps, flow = null, installs = null;
// The choices so far, kept for this tab so a reload keeps them.
const FLOW_KEY = "ndahi-kit-flow";
function loadFlow(kitId) {
  if (!flow) try { flow = JSON.parse(sessionStorage.getItem(FLOW_KEY) || "null"); } catch { flow = null; }
  if (!flow || flow.kitId !== kitId) flow = { kitId, setup: "self", pay: "full", day: "", slot: "", areaId: "", directions: "", phone: "", key: "" };
  return flow;
}
function saveFlow() { try { sessionStorage.setItem(FLOW_KEY, JSON.stringify(flow)); } catch { /* the choices stay for this page only */ } }

export function setupKits(options) { deps = options; }
const call = (path, input) => deps.call(path, input ? { method: "POST", body: JSON.stringify(input) } : undefined);
async function getJson(path) {
  const response = await fetch(deps.api + path, { credentials: "include", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(body.error || L("kitUnavailable"));
  return body;
}
const quote = (kitId, f, network) => getJson(`/api/store/kits/quote?kitId=${encodeURIComponent(kitId)}&setup=${f.setup}&pay=${f.pay}${f.areaId && f.setup === "install" ? "&areaId=" + encodeURIComponent(f.areaId) : ""}${network ? "&network=" + network : ""}`);
const installations = async (fresh) => (installs && !fresh ? installs : (installs = await getJson("/api/store/installations")));
const validity = (b) => {
  const days = b?.validityHours ? Math.round(b.validityHours / 24) : 0;
  return days >= 1 ? (days === 1 ? L("kitDay") : L("kitDays", { count: days })) : L("kitHours", { count: b?.validityHours || 0 });
};

// ---------- The kit (PhoneStarterKit) ----------
function kitView(data, kit, f, q, qPlan, installPrice) {
  const bundle = kit.firstBundle, monthly = bundle && Math.round((bundle.validityHours || 0) / 24) === 30;
  const product = (id) => (data.products || []).find((p) => p.id === id);
  const warranty = text(product(kit.items[0]?.productId)?.warranty) || text(data.settings && data.settings.warranty);
  const rows = [
    ...kit.items.map((item) => [ICONS.router, text(item.name) + (item.quantity > 1 ? ` × ${item.quantity}` : ""), kit.setUp ? L("kitLinked") : ""]),
    ...(bundle ? [[ICONS.bundle, L(monthly ? "kitFirstMonth" : "kitFirstBundle", { name: text(bundle.name) }), bundle.accessType === "home_wisp_unlimited"
      ? L("kitBundleHomeWisp", { length: validity(bundle) }) : L("kitBundlePersonal", { length: validity(bundle), devices: bundle.deviceSlots === 1 ? L("kitDevice") : L("kitDevices", { count: bundle.deviceSlots }) })]] : []),
    ...(warranty ? [[ICONS.warranty, warranty, L("kitWarrantyAuto")]] : []),
  ];
  const installOffered = q.installationOffered, planOffered = q.planOffered, planOk = q.planEligible !== false;
  const install = f.setup === "install", split = f.pay === "plan", price = q.installation?.price ?? installPrice;
  const setups = installOffered ? `<fieldset class="portal-kit__set"><legend>${h(L("kitSetup"))}</legend>
    ${option('data-kit-setup="self"', !install, `<span class="portal-kit__opt-main"><strong>${h(L("kitSelf"))}</strong><span>${h(L("kitSelfHint"))}</span></span><strong class="portal-kit__opt-price">${h(L("kitIncluded"))}</strong>`)}
    ${option('data-kit-setup="install"', install, `<span class="portal-kit__opt-main"><strong>${h(L("kitInstall"))}</strong><span>${h(L("kitInstallHint"))}</span></span><strong class="portal-kit__opt-price">${h(L("kitPlus", { amount: money(price) }))}</strong>`)}
  </fieldset>` : "";
  const rules = qPlan?.plan?.rules;
  const pays = planOffered ? `<fieldset class="portal-kit__set"><legend>${h(L("kitHowToPay"))}</legend><div class="portal-kit__pays">
    ${option('data-kit-pay="full"', !split, `<span><strong>${h(L("kitPayFull"))}</strong><span>${h(L("kitPayFullHint"))}</span></span>`)}
    ${option(`data-kit-pay="plan"${planOk ? "" : " disabled"}`, split, `<span><strong>${h(L("kitPayPlan"))}</strong><span>${h(planOk ? L("kitPayPlanHint", { pct: rules?.depositPct ?? 40, days: rules?.days ?? 30 }) : L("kitPlanUnavailable"))}</span></span>`)}
  </div></fieldset>` : "";
  // "[KIT PRICE] + [INSTALL]" as drawn: the area (and its travel fee) comes next.
  const base = split ? q.plan.payments[0].amount : q.kitPrice;
  const total = install ? L("kitSum", { a: figure(base), b: money(price) }) : money(base);
  const cta = install ? L("kitCtaInstall") : split ? L("kitCtaPlan") : L("kitCtaBuy");
  const next = install ? "when" : split ? "plan" : "pay";
  return `<div class="portal-kit portal-kit--page">${bar("/dashboard#shop", L("uiTabShop"))}
  <div class="portal-kit__main">
    <div class="portal-kit__hero"><p class="portal-kit__eyebrow">${h(L("kitEyebrow"))}</p><h1 class="portal-kit__title">${h(text(kit.name))}</h1></div>
    <div class="portal-kit__body">
      <section class="portal-kit__inside" aria-label="${h(L("kitInside"))}">${rows.map(([icon, title, line]) => `<div class="portal-kit__inc"><span class="portal-kit__ico">${svg(icon, 18)}</span><span class="portal-kit__inc-text"><strong>${h(title)}</strong>${line ? `<br><span>${h(line)}</span>` : ""}</span></div>`).join("")}</section>
      ${setups}${pays}
    </div>
  </div>
  <div class="portal-kit__foot portal-kit__foot--total">
    <div class="portal-kit__total"><span>${h(L(split ? "kitTotalDeposit" : "kitTotalFull"))}</span><strong>${h(total)}</strong></div>
    ${kit.saving ? `<p class="portal-kit__save">${h(L("kitSave", { amount: money(kit.saving) }))}</p>` : ""}
    <a class="portal-kit__btn" href="/dashboard#kit/${encodeURIComponent(kit.id)}/${next}">${h(cta)}</a>
  </div></div>`;
}

// ---------- Booking (PhoneInstallBooking) ----------
function whenView(days, f, { backHref, step, button, extra = "" }) {
  const slots = (d) => (d ? d.slots : { morning: { left: 0 }, afternoon: { left: 0 } });
  const chosen = days.find((d) => d.day === f.day);
  return `${bar(backHref, L("bookTitle"), `<span class="portal-kit__step">${h(step)}</span>`)}
  <div class="portal-kit__main portal-kit__main--pad">
    <h1 class="portal-kit__h1">${h(L("bookWhen"))}</h1>
    <p class="portal-kit__lede">${h(L("bookWhenBody"))}</p>
    <div class="portal-kit__days" role="group" aria-label="${h(L("bookDay"))}">${days.map((d) => {
      const full = d.note === "full", at = noon(d.day);
      return `<button type="button" class="portal-kit__day${full ? " portal-kit__day--full" : ""}" data-book-day="${d.day}" aria-pressed="${d.day === f.day}" ${full ? "disabled" : ""}><span class="portal-kit__dow">${h(at.toLocaleDateString(locale(), { weekday: "short", timeZone: ZONE }))}</span><strong>${h(at.toLocaleDateString(locale(), { day: "numeric", timeZone: ZONE }))}</strong><span class="portal-kit__note">${d.note ? h(L(d.note === "full" ? "bookFull" : "bookBusy")) : " "}</span></button>`;
    }).join("")}</div>
    <div class="portal-kit__slots" role="group" aria-label="${h(L("bookTime"))}">${["morning", "afternoon"].map((slot) => {
      const left = slots(chosen)[slot].left;
      return `<button type="button" class="portal-kit__slot" data-book-slot="${slot}" aria-pressed="${f.slot === slot}" ${chosen && left < 1 ? "disabled" : ""}><span><strong>${h(L(slot === "morning" ? "bookSlotMorning" : "bookSlotAfternoon"))}</strong><span>${h(!chosen ? " " : left < 1 ? L("bookLeftNone") : left === 1 ? L("bookLeftOne") : L("bookLeft", { count: left }))}</span></span></button>`;
    }).join("")}</div>
  </div>
  <div class="portal-kit__foot"><button type="button" class="portal-kit__btn" data-book-next>${h(button)}</button>${extra}<div class="portal-kit__message" id="kitMessage" role="alert"></div></div>`;
}
function whereView(kit, f, settings, who) {
  const area = settings.areas.find((a) => a.id === f.areaId) || settings.areas[0];
  f.areaId = area?.id || "";
  if (!f.phone) f.phone = who.phone || "";
  return `${bar(`/dashboard#kit/${encodeURIComponent(kit.id)}/when`, L("bookTitle"), `<span class="portal-kit__step">${h(L("bookStep", { n: 2 }))}</span>`)}
  <form class="portal-kit__form" id="kitWhere" novalidate>
  <div class="portal-kit__main portal-kit__main--pad portal-kit__main--where">
    <h1 class="portal-kit__h1">${h(L("bookWhere"))}</h1>
    <div><label class="portal-kit__lbl" for="kitArea">${h(L("bookArea"))}</label><select class="portal-kit__in" id="kitArea" name="area">${settings.areas.map((a) => `<option value="${h(a.id)}" ${a.id === f.areaId ? "selected" : ""}>${h(a.town ? L("bookAreaOption", { name: a.name, town: a.town }) : a.name)}</option>`).join("")}</select><p class="portal-kit__hint" id="kitTravel">${h(L("bookTravel", { amount: money(area?.travelFee ?? 0) }))}</p></div>
    <div><label class="portal-kit__lbl" for="kitDirections">${h(L("bookDirections"))}</label><textarea class="portal-kit__in portal-kit__area" id="kitDirections" name="directions" maxlength="300">${h(f.directions)}</textarea></div>
    <div><label class="portal-kit__lbl" for="kitPhone">${h(L("bookPhone"))}</label><span class="portal-shop__payer portal-kit__payer"><input class="portal-kit__in" id="kitPhone" name="phone" type="tel" inputmode="tel" autocomplete="tel" value="${h(f.phone)}"><span class="portal-shop__mask" id="kitPhoneMask" aria-hidden="true"></span></span></div>
    <section class="portal-kit__summary" aria-label="${h(L("bookSummary"))}">
      <div class="portal-kit__row"><span>${h(L("bookRowWhen"))}</span><strong>${h(whenLine(f.day, f.slot))}</strong></div>
      <div class="portal-kit__row"><span>${h(L("bookRowInstall"))}</span><strong>${h(money(settings.price))}</strong></div>
      <div class="portal-kit__row"><span>${h(L("bookRowTravel"))}</span><strong id="kitTravelRow">${h(money(area?.travelFee ?? 0))}</strong></div>
    </section>
  </div>
  <div class="portal-kit__foot"><button type="submit" class="portal-kit__btn">${h(L("bookPay"))}</button><p class="portal-kit__fine">${h(L("bookFree"))}</p><div class="portal-kit__message" id="kitMessage" role="alert"></div></div>
  </form>`;
}
function bookedView(o) {
  const b = o.installation, status = ["booked", "moved"].includes(b.status) ? "" : L("bookStatus_" + b.status);
  return `${bar("", L("bookTitle"), `<span class="portal-kit__step">${h(L("bookBooked"))}</span>`)}
  <div class="portal-kit__main portal-kit__main--done">
    <div class="portal-kit__done-head"><span class="portal-kit__done-icon">${svg(CHECK, 26, 2.4, "#345000")}</span><h1 class="portal-kit__h1">${h(L("bookDoneTitle"))}</h1></div>
    <section class="portal-kit__card"><p class="portal-kit__eyebrow">${h(L("bookRef", { reference: b.reference }))}</p><p class="portal-kit__card-big">${h(whenLine(b.day, b.slot))}</p><p class="portal-kit__card-line">${h(L("bookCalls", { area: b.area?.name || "" }))}</p></section>
    ${status ? `<p class="portal-kit__notice" role="status">${h(status)}</p>` : ""}
    <p class="portal-kit__tip">${h(L("bookNote"))}</p>
  </div>
  <div class="portal-kit__foot">${b.canChange ? `<a class="portal-kit__btn2" href="/dashboard#booking/${encodeURIComponent(o.id)}/move">${h(L("bookMoveOrCancel"))}</a>` : ""}<a class="portal-kit__btn" href="/dashboard#home">${h(L("bookDone"))}</a></div>`;
}

// ---------- Pay in 3 (PhoneInstalments) ----------
// "about [FEE] each": the deposit's own fee; the button shows today's, with
// any installation and travel.
function chooseView(kit, f, q, backHref, depositFee) {
  const plan = q.plan, rules = plan.rules, fee = q.paymentQuotes?.mtn?.fee, install = f.setup === "install", each = install ? depositFee : fee;
  return `${bar(backHref, L("planTitleChoose"))}
  <div class="portal-kit__main portal-kit__main--pad">
    <h1 class="portal-kit__h1">${h(L("planHeading", { name: text(kit.name) }))}</h1>
    <p class="portal-kit__intro">${h(L("planIntro", { days: rules.days }))}</p>
    <section class="portal-kit__plan" aria-label="${h(L("planSchedule"))}"><ol class="portal-kit__sch">${plan.payments.map((p, i) => i === 0
      ? `<li><span class="portal-kit__n portal-kit__n--now">1</span><span class="portal-kit__sch-text"><strong>${h(L("planTodayDeposit", { pct: rules.depositPct }))}</strong></span><strong>${h(money(p.amount))}</strong></li>`
      : `<li><span class="portal-kit__n">${i + 1}</span><span class="portal-kit__sch-text">${h(L("planBy", { day: dayName(p.dueAt) }))}</span><span>${h(money(p.amount))}</span></li>`).join("")}</ol></section>
    <p class="portal-kit__fee">${h(Number.isFinite(each) ? L("planFeeNote", { fee: money(each) }) : L("planFeeNoteNoFee"))}</p>
    <details class="portal-kit__faq"><summary>${h(L("planIfNot"))}</summary><p>${h(L("planIfNotBody", { grace: rules.grace }))}</p></details>
  </div>
  <div class="portal-kit__foot"><a class="portal-kit__btn portal-kit__btn--two" href="/dashboard#kit/${encodeURIComponent(kit.id)}/pay">${h(install ? L("planPayDepositInstall", { amount: money(q.today) }) : L("planPayDeposit", { amount: money(q.today) }))}${Number.isFinite(fee) ? `<span>${h(L("planFeeLine", { fee: money(fee) }))}</span>` : ""}</a></div>`;
}
const unpaid = (plan) => plan.payments.filter((p) => !p.paidAt);
function dueLine(p, now, late) {
  if (late) return L("planLate", { day: dayName(p.deadline || p.dueAt) });
  const days = Math.round((Date.parse(dayKey(p.dueAt) + "T12:00:00Z") - Date.parse(dayKey(now) + "T12:00:00Z")) / DAY);
  return days <= 0 ? L("planDueToday") : days === 1 ? L("planDueTomorrow", { day: dayName(p.dueAt) }) : L("planDueIn", { day: dayName(p.dueAt), count: days });
}
function activeView(o, quotes) {
  const plan = o.plan, now = Date.now(), left = unpaid(plan), next = left[0], paid = plan.payments.filter((p) => p.paidAt).reduce((sum, p) => sum + p.amount, 0);
  const percent = plan.price ? Math.round((paid / plan.price) * 100) : 0, name = text(o.kit?.name || o.product?.name);
  const rows = plan.payments.map((p, i) => {
    const done = Boolean(p.paidAt), isNext = next && p.n === next.n;
    const label = i === 0 ? L("planDepositPaid", { day: new Date(p.paidAt || o.createdAt).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE }) })
      : done ? (dayKey(p.paidAt) === dayKey(now) ? L("planPaidToday") : L("planPaidOn", { day: dayName(p.paidAt) })) : isNext ? dueLine(p, now, plan.late) : L("planDue", { day: dayName(p.dueAt) });
    const mark = done ? "portal-kit__n--paid" : isNext ? "portal-kit__n--next" : "";
    return `<li><span class="portal-kit__n ${mark}">${done ? "✓" : p.n}</span><span class="portal-kit__sch-text">${h(label)}</span><span>${h(figure(p.amount))}</span></li>`;
  }).join("");
  const last = plan.payments.at(-1), lastOne = left.length === 1, fee = quotes?.next?.fee;
  return `${bar("/dashboard#activity", L("planTitleActive"))}
  <div class="portal-kit__main portal-kit__main--pad">
    <section class="portal-kit__progress" aria-label="${h(L("planProgress"))}"><p class="portal-kit__eyebrow">${h(L("planReserved", { name }))}</p><p class="portal-kit__paid">${h(money(paid))}</p><p class="portal-kit__of">${h(L("planOfPaid", { amount: money(plan.price) }))}</p><div class="portal-kit__track"><div class="portal-kit__fill" data-width="${percent}"></div></div></section>
    <section class="portal-kit__plan" aria-label="${h(L("planPayments"))}"><ol class="portal-kit__sch">${rows}</ol></section>
    <p class="portal-kit__held">${h(L("planHeld", { day: dayName(Date.parse(last.dueAt) + (plan.extension ? plan.extension.days * DAY : 0)) }))}</p>
  </div>
  <div class="portal-kit__foot">${next ? `<button type="button" class="portal-kit__btn portal-kit__btn--two" data-plan-pay="next" data-amount="${next.amount}">${h(lastOne ? L("planPayLast", { amount: money(next.amount) }) : L("planPayNext", { amount: money(next.amount) }))}${Number.isFinite(fee) ? `<span>${h(L("planFeeLine", { fee: money(fee) }))}</span>` : ""}</button>
    <button type="button" class="portal-kit__btn2" data-plan-pay="rest" data-amount="${left.reduce((sum, p) => sum + p.amount, 0)}">${h(L("planPayAll"))}</button>` : ""}<div class="portal-kit__message" id="kitMessage" role="alert"></div></div>`;
}
function paidView(o) {
  const name = text(o.kit?.name || o.product?.name), pickup = place(o.pickup), b = o.installation;
  const line = b && ["booked", "moved", "on_the_way"].includes(b.status) ? L("planDoneInstall", { name, when: whenLine(b.day, b.slot) })
    : o.kit?.setUp ? L("planDoneSetUp", { name, place: pickup }) : L("planDoneCollect", { name, place: pickup });
  return `${bar("/dashboard#activity", L("planTitleDone"))}
  <div class="portal-kit__main portal-kit__main--center">
    <div class="portal-kit__big-icon">${svg(CHECK, 40, 2.2, "#345000")}</div>
    <h1 class="portal-kit__h1">${h(L("planDoneTitle"))}</h1>
    <p class="portal-kit__center-text">${h(line)}</p>
    ${o.collectionCode ? `<p class="portal-kit__code">${h(codeShown(o.collectionCode))}</p>` : ""}
  </div>
  <div class="portal-kit__foot"><a class="portal-kit__btn" href="/dashboard#order/${encodeURIComponent(o.id)}">${h(L("planViewOrder"))}</a></div>`;
}

// ---------- The kit's checkout (PhoneCheckout with the kit's parts) ----------
function checkoutView(data, kit, f, q, who) {
  const install = f.setup === "install", plan = f.pay === "plan", pickup = text(data.settings && data.settings.pickup);
  const parts = [[plan ? L("kitPart_deposit", { pct: q.plan.rules.depositPct }) : L("kitPart_kit"), plan ? q.plan.payments[0].amount : q.kitPrice],
    ...(install ? [[L("kitPart_installation"), q.installation.price], [L("kitPart_travel"), q.installation.travelFee]] : [])];
  const backHref = `/dashboard#kit/${encodeURIComponent(kit.id)}${plan ? "/plan" : install ? "/where" : ""}`;
  const where = install ? (installs?.areas || []).find((a) => a.id === f.areaId) : null;
  const item = { images: kit.items[0]?.image ? [kit.items[0].image] : [] };
  return `<div class="portal-shop__bar">${back(backHref)}<h2 class="portal-shop__bar-title" id="shopTitle" tabindex="-1">${h(L("shopCheckout"))}</h2></div>
  <form class="portal-shop__checkout" id="shopCheckout" novalidate>
    <div class="portal-shop__checkout-main">
    <div class="portal-shop__line">${photo(item, "portal-shop__thumb")}<span><strong>${h(text(kit.name))}</strong><span class="nd-meta">${h(L(plan ? "kitLinePlan" : "kitLineFull"))}</span></span><strong>${h(figure(q.today))}</strong></div>
    <section aria-labelledby="shopContact"><div class="portal-shop__section-head"><h3 id="shopContact">${h(L("shopYourDetails"))}</h3><span class="nd-pill nd-pill--success portal-shop__from">${h(L("shopFromAccount"))}</span></div><p>${h([shortName(who.name), maskedPhone(who.phone)].filter(Boolean).join(" · "))}</p></section>
    ${install ? `<section aria-labelledby="shopPickup"><h3 id="shopPickup">${h(L("bookRowInstall"))}</h3><p><strong>${h(whenLine(f.day, f.slot))}</strong><span class="nd-meta">${h(where ? where.name : "")}</span></p></section>`
      : pickup ? `<section aria-labelledby="shopPickup"><h3 id="shopPickup">${h(L("shopCollection"))}</h3><p><strong>${h(pickup)}</strong><span class="nd-meta">${h(L("shopCodeNote"))}</span></p></section>` : ""}
    <fieldset class="portal-shop__pay"><legend>${h(L("shopPayWith"))}</legend><div class="portal-shop__methods">${["mtn", "orange"].map((value, i) => `<label class="portal-shop__method"><input type="radio" name="network" value="${value}" ${i === 0 ? "checked" : ""}><span>${METHOD_NAMES[value]}</span></label>`).join("")}</div>
      <label class="portal-shop__field">${h(L("shopPayNumber"))}<span class="portal-shop__payer"><input name="payerPhone" type="tel" inputmode="tel" autocomplete="tel" value="${h(who.phone || "")}" required><span class="portal-shop__mask" id="shopPayerMask" aria-hidden="true"></span></span></label></fieldset>
    </div>
    <div class="portal-shop__foot">${costView(parts, q, "mtn")}
    <button type="submit" class="nd-btn nd-btn--block">${h(L("deskBuyPayNow"))}</button>
    <p class="nd-meta portal-shop__fine">${h(L("shopApproveNote"))}</p>
    <div id="shopCheckoutMessage" role="alert"></div>
    </div>
  </form>`;
}
function costView(parts, q, network) {
  const fq = q.paymentQuotes?.[network], quoted = fq && Number.isFinite(fq.total);
  const notice = h(L(quoted ? "deskBuyNotice" : "deskBuyNoticeNoFee", { amount: "\u0000", wallet: METHOD_NAMES[network] })).replace("\u0000", `<strong>${h(money(quoted ? fq.total : q.today))}</strong>`);
  return `<div class="portal-shop__cost" id="shopCost">
    ${parts.map(([label, value]) => `<div class="portal-shop__cost-row"><span>${h(label)}</span><span>${h(money(value))}</span></div>`).join("")}
    <div class="portal-shop__cost-row"><span>${h(L(quoted ? "deskBuyFee" : "deskBuyFeePlain"))}</span><span>${h(quoted ? money(fq.fee) : L("deskBuyFeeInPrompt"))}</span></div>
    ${quoted ? `<div class="portal-shop__total"><span>${h(L("deskBuyTotal"))}</span><strong>${h(money(fq.total))}</strong></div>` : ""}
    <p class="portal-shop__balance" role="note">${notice}</p>
  </div>`;
}

// ---------- Routing ----------
const panel = () => deps.panel;
function show(html, sub) {
  panel().innerHTML = sub === "pay" ? html : `<div class="portal-kit-screen portal-kit-screen--${sub}">${html}</div>`;
  // The kit's payment step is the drawn Checkout: it takes Checkout's page
  // layout (portal-pages.css keys it on this attribute; the next address resets it).
  if (sub === "pay") document.body.setAttribute("data-portal-sub", "checkout");
}
const focusTitle = () => document.getElementById("shopTitle")?.focus({ preventScroll: true });
export async function renderKits(route, [id, step, extra]) {
  try {
    if (route === "kit") await kitRoute(id, step || "", extra);
    else if (route === "booking") await bookingRoute(id, step);
    else if (route === "plan") await planRoute(id, step, extra);
  } catch (error) {
    panel().innerHTML = `<div class="portal-kit-screen">${bar("/dashboard#shop", L("uiTabShop"))}<p class="error portal-kit__error" role="alert">${h(error.message)}</p></div>`;
  }
  focusTitle();
}

async function kitRoute(kitId, step, orderId) {
  const data = await deps.load();
  const kit = (data?.kits || []).find((k) => k.id === kitId);
  if (!kit) throw Error(L("kitUnavailable"));
  const f = loadFlow(kitId);
  if (step === "pay" && orderId) return placed(kit, orderId);
  if (step === "") {
    // Both quotes: today's choices, and Pay in 3's rules for its hint.
    const [q, qPlan, settings] = await Promise.all([quote(kitId, f), f.pay === "plan" ? null : quote(kitId, { ...f, pay: "plan" }).catch(() => null), kit.installation ? installations(true).catch(() => null) : null]);
    if (!q.installationOffered && f.setup === "install") f.setup = "self";
    if ((!q.planOffered || q.planEligible === false) && f.pay === "plan") f.pay = "full";
    saveFlow();
    show(kitView(data, kit, f, q, f.pay === "plan" ? q : qPlan, settings?.price), "kit");
    panel().querySelectorAll("[data-kit-setup]").forEach((b) => (b.onclick = () => { f.setup = b.dataset.kitSetup; saveFlow(); void renderKits("kit", [kitId]); }));
    panel().querySelectorAll("[data-kit-pay]").forEach((b) => (b.onclick = () => { f.pay = b.dataset.kitPay; saveFlow(); void renderKits("kit", [kitId]); }));
    return;
  }
  if (step === "when") {
    const settings = await installations(true);
    if (!settings.open) throw Error(L("bookClosed"));
    if (!settings.days.some((d) => d.day === f.day && d.note !== "full")) { f.day = settings.days.find((d) => d.note !== "full")?.day || ""; f.slot = ""; }
    const pick = () => {
      const d = settings.days.find((x) => x.day === f.day);
      if (d && f.slot && d.slots[f.slot].left < 1) f.slot = "";
      if (d && !f.slot) f.slot = d.slots.morning.left > 0 ? "morning" : d.slots.afternoon.left > 0 ? "afternoon" : "";
      saveFlow();
      show(whenView(settings.days, f, { backHref: `/dashboard#kit/${encodeURIComponent(kitId)}`, step: L("bookStep", { n: 1 }), button: f.day && f.slot ? L("bookContinue", { when: whenLine(f.day, f.slot) }) : L("bookPickDay") }), "when");
      wireWhen(settings, pick, () => { location.hash = `#kit/${encodeURIComponent(kitId)}/where`; });
    };
    return pick();
  }
  if (step === "where") {
    const settings = await installations();
    if (!f.day || !f.slot) { location.replace(`#kit/${encodeURIComponent(kitId)}/when`); return; }
    const who = (await deps.context()).customer || {};
    show(whereView(kit, f, settings, who), "where");
    const form = document.getElementById("kitWhere"), message = document.getElementById("kitMessage");
    const phone = form.elements.phone, mask = document.getElementById("kitPhoneMask");
    const showMask = () => { const masked = document.activeElement === phone ? "" : maskedPhone(phone.value, false); mask.textContent = masked; phone.classList.toggle("portal-shop__payer--masked", Boolean(masked) && masked !== phone.value); };
    for (const type of ["focus", "blur", "input", "change"]) phone.addEventListener(type, showMask);
    showMask();
    form.elements.area.onchange = () => {
      f.areaId = form.elements.area.value; saveFlow();
      const fee = money(settings.areas.find((a) => a.id === f.areaId)?.travelFee ?? 0);
      document.getElementById("kitTravel").textContent = L("bookTravel", { amount: fee });
      document.getElementById("kitTravelRow").textContent = fee;
    };
    form.elements.directions.oninput = () => { f.directions = form.elements.directions.value; saveFlow(); };
    phone.addEventListener("input", () => { f.phone = phone.value; saveFlow(); });
    form.onsubmit = (event) => {
      event.preventDefault();
      f.directions = form.elements.directions.value.trim(); f.phone = phone.value.trim(); saveFlow();
      if (!f.directions) { message.textContent = L("bookNeedDirections"); form.elements.directions.focus(); return; }
      if (!f.phone) { message.textContent = L("bookNeedPhone"); phone.focus(); return; }
      location.hash = `#kit/${encodeURIComponent(kitId)}/${f.pay === "plan" ? "plan" : "pay"}`;
    };
    return;
  }
  if (step === "plan") {
    if (f.setup === "install") await installations();
    f.pay = "plan"; saveFlow();
    const [q, deposit] = await Promise.all([quote(kitId, f), f.setup === "install" ? quote(kitId, { ...f, setup: "self" }).catch(() => null) : null]);
    show(chooseView(kit, f, q, `/dashboard#kit/${encodeURIComponent(kitId)}${f.setup === "install" ? "/where" : ""}`, deposit?.paymentQuotes?.mtn?.fee), "plan");
    return;
  }
  if (step === "pay") {
    if (f.setup === "install" && (!f.day || !f.slot || !f.areaId)) { location.replace(`#kit/${encodeURIComponent(kitId)}/when`); return; }
    if (f.setup === "install") await installations();
    const [q, ctx] = await Promise.all([quote(kitId, f), deps.context()]), who = ctx.customer || {};
    if (!f.key) { f.key = crypto.randomUUID(); saveFlow(); }
    show(checkoutView(data, kit, f, q, who), "pay");
    wireCheckout(kit, f, q, who);
    return;
  }
  location.replace(`#kit/${encodeURIComponent(kitId)}`);
}
function wireWhen(settings, redraw, next) {
  panel().querySelectorAll("[data-book-day]").forEach((b) => (b.onclick = () => { flow.day = b.dataset.bookDay; redraw(); panel().querySelector(`[data-book-day="${flow.day}"]`)?.focus(); }));
  panel().querySelectorAll("[data-book-slot]").forEach((b) => (b.onclick = () => { flow.slot = b.dataset.bookSlot; redraw(); panel().querySelector(`[data-book-slot="${flow.slot}"]`)?.focus(); }));
  panel().querySelector("[data-book-next]").onclick = () => {
    if (!flow.day || !flow.slot) { document.getElementById("kitMessage").textContent = L("bookPickDay"); return; }
    next();
  };
}
function wireCheckout(kit, f, q, who) {
  const form = document.getElementById("shopCheckout"), message = document.getElementById("shopCheckoutMessage");
  const payer = form.elements.payerPhone, mask = document.getElementById("shopPayerMask");
  const showMask = () => { const masked = document.activeElement === payer ? "" : maskedPhone(payer.value, false); mask.textContent = masked; payer.classList.toggle("portal-shop__payer--masked", Boolean(masked) && masked !== payer.value); };
  for (const type of ["focus", "blur", "input", "change"]) payer.addEventListener(type, showMask);
  showMask();
  const breakdown = [[f.pay === "plan" ? L("kitPart_deposit", { pct: q.plan.rules.depositPct }) : L("kitPart_kit"), f.pay === "plan" ? q.plan.payments[0].amount : q.kitPrice],
    ...(f.setup === "install" ? [[L("kitPart_installation"), q.installation.price], [L("kitPart_travel"), q.installation.travelFee]] : [])];
  form.querySelectorAll('input[name="network"]').forEach((radio) => { radio.onchange = () => { document.getElementById("shopCost").outerHTML = costView(breakdown, q, form.elements.network.value); }; });
  form.onsubmit = async (event) => {
    event.preventDefault();
    message.textContent = "";
    const network = form.elements.network.value, payerPhone = payer.value.trim();
    if (!payerPhone) { message.textContent = L("shopNeedNumber"); payer.focus(); return; }
    try {
      await runButton(form.querySelector('[type="submit"]'), L("shopSending"), async () => {
        const result = await deps.post("/api/account/store/checkout", {
          checkoutKey: f.key, kitId: kit.id, expectedPrice: kit.price, expectedAmount: q.today, setup: f.setup, pay: f.pay,
          ...(f.setup === "install" ? { installation: { day: f.day, slot: f.slot, areaId: f.areaId, directions: f.directions, phone: f.phone } } : {}),
          name: who.name || "", phone: who.phone || "", email: who.email || "", payerPhone, network });
        f.key = ""; saveFlow(); deps.resetContext(); deps.load(true);
        location.replace(`#kit/${encodeURIComponent(kit.id)}/pay/${encodeURIComponent(result.order.id)}`);
      }, { controls: Array.from(form.elements) });
    } catch (error) {
      if (error.notCreated) { f.key = crypto.randomUUID(); saveFlow(); }
      message.textContent = error.status === 409 && /changed/i.test(error.message) ? L("kitChanged") : error.message;
    }
  };
}
// After paying: the drawn waiting screen, then what was bought: the booking,
// the plan, or the existing "Order placed".
async function placed(kit, orderId) {
  const { order } = await call("/api/account/store/order", { orderId });
  const state = placedState(order);
  if (state === "order") { location.replace(`#order/${encodeURIComponent(order.id)}`); return; }
  if (state === "done") {
    flow = null; try { sessionStorage.removeItem(FLOW_KEY); } catch { /* nothing kept */ }
    if (order.installation) { location.replace(`#booking/${encodeURIComponent(order.id)}`); return; }
    if (order.plan) { location.replace(`#plan/${encodeURIComponent(order.id)}`); return; }
    show(doneView(order), "pay");
    return;
  }
  show(waitView(order), "pay");
  waitActions(order, () => placed(kit, orderId), () => { location.replace(`#kit/${encodeURIComponent(kit.id)}/pay`); });
}
function waitActions(order, again, changed) {
  const message = document.getElementById("shopCheckoutMessage"), check = panel().querySelector("[data-shop-check]"), change = panel().querySelector("[data-shop-change]");
  const controls = [check, change];
  check.onclick = () => runButton(check, L("shopChecking"), async () => {
    try {
      const { order: now } = await call("/api/account/store/verify", { orderId: order.id });
      if (placedState(now) === "wait") message.textContent = L("shopStillWaiting");
      else await again();
    } catch (error) { message.textContent = error.message; }
  }, { controls });
  change.onclick = () => runButton(change, L("shopChanging"), async () => {
    try {
      const { order: now } = await deps.post("/api/account/store/cancel", { orderId: order.id });
      if (placedState(now) === "done") { await again(); return; }
      deps.resetContext(); deps.load(true);
      changed();
    } catch (error) { message.textContent = error.message; }
  }, { controls });
}

async function bookingRoute(orderId, step) {
  const { order } = await call("/api/account/store/order", { orderId });
  if (!order.installation) { location.replace(`#order/${encodeURIComponent(orderId)}`); return; }
  if (step !== "move") { show(bookedView(order), "booked"); return; }
  const b = order.installation;
  if (!b.canChange) { show(bookedView(order), "booked"); document.querySelector(".portal-kit__main")?.insertAdjacentHTML("beforeend", `<p class="portal-kit__notice" role="alert">${h(L("bookTooLate"))}</p>`); return; }
  const settings = await installations(true), choice = { day: b.day, slot: b.slot };
  const redraw = () => {
    flow = { ...(flow || {}), day: choice.day, slot: choice.slot };
    const d = settings.days.find((x) => x.day === choice.day);
    if (d && choice.slot && d.slots[choice.slot].left < 1 && !(choice.day === b.day && choice.slot === b.slot)) choice.slot = "";
    const same = choice.day === b.day && choice.slot === b.slot;
    show(whenView(settings.days, choice, { backHref: `/dashboard#booking/${encodeURIComponent(orderId)}`, step: "", button: choice.slot && !same ? L("bookMoveTo", { when: whenLine(choice.day, choice.slot) }) : L("bookPickDay"),
      extra: `<button type="button" class="portal-kit__link" data-book-cancel>${h(L("bookCancel"))}</button>` }), "when");
    panel().querySelectorAll("[data-book-day]").forEach((x) => (x.onclick = () => { choice.day = x.dataset.bookDay; choice.slot = ""; const day = settings.days.find((y) => y.day === choice.day); choice.slot = day?.slots.morning.left > 0 ? "morning" : day?.slots.afternoon.left > 0 ? "afternoon" : ""; redraw(); }));
    panel().querySelectorAll("[data-book-slot]").forEach((x) => (x.onclick = () => { choice.slot = x.dataset.bookSlot; redraw(); }));
    const message = document.getElementById("kitMessage"), next = panel().querySelector("[data-book-next]");
    next.onclick = () => {
      if (!choice.slot || same) { message.textContent = L("bookPickDay"); return; }
      runButton(next, L("planPaying"), async () => {
        try {
          await deps.post("/api/account/store/installation", { orderId, action: "move", day: choice.day, slot: choice.slot });
          location.replace(`#booking/${encodeURIComponent(orderId)}`);
        } catch (error) { message.textContent = error.message; }
      });
    };
    panel().querySelector("[data-book-cancel]").onclick = (event) => {
      if (!confirm(L("bookCancelConfirm", { amount: money(b.price + b.travelFee) }))) return;
      runButton(event.currentTarget, L("planPaying"), async () => {
        try {
          await deps.post("/api/account/store/installation", { orderId, action: "cancel" });
          deps.resetContext();
          location.replace(`#order/${encodeURIComponent(orderId)}`);
        } catch (error) { message.textContent = error.message; }
      });
    };
  };
  redraw();
}

async function planRoute(orderId, step, childId) {
  const result = await call("/api/account/store/order", { orderId }), order = result.order;
  if (!order.plan) { location.replace(`#order/${encodeURIComponent(orderId)}`); return; }
  if (step === "pay" && childId) {
    const { order: child } = await call("/api/account/store/order", { orderId: childId });
    const state = placedState(child);
    if (state === "wait") {
      show(waitView(child), "pay");
      waitActions(child, () => planRoute(orderId, step, childId), () => { location.replace(`#plan/${encodeURIComponent(orderId)}`); });
      return;
    }
    location.replace(`#plan/${encodeURIComponent(orderId)}`);
    return;
  }
  if (order.plan.status === "completed") { show(paidView(order), "paid"); return; }
  if (order.plan.status !== "running") {
    show(`${bar("/dashboard#activity", L("planTitleActive"))}<div class="portal-kit__main portal-kit__main--pad"><p class="portal-kit__notice" role="status">${h(order.plan.status === "cancelled" ? L("planCancelled") : L("shopWaitingTitle"))}</p></div>`, "plan");
    return;
  }
  show(activeView(order, result.planQuotes), "plan");
  const fill = panel().querySelector(".portal-kit__fill");
  if (fill) fill.style.width = fill.dataset.width + "%";
  panel().querySelectorAll("[data-plan-pay]").forEach((button) => (button.onclick = () => {
    const message = document.getElementById("kitMessage");
    // Charged to the deposit's number and network, straight from the button (owner, 27 Nov).
    runButton(button, L("planPaying"), async () => {
      try {
        const made = await deps.post("/api/account/store/plan/pay", { orderId, which: button.dataset.planPay, expectedAmount: Number(button.dataset.amount), checkoutKey: crypto.randomUUID() });
        location.replace(`#plan/${encodeURIComponent(orderId)}/pay/${encodeURIComponent(made.order.id)}`);
      } catch (error) { message.textContent = error.message; }
    }, { controls: [...panel().querySelectorAll("[data-plan-pay]")] });
  }));
}
