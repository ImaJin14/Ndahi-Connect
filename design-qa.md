# Design QA — #253

Source visual truth: `docs/redesign/screens/AdminVouchers.dc.html`, `AdminCustomerDetail.dc.html`, from design dependency #265. Browser-rendered source/build comparisons, including every in-scope mode and state, are in `docs/reviews/issue-253/`; the index and API constraints are in `docs/reviews/issue-253.md`.

Density:1280×900 CSS viewport, deviceScaleFactor1, full-page captures at native width. Actual source/build pixel heights are recorded in `capture-manifest.json`; no resizing was used.390px build captures check responsiveness because the admin references have no phone layout. Static comparisons blur a focused control by clicking the page title; keyboard focus was tested separately.

Full-view inputs: the12 in-scope `*-comparison-1280.png` files listed in the review. Focused readable inputs: `active-unconfirmed-form-comparison.png` and `gift-success-form-comparison.png`. Source and build are together in each input. The unregistered reservation comparison is separately labelled blocked by #254 and is not counted as a match.

## Iterations and fixes

- P1: customer-detail entry previously pre-checked replacement. Removed; current bundle is re-read and consent must be fresh. Race/receipt warnings and lost-response handling were reviewed with Claude and covered by meaningful regressions.
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

No remaining P1/P2 code issue was found in Claude's final focused review. Functional tests and capture readiness pass. Exact visual acceptance is still blocked on owner review of the listed API constraints and retained advanced/list/sidebar controls; the pairs are not represented as pixel-identical. Deployment and physical verification are pending.

final result: blocked
