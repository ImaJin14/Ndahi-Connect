// Redesigned Internet tab (canvas: PhoneInternet, DesktopInternet): the
// Bundles | Vouchers switch, the active bundle card with what can be bought
// next, and earlier bundles. The voucher code form and voucher history keep
// their v1 modules (restyled in portal-internet.css).
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { formatDataBalance } from "/shared/data-usage.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB");
const day = (value) => {
  const at = Date.parse(value);
  return Number.isFinite(at) ? new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: "Africa/Douala" }) : "";
};
const left = (v) => (v.remainingBytes !== undefined ? v.remainingBytes : v.quotaBytes == null ? null : Math.max(0, v.quotaBytes - (v.usedBytes || 0)));

// Phones show one group at a time; the address decides which (#bundles or #vouchers).
export function internetSwitch() {
  return `<nav class="nd-segmented portal-internet__switch full" data-portal-view="bundles" aria-label="${h(L("portalTitleInternet"))}"><a class="nd-segmented__option" href="/dashboard#bundles" data-internet-switch="bundles">${h(L("portalInternetBundles"))}</a><a class="nd-segmented__option" href="/dashboard#vouchers" data-internet-switch="vouchers">${h(L("portalInternetVouchers"))}</a></nav>`;
}

// The plan card (canvas): phones show "Active · plan", when it ends, data left
// and a meter, with the buy-next note below it; from 768px the card titles the
// plan and holds the note. The bundle's facts are in its history row.
export function internetBundle({ result, active, current, canPurchase }) {
  const plan = current && current.plan;
  const remaining = active ? left(active) : null, quota = active ? active.quotaBytes : null;
  const percent = active && quota ? Math.max(0, Math.min(100, Math.round((remaining / quota) * 100))) : 100;
  const note = active ? `${h(L("portalBuyNextLater"))} ` : result.subscriptionPurchaseAccess?.message ? `${h(result.subscriptionPurchaseAccess.message)} ` : "";
  const actions = canPurchase && plan && active?.accessMode !== "home"
    ? `<div class="plan-actions portal-internet__actions">${plan.discontinued ? `<p class="error">${h(L("portalPlanDiscontinued"))}</p>` : `<a class="nd-btn nd-btn--secondary" href="/onboarding.html?action=renew&amp;plan=${h(plan.id)}">${h(L("portalRenewPlan"))}</a>`}<a class="nd-btn nd-btn--secondary" href="/onboarding.html?action=switch">${h(L("portalSwitchPlan"))}</a></div>`
    : active?.accessMode === "home" ? `<p><a class="admin-link" href="/home-router.html">${h(L("portalHomeRouterRenewal"))}</a></p>` : "";
  return `<section class="portal-internet__bundle full" data-portal-view="bundles" data-internet-group="bundles" id="managePlan" aria-labelledby="internetBundleTitle">
  <div class="nd-card nd-card--forest nd-on-forest portal-bundle">
    <div class="portal-bundle__head"><p class="nd-eyebrow" id="internetBundleTitle"><span class="nd-narrow-only">${h(active && plan ? `${L("portalActive")} · ${plan.name}` : plan ? plan.name : L("portalNoActiveBundle"))}</span><span class="nd-wide-only">${h(L(active ? "activeBundle" : "portalNoActiveBundle"))}</span></p>${active ? `<span class="portal-bundle__ends">${h(L("portalEndsOn", { date: day(active.expiresAt) }))}</span>` : ""}</div>
    ${plan ? `<p class="portal-bundle__plan nd-wide-only">${h(plan.name)}</p>` : ""}
    ${active ? `<p class="portal-bundle__amount">${h(formatDataBalance(remaining))}${quota ? ` <span>${h(L("portalOfLeft", { total: formatDataBalance(quota) }))}</span>` : ""}</p>${quota ? `<progress class="nd-meter-bar" max="100" value="${percent}" aria-label="${h(L("portalDataLeftPercent", { percent }))}">${percent}%</progress>` : ""}` : `<p class="portal-bundle__empty">${h(L("portalChooseToConnect"))}</p>`}
    ${note ? `<p class="portal-bundle__note nd-wide-only">${note}<a href="/billing-terms.html">${h(L("portalPackageRules"))}</a></p>` : ""}
  </div>
  ${note ? `<p class="portal-internet__note nd-narrow-only" role="status">${note}<a href="/billing-terms.html">${h(L("portalWhy"))}</a></p>` : ""}
  ${actions}
  <a class="nd-btn nd-btn--block portal-internet__see" href="/dashboard#bundles" data-open-catalogue>${h(L("portalSeeBundles"))}</a>
  <a class="nd-btn nd-btn--secondary nd-btn--block portal-internet__gift" href="/gift.html">${h(L("giftLink"))}</a>
  ${earlierBundles(result.vouchers || [], active)}
</section>`;
}

// Earlier bundles (phones) and Bundle history (desktop table, the active
// bundle first): finished, expired or replaced vouchers, newest first.
const WORDS = { active: "portalStatusActive", expired: "portalStatusExpired", exhausted: "portalStatusFinished", revoked: "portalStatusRevoked", replaced: "portalStatusReplaced", renewed: "portalStatusRenewed", switched: "portalStatusSwitched", refunded: "portalStatusRefunded", suspended: "portalStatusSuspended" };
const dates = (v) => (v.expiresAt && day(v.expiresAt) !== day(v.activatedAt) ? `${day(v.activatedAt)} – ${day(v.expiresAt)}` : day(v.activatedAt));
function earlierBundles(vouchers, active) {
  const past = vouchers.filter((v) => v.id !== (active && active.id) && v.activatedAt && WORDS[v.status] && v.status !== "active")
    .sort((a, b) => Date.parse(b.activatedAt) - Date.parse(a.activatedAt)).slice(0, 5);
  const rows = [...(active ? [active] : []), ...past];
  if (!rows.length) return "";
  const used = (v) => (v.usedBytes != null ? formatDataBalance(v.usedBytes) : "—");
  return `${past.length ? `<section class="portal-internet__history nd-narrow-only" aria-labelledby="earlierBundlesTitle"><h2 class="portal-internet__h" id="earlierBundlesTitle">${h(L("portalEarlierBundles"))}</h2>${past.map((v) => {
    const usedText = v.usedBytes != null ? L("portalUsed", { amount: formatDataBalance(v.usedBytes) }) : "";
    return `<div class="nd-row portal-internet__row"><span class="nd-row__main"><strong class="nd-row__title">${h(v.plan?.name || v.planId)}</strong><span class="nd-meta">${h([dates(v), usedText].filter(Boolean).join(" · "))}</span></span><span class="nd-pill">${h(L(WORDS[v.status]))}</span></div>`;
  }).join("")}</section>` : ""}
  <section class="portal-internet__table nd-wide-only" aria-labelledby="bundleHistoryTitle"><h2 class="portal-internet__card-h" id="bundleHistoryTitle">${h(L("portalBundleHistory"))}</h2><table><thead><tr><th scope="col">${h(L("portalColBundle"))}</th><th scope="col">${h(L("portalColDates"))}</th><th scope="col">${h(L("portalColUsed"))}</th><th scope="col">${h(L("adminColStatus"))}</th></tr></thead><tbody>${rows.map((v) => `<tr><td><strong>${h(v.plan?.name || v.planId)}</strong></td><td>${h(dates(v))}</td><td>${h(used(v))}</td><td><span class="nd-pill${v.status === "active" ? " nd-pill--success" : ""}">${h(L(WORDS[v.status] || "portalStatusActive"))}</span></td></tr>`).join("")}</tbody></table></section>`;
}
