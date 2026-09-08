# NDAHI Connect Login Design QA

- Source visual truth: `test/qa-assets/login-selected-option-3.png`
- Desktop implementation: `test/qa-assets/login-implementation-desktop.png`
- Mobile implementation: `test/qa-assets/login-implementation-mobile.png`
- Forgot-PIN desktop: `test/qa-assets/forgot-pin-desktop.png`
- Forgot-PIN mobile: `test/qa-assets/forgot-pin-mobile.png`
- Side-by-side evidence: `test/qa-assets/login-comparison.png`
- Desktop viewport: 1440 × 1024 CSS pixels, device scale factor 1
- Source pixels: 1536 × 1024; proportionally contained in a 1440 × 1024 comparison cell
- Implementation pixels: 1440 × 1024
- Mobile viewport and pixels: 390 × 844, device scale factor 1
- State: customer login, PIN hidden by default; visibility toggle and reset-request interaction tested

## Findings

No actionable P0, P1, or P2 issues remain.

- Fonts and typography: Playfair Display and DM Sans match the selected direction’s editorial heading and practical interface hierarchy. Text weights, wrapping, and line heights remain readable at both checked viewports.
- Spacing and layout rhythm: the broad access panel, two-column desktop fields, full-width primary action, divided alternative methods, and centered new-customer action follow the selected composition. Mobile collapses cleanly to one column with no page overflow.
- Colors and visual tokens: the implementation uses the established forest, lime, ivory, paper, muted-text, and sage-border tokens. The sign-in action remains the strongest element without introducing new visual language.
- Image quality and asset fidelity: the selected design contains no required raster imagery. The existing brand mark is preserved as the product’s established code-native logo treatment; no placeholder imagery was introduced.
- Copy and content: customer-facing language consistently says PIN rather than password. Forgot PIN is adjacent to the field, and recovery explains email eligibility, link lifetime, one-time use, and session invalidation.
- Interaction and accessibility: PIN visibility toggles between password and text states, restores the hidden state, updates its visible label, and exposes `aria-pressed` and `aria-controls`. Forgot PIN navigation and generic reset confirmation work. Browser console errors in the final run: zero.

## Focused comparison evidence

The full side-by-side image was sufficient for desktop hierarchy, typography, spacing, palette, form alignment, and secondary-action fidelity. Separate mobile login and forgot-PIN captures were inspected because responsive stacking and recovery content are not visible in the desktop source.

## Comparison history

1. The first browser recovery check used `127.0.0.1`, while local CORS is intentionally configured for `localhost`. The QA harness was corrected to use the configured origin; the final request succeeded with zero browser console errors.
2. The final implementation retains text controls rather than the mock’s decorative icons. This is an intentional accessible production choice because the project has no approved icon library, and the actions remain clear without fabricated glyphs.

## Follow-up polish

- P3: add icons only if NDAHI adopts an approved product icon library; do not introduce one solely for this screen.

## Implementation checklist

- [x] Selected option 3 applied to the customer login
- [x] PIN Show/Hide control works by mouse and keyboard
- [x] Forgot-PIN request and confirmation routes implemented
- [x] Reset tokens hashed, single-use, throttled, and limited to 15 minutes
- [x] Existing customer sessions invalidated after a successful reset
- [x] Desktop and mobile captures inspected
- [x] Full automated suite passes
- [x] Browser interaction run completed with zero console errors

final result: passed
