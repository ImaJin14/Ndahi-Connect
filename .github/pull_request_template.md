<!-- Open as a draft. Never merge your own PR. Read AGENTS.md first. -->

Closes #

## What changed


## Design fidelity
<!-- Required when the PR changes customer-app-v2/, admin-app-v2/, store-app/ or shared-app/ui/ (checked by CI).
Name the design screens from docs/redesign/screens/ that this PR builds. If nothing visible changes, write
"Screens: none — <reason>" and delete the rest of this section. -->
Screens: 
- [ ] Every state of each screen captured next to its design at the same width (390 px phone, 1280 px desktop/admin), using `node scripts/redesign-preview.mjs --capture` or the design PNGs in `docs/redesign/screens/png/`
- [ ] Layout, copy, order, components and states match the design
Differences: none
<!-- Anything that doesn't match must be fixed, or listed here, one per line, each with a link to the owner's approving
comment (…/issues/N#issuecomment-…). Real API data in place of sample data or [PLACEHOLDERS] is not a difference. -->

<!-- Paste one design-vs-build image per screen (more for each state). -->

## Journeys run
<!-- Name them; run each normally and with ?ui=new. -->

## Testing and quality bar
- [ ] `npm run check` and `npm test` pass; new files are added to the `check` list
- [ ] Affected browser journeys pass on **both** v1 and v2
- [ ] English and French both checked
- [ ] Keyboard-only run-through and contrast check on new components
- [ ] Zero browser console errors and no new CSP reports
- [ ] Defaults still leave production on v1
