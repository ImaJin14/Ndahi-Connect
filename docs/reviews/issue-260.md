# Issue 260 — optional French Home and tab bar

Implemented for review; not merged, deployed or physically verified. The owner explicitly approved optional French for #260. English remains the default, including for a French browser; Account → Language selects French and remembers it when storage is available. A blocked storage API still allows French in the current document.

Reference: `docs/redesign/screens/PhoneHomeFR.dc.html` and `TabBar.dc.html`, from design dependency #265 (`202005c`). This PR is based on `docs/redesign-handoff` so only this feature appears in its diff.

## Evidence

- [390px source/build](issue-260/home-fr-390-comparison.png), [360px source/build](issue-260/home-fr-360-comparison.png).
- All five selected tab states: [360px](issue-260/tab-states-fr-360-comparison.png), [390px](issue-260/tab-states-fr-390-comparison.png). Labels, icons, selected state, targets and single-line placement match.
- [French desktop, 1280px](issue-260/home-fr-1280.png). There is no French desktop artboard: this is responsiveness evidence, not an invented desktop reference.
- Account picker with keyboard focus: [360px](issue-260/account-fr-360.png), [390px](issue-260/account-fr-390.png).
- [Six French network states](issue-260/network-states.json), with360px captures for [confirmed router](issue-260/network-connected-360.png), [Internet unconfirmed](issue-260/network-internet-unconfirmed-360.png), [signed out](issue-260/network-signed-out-360.png), [ended bundle](issue-260/network-bundle-ended-360.png), [authorizing](issue-260/network-authorizing-360.png) and [unconfirmed Wi-Fi](issue-260/network-wifi-unconfirmed-360.png). These are synthetic evidence states, preserving all network conditions and cautions.
- [French pending-payment refresh](issue-260/payment-pending-fr-360.png), including the payment timer and USSD help.
- [Measured tab labels](issue-260/tab-metrics.json): zero clipped or wrapped labels in all five active tabs at 360/390px. The automated test also measures 1280px.

The 390px reference is native size. The 360px reference changes only the source frame width from390 to360; fonts, spacing and icons are not scaled. Screenshots use deviceScaleFactor1; optional install guidance was dismissed through its actual button before capture. Both source and build are browser-rendered. No screenshots were used as production UI.

## Deliberate differences requiring owner review

The preview uses real local APIs with synthetic accounts and no external payment/router calls. Plan name, remaining validity, recorded sessions and product price come from that API, rather than the artboard's placeholders. A valid bundle is labelled Active, not Connected: it does not prove Wi-Fi authorization. The longer, translated unconfirmed-network explanation and recorded-usage evidence remain visible; they move the card and following content down relative to the reference. Hiding them would misrepresent evidence. Product imagery remains the existing kit fallback until real catalogue photos exist; the source's “Photo” placeholder is not an actual asset. These are explicitly not a claim of pixel identity or physical router verification. Owner visual approval is still required before issue closure.

## Validation

- `npm run check`: passed; new browser test syntax checked and included by the CI regression glob.
- `npm test`: 1,300 passed, 0 failed, 41 PostgreSQL cases skipped because TEST_DATABASE_URL was unset locally. CI supplies its database separately.
- New `test/redesign-browser/french-home.test.mjs`: passed. Covers French browser/English default; actual native keyboard selection with retained focus; French persistence and switching back; static labels and the Home setup reminder; Home/navigation at360/390/1280; every active tab at360; an actual translated countdown text change; six network states; pending-payment refresh/timer/help; handled failed language refresh; French browser with blocked storage; zero page errors.
- Portal account: 21 v1 and25 v2 journeys passed. Dashboard entry and its PWA checks passed on both variants. v1 runs explicitly used CUSTOMER_UI_DEFAULT=v1 ADMIN_UI_DEFAULT=v1; v2 runs used scripts/ui-v2-journeys.mjs.
- Keyboard focus on the native select and tab navigation checked. Rendered Account contrast scan: zero failures.
- [Claude Code read-only reviews](issue-260/claude-review.md): four P2 refresh/focus findings corrected and regression-tested; follow-up found no remaining P0/P1/P2 in scope. The review did not execute tests or grant owner visual approval.

## Acceptance metric and checklist handoff

Data source for zero clipped/wrapped labels: DOM scrollWidth/clientWidth, rendered height and white-space checks in the committed regression, with per-tab capture metrics above. This is measured synthetic browser evidence, not field telemetry.

Checklist entry for the peer-owned product checklist: “#260: optional FR Home/nav implemented and browser-tested on both variants, EN default preserved; draft PR and captures linked to issue; owner visual acceptance, deployment and real-device verification pending.” The checklist is claimed on the other PC, so this entry is handed off without overwriting its draft.
