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
