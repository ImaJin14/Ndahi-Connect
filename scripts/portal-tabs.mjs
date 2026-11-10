// Portal navigation selectors for browser journeys that run on both UI versions.
//   v1: Home · Bundles · Vouchers · Payments · Account, a side rail from 1000px.
//   v2 (redesign): Home · Internet · Shop · Activity · Account, in the header from
//   768px. Bundles and Vouchers live under Internet, Payments under Activity.
// scripts/ui-v2-journeys.mjs sets NDAHI_UI_VARIANT=v2 for `npm run test:browser:v2`.
export const uiV2 = process.env.NDAHI_UI_VARIANT === "v2";

const V2_TABS = { bundles: "internet", vouchers: "internet", payments: "activity" };

// The tab that shows a v1 view, for example portalTab("payments").
export function portalTab(view) {
  return `[data-portal-tab="${uiV2 ? V2_TABS[view] || view : view}"]`;
}

// The count badge on that tab.
export function portalTabBadge(view) {
  return `${portalTab(view)} ${uiV2 ? ".nd-topnav__badge" : ".nav-badge"}`;
}

// Viewport width from which the nav is no longer the bottom bar.
export const portalNavDesktopWidth = uiV2 ? 768 : 1000;
