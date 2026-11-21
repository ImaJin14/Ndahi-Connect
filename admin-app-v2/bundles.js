// Redesigned Bundles (canvas: AdminBundles) and Edit bundle (AdminBundleEdit).
// Bundles are cards in plan-picker order; editing has its own screen with a
// live "What customers see" preview. Saving uses v1's bundle endpoints.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { fcfa } from "/payments.js";
import { groupBundles, chosenPeriod, PERIOD_LABELS } from "../shared-app/bundle-period.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const number = (value) => Number(value).toLocaleString(currentLanguage() === "fr" ? "fr" : "en-GB", { maximumFractionDigits: 1 });

// "5 GB · 7 days · 3 devices", "Unlimited · 30 days · 1 device".
// The edit preview (AdminBundleEdit) reads "Unlimited · fair use"; the cards keep "Unlimited".
export function bundleDetail(b, { fairUse = false } = {}) {
  const hours = Number(b.validityHours) || 0, devices = Number(b.deviceLimit) || 0;
  const data = b.quotaGb == null || b.quotaGb === "" ? L(fairUse ? "adminBundleUnlimitedFairUse" : "adminBundleUnlimited") : `${number(b.quotaGb)} GB`;
  const time = hours % 24 === 0 && hours >= 24 ? (hours === 24 ? L("adminOneDay") : L("adminDays", { count: hours / 24 })) : hours === 1 ? L("adminOneHour") : L("adminHours", { count: hours });
  const speed = Number(b.downloadMbps) > 0 ? L("adminUpToMbps", { speed: number(b.downloadMbps) }) : "";
  return [data, time, devices === 1 ? L("adminOneDevice") : L("adminDevices", { count: devices }), speed].filter(Boolean).join(" · ");
}

export function bundleCards(bundles, usage = {}) {
  return bundles.map((b) => {
    const onSale = !b.discontinued, issued = usage[b.name] || 0;
    return `<article class="admin-bundle${onSale ? "" : " admin-bundle--off"}" data-bundle-card="${h(b.id)}">
  <div class="admin-bundle__head"><strong>${h(b.name)}</strong><span class="nd-pill${onSale ? " nd-pill--success" : ""}">${h(L(onSale ? "adminOnSale" : "adminNotOnSale"))}</span></div>
  <p class="admin-bundle__price">${h(fcfa(b.price))}</p>
  <p class="admin-bundle__detail">${h(bundleDetail(b))}</p>
  <p class="nd-meta">${h(issued === 1 ? L("adminIssuedOne") : L("adminIssued", { count: issued }))}${b.custom ? " · " + h(L("adminCustomBundle")) : ""}</p>
  <div class="admin-bundle__actions"><a class="nd-btn nd-btn--compact nd-btn--secondary" href="/dashboard#bundle/${encodeURIComponent(b.id)}" aria-label="${h(L("adminEditNamed", { name: b.name }))}">${h(L("adminEdit"))}</a>${b.custom ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--secondary admin-btn--danger" data-delete-bundle="${h(b.id)}" aria-label="${h(L("adminDeleteNamed", { name: b.name }))}">${h(L("adminDelete"))}</button>` : ""}</div>
</article>`;
  }).join("");
}

// Bundles under Daily, Weekly and Monthly with filter chips and counts (owner,
// 21 Nov), when they span more than one period. The filter is kept across
// refreshes of the dashboard.
let period = "all";
export function bundleGroups(bundles, usage = {}) {
  const groups = groupBundles(bundles);
  if (groups.length < 2) return `<div class="admin-bundles__grid">${bundleCards(bundles, usage)}</div>`;
  period = chosenPeriod(period, groups);
  const count = (value) => value === "all" ? bundles.length : groups.find((group) => group.period === value).plans.length;
  return `<div class="nd-chips admin-bundles__chips" role="group" aria-label="${h(L("bundlePeriodFilter"))}">${["all", ...groups.map((group) => group.period)].map((value) =>
    `<button type="button" class="nd-chip admin-bundles__chip" data-bundle-period="${value}" aria-pressed="${value === period}">${h(L(PERIOD_LABELS[value]))} <span class="admin-bundles__count">${count(value)}</span></button>`).join("")}</div>
${groups.map((group) => `<section class="admin-bundles__group" data-bundle-group="${group.period}" aria-labelledby="bundleGroup-${group.period}"${period !== "all" && period !== group.period ? " hidden" : ""}>
  <h2 class="nd-h3 admin-bundles__group-title" id="bundleGroup-${group.period}">${h(L(PERIOD_LABELS[group.period]))}</h2><div class="admin-bundles__grid">${bundleCards(group.plans, usage)}</div></section>`).join("")}`;
}
export function showBundlePeriod(root, value) {
  period = value;
  root.querySelectorAll("[data-bundle-period]").forEach((chip) => chip.setAttribute("aria-pressed", String(chip.dataset.bundlePeriod === period)));
  root.querySelectorAll("[data-bundle-group]").forEach((group) => { group.hidden = period !== "all" && group.dataset.bundleGroup !== period; });
}

// Fills the edit screen for one bundle; returns false when it doesn't exist.
export function showBundleEdit(bundle, { setHead }) {
  const form = document.getElementById("bundleEdit");
  if (!form || !bundle) return false;
  setHead({ title: L("adminEditNamed", { name: bundle.name }) });
  const fields = form.elements;
  fields.bundleId.value = bundle.id;
  fields.name.value = bundle.name;
  fields.price.value = bundle.price;
  fields.validityHours.value = bundle.validityHours;
  fields.deviceLimit.value = bundle.deviceLimit;
  fields.unlimited.checked = bundle.quotaGb == null;
  fields.quotaGb.value = bundle.quotaGb == null ? "" : bundle.quotaGb;
  fields.downloadMbps.value = bundle.downloadMbps ?? "";
  fields.uploadMbps.value = bundle.uploadMbps ?? "";
  const message = document.getElementById("bundleEditMessage");
  if (message && message.dataset.forBundle !== bundle.id) message.textContent = "";
  const sync = () => {
    const unlimited = fields.unlimited.checked;
    document.getElementById("bundleQuotaField").hidden = unlimited;
    fields.quotaGb.required = !unlimited;
    if (unlimited) fields.quotaGb.value = "";
    const preview = document.getElementById("bundlePreview");
    preview.querySelector("[data-preview-name]").textContent = fields.name.value || bundle.name;
    preview.querySelector("[data-preview-detail]").textContent = bundleDetail({ quotaGb: unlimited ? null : fields.quotaGb.value || 0, validityHours: fields.validityHours.value, deviceLimit: fields.deviceLimit.value, downloadMbps: fields.downloadMbps.value }, { fairUse: true });
    preview.querySelector("[data-preview-price]").textContent = fcfa(fields.price.value);
  };
  form.oninput = sync;
  sync();
  return true;
}
