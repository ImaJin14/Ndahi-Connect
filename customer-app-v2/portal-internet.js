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

// The plan card: what is active now, then what can be bought next and why.
export function internetBundle({ result, active, current, canPurchase, dailyNotice }) {
  const plan = current && current.plan;
  const detail = plan ? [plan.quotaGb === null ? L("portalUnlimitedFairUse") : `${plan.quotaGb} GB`, plan.validityHours === 24 ? L("portalOneDay") : L("portalDays", { count: Math.round(plan.validityHours / 24) }),
    active && active.accessMode === "home" ? L("portalHomeShared") : plan.deviceLimit === 1 ? L("portalOneDevice") : L("portalDevices", { count: plan.deviceLimit })].join(" · ") : "";
  const remaining = active ? left(active) : null, quota = active ? active.quotaBytes : null;
  const percent = active && quota ? Math.max(0, Math.min(100, Math.round((remaining / quota) * 100))) : 100;
  const message = result.subscriptionPurchaseAccess?.message || (active ? L("portalBuyNextLater") : "");
  const actions = canPurchase && plan && active?.accessMode !== "home"
    ? `<div class="plan-actions portal-internet__actions">${plan.discontinued ? `<p class="error">${h(L("portalPlanDiscontinued"))}</p>` : `<a class="nd-btn nd-btn--secondary" href="/onboarding.html?action=renew&amp;plan=${h(plan.id)}">${h(L("portalRenewPlan"))}</a>`}<a class="nd-btn nd-btn--secondary" href="/onboarding.html?action=switch">${h(L("portalSwitchPlan"))}</a></div>`
    : active?.accessMode === "home" ? `<p><a class="admin-link" href="/home-router.html">${h(L("portalHomeRouterRenewal"))}</a></p>` : "";
  return `<section class="portal-internet__bundle full" data-portal-view="bundles" data-internet-group="bundles" id="managePlan" aria-labelledby="internetBundleTitle">
  <div class="nd-card nd-card--forest nd-on-forest portal-bundle">
    <div class="portal-bundle__head"><p class="nd-eyebrow" id="internetBundleTitle">${h(active && plan ? `${L("portalActive")} · ${plan.name}` : plan ? plan.name : L("portalNoActiveBundle"))}</p>${active ? `<span class="portal-bundle__ends">${h(L("portalEndsOn", { date: day(active.expiresAt) }))}</span>` : ""}</div>
    ${active ? `<p class="portal-bundle__amount">${h(formatDataBalance(remaining))}${quota ? ` <span>${h(L("portalOfLeft", { total: formatDataBalance(quota) }))}</span>` : ""}</p>${quota ? `<progress class="nd-meter-bar" max="100" value="${percent}" aria-label="${h(L("portalDataLeftPercent", { percent }))}">${percent}%</progress>` : ""}` : `<p class="portal-bundle__empty">${h(L("portalChooseToConnect"))}</p>`}
    ${detail ? `<p class="portal-bundle__detail">${h(detail)}</p>` : ""}
  </div>
  ${message ? `<p class="portal-internet__note" role="status">${h(message)} <a href="/billing-terms.html">${h(L("portalPackageRules"))}</a></p>` : ""}
  ${actions}
  <a class="nd-btn nd-btn--block" href="/dashboard#bundles" data-open-catalogue>${h(L("portalSeeBundles"))}</a>
  <p class="nd-meta portal-internet__daily">${h(dailyNotice)}</p>
  ${earlierBundles(result.vouchers || [], active)}
</section>`;
}

// Earlier bundles: finished, expired or replaced vouchers, newest first.
function earlierBundles(vouchers, active) {
  const words = { expired: "portalStatusExpired", exhausted: "portalStatusFinished", revoked: "portalStatusRevoked", replaced: "portalStatusReplaced", renewed: "portalStatusRenewed", switched: "portalStatusSwitched", refunded: "portalStatusRefunded", suspended: "portalStatusSuspended" };
  const past = vouchers.filter((v) => v.id !== (active && active.id) && v.activatedAt && words[v.status])
    .sort((a, b) => Date.parse(b.activatedAt) - Date.parse(a.activatedAt)).slice(0, 5);
  if (!past.length) return "";
  return `<section class="portal-internet__history" aria-labelledby="earlierBundlesTitle"><h2 class="portal-internet__h" id="earlierBundlesTitle">${h(L("portalEarlierBundles"))}</h2>${past.map((v) => {
    const used = v.usedBytes != null ? L("portalUsed", { amount: formatDataBalance(v.usedBytes) }) : "";
    const dates = v.expiresAt && day(v.expiresAt) !== day(v.activatedAt) ? `${day(v.activatedAt)} – ${day(v.expiresAt)}` : day(v.activatedAt);
    return `<div class="nd-row portal-internet__row"><span class="nd-row__main"><strong class="nd-row__title">${h(v.plan?.name || v.planId)}</strong><span class="nd-meta">${h([dates, used].filter(Boolean).join(" · "))}</span></span><span class="nd-pill">${h(L(words[v.status]))}</span></div>`;
  }).join("")}</section>`;
}
