# Design QA — #260

Source visual truth: `docs/redesign/screens/PhoneHomeFR.dc.html`, `TabBar.dc.html` (design dependency #265). Implementation screenshots and combined source/build inputs: `docs/reviews/issue-260/`.

Viewports: native390×844 and adapted360×844, CSS px = image px, deviceScaleFactor1. Only the reference frame width was adapted at360; neither capture was rescaled. Desktop1280×900 is a responsive check because the source has no French desktop variant. State: signed-in Home with recorded bundle evidence; all five active French tab states. Optional install guidance dismissed using its real control.

Full-view comparison inputs: `home-fr-390-comparison.png`, `home-fr-360-comparison.png`. Focused navigation inputs: `tab-states-fr-360-comparison.png`, `tab-states-fr-390-comparison.png`, showing source and build together for every state.

## Comparison history

1. P1: optional French initialization was disabled, so the baseline stayed English. Fixed by explicit preference and Account selection, with English still the default.
2. P2: French Home showed English GB/MB and expiry text, and the phone heading/quick-action copy differed. Fixed through shared EN/FR strings and v2-only localized formatting; the ticking countdown now uses the same formatter.
3. P2: long recorded-session text squeezed the French expiry onto two lines at360. Concise singular/plural session copy and a non-shrinking expiry preserve the label. The adjacent recorded-usage message retains its evidence meaning.
4. P2: Bundle details wrapped at390. Matched the source's15px button type and8px inset using existing kit tokens. Post-fix captures above show it on one line at390.

5. P2 completion review: static labels, keyboard focus, failed language refresh and pending-payment refresh fixed. Six network states, the visible account reminder, payment timers and USSD help are translated and captured. A real countdown change and keyboard focus are required by the regression. Claude’s follow-up found no remaining P0/P1/P2 in scope.

## Fidelity surfaces

- Typography: locally served DM Sans / Playfair Display, French accents and figure decimal comma checked. All five tab labels are11px, single-line and unclipped; source/build strips match. Phone heading matches the reference copy. Desktop retains the personalized greeting.
- Layout/rhythm: source frame, card, actions, quick links and fixed tabs compared at identical widths. The remaining vertical displacement comes from visible API evidence described below.
- Colors/tokens: existing forest, lime, sage and paper kit tokens retained. Active tabs match; Account select focus is visible. Rendered Account contrast scan had zero failures.
- Assets: existing kit navigation icons retained and compared at readable size. The source contains a product-photo placeholder, not a usable photograph; the existing catalogue fallback remains.
- Copy/content: Home units, expiry, heading, quick action and tabs translated. API values replace placeholders. The network warning, Active status and recorded-session/usage wording deliberately preserve the distinction between account evidence and confirmed router access.

Primary interactions tested: Account keyboard preference; every tab selected; reload persistence; switching back to English; storage denial; expiry ticking. No page errors in the regression. Functional and capture details are in `docs/reviews/issue-260.md`.

No actionable P0/P1/P2 finding remains within #260's French Home/tab layout scope. Expected data/evidence and asset-placeholder differences are listed in the review and need owner visual approval before issue closure; this technical QA does not grant that approval. Deployment and physical verification remain pending.

final result: passed

# Design QA — #253

Source visual truth: `docs/redesign/screens/AdminVouchers.dc.html`, `AdminCustomerDetail.dc.html`, from design dependency #265. Browser-rendered source/build comparisons, including every in-scope mode and state, are in `docs/reviews/issue-253/`; the index and API constraints are in `docs/reviews/issue-253.md`.

Density:1280×900 CSS viewport, deviceScaleFactor1, full-page captures at native width. Actual source/build pixel heights are recorded in `capture-manifest.json`; no resizing was used.390px build captures check responsiveness because the admin references have no phone layout. Static comparisons blur a focused control by clicking the page title; keyboard focus was tested separately.

Full-view inputs: the12 in-scope `*-comparison-1280.png` files listed in the review. Focused readable inputs: `active-unconfirmed-form-comparison.png` and `gift-success-form-comparison.png`. Source and build are together in each input. The unregistered reservation comparison is separately labelled blocked by #254 and is not counted as a match.

## Iterations and fixes

- P1: customer-detail entry previously pre-checked replacement. Removed; current bundle is re-read and consent must be fresh. The owner-authorized server guard now rejects a changed active voucher atomically; receipt warnings and lost-response handling remain. Claude verified the lock/guard and meaningful race regressions cover it.
- P2: the former300px batch panel cramped the new form and allowed the browser's140px input minimum to squeeze radios. Matched the source content width, scoped native control minima and44px inputs, fixed radio cards and spacing, and captured again.
- P2: initial success actions stacked and used the wrong surface/type. Matched the source's two-column bordered actions and14px receipt copy, retaining truthful server evidence wording.
- P2: batch introduction, quantity controls and ready state drifted from the new source. Moved its explanation before the fields, matched control typography, and collapsed raw codes behind Show codes. Existing advanced batch functions remain, visibly listed as extensions for owner review.
- P2: retained list controls made rows much denser than the source. Moved filters/actions into native disclosures and made code links open Details; date/status, scope, lazy-details and printing journeys were rerun.
- P2: CSP rejected the existing thermal renderer's inline browser styles. Browser slips now use the already-existing external classes; email markup is preserved. Console and print regression checks were rerun.

## Required fidelity surfaces

- Typography: DM Sans/Playfair Display from existing kit;14px control/copy scale,26px monospace code, readable French accents, wrapping and hierarchy checked. Variable API codes/plans replace placeholders.
- Spacing/layout: source panel width, card padding, radio cards, warning, field gaps, two-button receipt row and responsive stacking compared. Some vertical displacement follows truthful queue/delivery copy and retained operational controls.
- Colors/tokens: forest/lime/sage/paper and semantic warning/disabled kit tokens; contrast scans on normal and replacement states pass. Focus is visible and mode/radio/confirmation controls work from the keyboard.
- Assets/icons: existing kit sidebar, initials avatars and controls retained. These references require no missing raster/photo assets and no replacement art was fabricated.
- Copy/content: mode names, payment hints, entry action and main actions follow the source, with EN/FR keys. API-unavailable delivery promises, confirmed physical disconnects and invented batch IDs are replaced by honest copy. Unregistered reservation is gated for #254.

Claude’s completion review verified the atomic guard and found no P0/P1 code issue; its two P2 stale-wording findings have been corrected. Functional tests and capture readiness pass. Exact visual acceptance is still blocked on owner review of the listed API constraints and retained advanced/list/sidebar controls; the pairs are not represented as pixel-identical. Deployment and physical verification are pending.

final result: blocked
