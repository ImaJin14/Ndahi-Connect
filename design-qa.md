# NDAHI Connect Product Design QA

- Source visual truth: `test/qa-assets/selected-option-1.png`
- Final implementation: `test/qa-assets/onboarding-implementation.png`
- Side-by-side evidence: `test/qa-assets/final-comparison.png`
- Interaction evidence: `test/qa-assets/onboarding-interaction.png`
- Responsive evidence: `test/qa-assets/onboarding-mobile.png`
- Viewport: 1440 × 1024 CSS pixels, device scale factor 1
- Source pixels: 1536 × 1024; normalized by proportional display in the comparison frame
- Implementation pixels: 1440 × 1024
- State: onboarding, Student Monthly recommended/selected; payment sheet separately tested open

## Findings

No actionable P0, P1, or P2 issues remain.

- Fonts and typography: the implementation preserves the source's editorial serif display hierarchy and compact sans-serif utility text. The exact generated-mock font is not identifiable; Playfair Display and DM Sans are close production substitutes with appropriate weights, wrapping, and line height.
- Spacing and layout rhythm: header, hero, package comparison, recommendation emphasis, and primary actions preserve the source hierarchy. The implementation uses a horizontally scrollable catalogue so all ten production bundles remain available rather than limiting the view to the six illustrative mock bundles.
- Colors and visual tokens: deep forest, warm ivory, lime action/state accents, sage selection and low-contrast dividers match the source. Contrast remains accessible in the checked states.
- Image quality and asset fidelity: the campus/radio-wave hero is a purpose-generated raster asset with the selected concept's art direction. It is sharp at desktop and crops intentionally at mobile. No visible illustration was replaced with CSS or placeholder art.
- Copy and content: production bundle names, prices, quotas, validity and device limits are preserved from the application rather than the inaccurate sample values in the generated concept.
- Responsive state: the 390 × 844 capture keeps the login action, headline, CTA, coverage list and first package readable without horizontal page overflow. Package rows intentionally scroll within the catalogue.
- Interaction state: selecting Student Monthly exposes the selection summary; Continue to payment opens the correct payment sheet. Browser console errors after the final CSP/cache pass: zero.

## Focused comparison evidence

The payment-sheet capture verifies form alignment, title scale, dimmed backdrop, field grouping and primary action. The mobile capture verifies the hero crop, type wrapping and package entry point. These focused views were required because the full desktop comparison cannot show both the below-fold payment state and narrow breakpoint.

## Comparison history

1. Initial capture showed package data stuck in a loading state because QA used `127.0.0.1`, which correctly failed the exact-origin policy. Recaptured using the configured `localhost` origin.
2. Initial CSS allowed a hidden selection bar to participate in layout. Added a global hidden-state rule.
3. First comparison placed only five fixed columns above the fold and deferred the selected-plan summary. The catalogue was initially changed to a horizontal row, then revised from user feedback into a continuous five-by-two wrapping grid that exposes all ten bundles without an internal scrollbar.
4. Browser QA reported font-CSP and favicon errors. Updated CSP for the chosen Google Fonts, added a no-content favicon response, disabled cache for QA, and reran with zero page console errors.

## Follow-up polish

- P3: a future branded vector logo could replace the current restrained text monogram when NDAHI supplies an official master asset.
- P3: optional category filters could shorten the ten-plan horizontal catalogue on small screens.

## Implementation checklist

- [x] Selected visual direction applied to onboarding, login, OTP, customer dashboard and admin
- [x] Real hero asset placed and responsive crop checked
- [x] Package selection and payment sheet tested
- [x] Desktop and mobile captures reviewed
- [x] Build and automated tests passed
- [x] Browser console clean
- [x] Switching from Monthly to Weekly leaves exactly one selected card; Monthly is immediately unhighlighted

final result: passed
