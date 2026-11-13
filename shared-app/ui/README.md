# NDAHI design kit (`shared-app/ui/`)

The shared tokens and components for the redesigned portal (`customer-app-v2/`),
admin (`admin-app-v2/`) and, from Phase 4, the public store. Built in Phase 1 of
[the redesign](../../docs/redesign/execution-plan.md) from the canvas sources in
[`docs/redesign/screens/`](../../docs/redesign/screens/).

**Ownership.** After Phase 1 only Claude Code changes this folder (see `AGENTS.md`).
If a screen needs a component, variant or token that is not here, open an issue
instead of adding page-level copies.

**Reference page.** `customer-app-v2/ui-kit.html` shows every component in English
and French. It is not linked anywhere. Open it with
`https://staging-portal.ndahiconnect.net/ui-kit.html?ui=new` (or locally on a v2
cookie). `node scripts/check-ui-kit-journeys.mjs` checks it in a browser.

## Using the kit on a page

```html
<html lang="en" data-ui-variant="v2">
<head>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=Playfair+Display:wght@600;700&display=swap">
  <link rel="stylesheet" href="/shared/ui/tokens.css">
  <link rel="stylesheet" href="/shared/ui/components.css">
</head>
<body class="nd-page">
  …
  <script type="module" src="/page.js"></script>
</body>
```

- The static server serves this folder at `/shared/ui/` in every app and rewrites
  `href`, `src`, CSS `url()` and JS `import` paths to content-versioned files.
- The CSP allows no inline scripts and no `style=""` attributes. Put scripts in
  files. Set sizes from JavaScript through `element.style.x = …` (CSSOM is allowed),
  as `setMeter()` does, or use a class.
- Every class starts with `nd-`, so a page can load the kit next to an old v1
  stylesheet while it is being rebuilt. New screens should not load `styles.css`.

## Rules the kit follows (keep them in your screens)

- **Browser floor:** Chrome 73 / Safari 12.1, the same as `customer-app/compat.js`.
  Kit JavaScript avoids `?.`, `??`, `replaceAll`, `.at()` and private fields. Kit CSS
  avoids `@layer`, `:is()`, `:where()`, `:has()` and `inset`, because one unknown
  selector drops the whole rule on old browsers. `test/ui-kit.test.mjs` enforces this.
- **Text from data:** builders set text with `textContent` only. Plan names, prices,
  phone numbers and pickup details come from the API; the `[PRICE]`-style
  placeholders on the reference page are samples.
- **Accessibility:** 44 px touch targets (36–40 px admin controls grow to 44 px on
  touch screens), visible 3 px focus ring (forest on light surfaces, lime on
  forest), at least 4.5:1 for all text pairs, labelled controls.
- **Bilingual:** component strings are the `ui*` keys in `shared-app/i18n.js`, in
  English and French. Builders follow `<html lang>`; call `setDocumentLanguage()`
  once at start-up.

## Tokens (`tokens.css`)

| Group | Variables |
| --- | --- |
| Brand | `--nd-forest`, `--nd-forest-deep`, `--nd-lime`, `--nd-lime-hover`, `--nd-lime-ink` (text on lime), `--nd-lime-text` (eyebrows), `--nd-meter` |
| Surfaces | `--nd-ivory` (page), `--nd-paper` (cards), `--nd-white` (inputs), `--nd-sage`, `--nd-sage-strong`, `--nd-track` |
| Text | `--nd-ink`, `--nd-ink-soft`, `--nd-muted`, `--nd-on-forest`, `--nd-on-forest-soft`, `--nd-on-forest-muted`, `--nd-on-forest-faint` |
| Lines | `--nd-line`, `--nd-line-strong`, `--nd-line-on-forest` |
| Status | `--nd-{success,warning,danger,info,neutral}-{bg,fg}`, `--nd-danger`, `--nd-danger-line`, `--nd-danger-soft`, `--nd-warning-line`, `--nd-status-{online,degraded,offline,maintenance,unknown}` |
| Type | `--nd-font-display` (Playfair Display), `--nd-font-body` (DM Sans), `--nd-font-mono`, `--nd-fs-*` (eyebrow 11 → h1-xl 36) |
| Space | `--nd-space-4` … `--nd-space-48`, named after the canvas pixel values |
| Shape | `--nd-radius-{sm,control,panel,card,card-lg,hero,pill}`, `--nd-shadow-raised`, `--nd-shadow-soft` |
| Size and focus | `--nd-touch` (44px), `--nd-control-height` (48px), `--nd-button-height` (50px), `--nd-focus-*` |

## Components

| Need | Markup / class | JavaScript |
| --- | --- | --- |
| Buttons | `.nd-btn` (primary lime) + `--secondary`, `--danger`, `--danger-solid`, `--dark`, `--quiet`; sizes `--block`, `--sm`, `--compact` (admin tables) | `setBusy(button, true)` |
| Icon button | `.nd-icon-btn` (44 × 44), `--on-forest`, `--outlined`, `.nd-icon-btn__dot` | `icon(name)`, `renderIcons()` for `<span class="nd-icon" data-nd-icon="back">` |
| Cards | `.nd-card`, `--raised` (Home bundle), `--forest` (active bundle), `.nd-panel` (admin section), `.nd-tile` (quick action), `.nd-media-row` + `.nd-thumb` | `renderMeter(0.64)`, `setMeter()` |
| Notes and callouts | `.nd-note`; `.nd-callout--success` (use `role="status"`), `--warning`, `--danger` (confirmations), `--info` | |
| Lists | `.nd-list` > `.nd-list__item` (+ `.nd-list__value`, `--on`, `.nd-chevron`, `.nd-list__item--danger`); history rows `.nd-row` | |
| Pills and status | `.nd-pill--success|warning|danger|info|lime`, `.nd-badge`, `.nd-dot--*` | `renderNetworkStatus("online")` |
| Fields | `.nd-field` > `.nd-label` + `.nd-input` + `.nd-hint`; `.nd-input-group` + `__addon` (+237); `.nd-label-row` (label + "Forgot PIN?") | `setFieldError(input, msg)`, `clearFieldError()`, `focusFirstError(form)` |
| PIN | `.nd-pin` > `input.nd-input[type=password]` + `button.nd-pin__toggle[data-nd-pin-toggle][aria-controls]` | `enhancePinToggles()` |
| Options | `.nd-option` (plan card), `.nd-option--compact` (MoMo / Orange); selected with `aria-pressed="true"` | `enhanceChoiceGroup(group, { onChange })` |
| Segmented and chips | `.nd-segmented` > `.nd-segmented__option` (`aria-pressed` or `role="tab"`); `.nd-chips` > `.nd-chip` | `enhanceChoiceGroup()`, `enhanceTabs(tablist)` |
| Switch | `<label class="nd-switch"><input type="checkbox" role="switch" class="nd-switch__input"><span class="nd-switch__track" aria-hidden="true"></span></label>` — works without JavaScript | |
| Progress | `.nd-steps`, `.nd-stepper`, `.nd-step-count` | `renderSteps()`, `renderStepper()`, `stepCount(1, 3)` |
| Screen frame | `.nd-screen` > `.nd-topbar` + `.nd-screen__body` + `.nd-actionbar` (sticky, safe-area aware) | `renderBackButton({ href })` |
| Portal navigation | `header.nd-topnav` > `.nd-topnav__inner` > brand + `nav.nd-topnav__links` + `.nd-topnav__aside`. The one nav is the bottom tab bar below 768 px and header links from 768 px; add `--phone-bar` to keep a slim bar on phones, `nd-has-tabbar` to `<body>`, `nd-keyboard-open` while the keyboard is up; `.nd-wide-only`. Home hero: `.nd-hero` + `.nd-overlap` | `renderPortalTabs({ current, hrefs, badges })` fills a nav written in HTML; `renderPortalHeader({ current, network, notifications, badges, actions, phoneBar })` builds the whole header |
| Admin | `.nd-admin-shell` > `__side` + `__main`; `.nd-pagehead`, `.nd-metrics` > `.nd-metric`, `.nd-table-wrap` > `.nd-table` | `renderAdminMenu({ current, canAccess, badges, onSignOut })` |
| States | `.nd-state--success|waiting|error|info|empty`, `--compact`; `.nd-spinner` | `renderState({ tone, title, body, list, actions })`, `focusState()` |
| Helpers | `.nd-visually-hidden`, `.nd-skip-link`, `.nd-stack(--8|12|22)`, `.nd-cluster`, `.nd-split`, `.nd-grid-2`, `.nd-container` | `h()`, `localize(root, lang)`, `announce(msg)` |

### Notes

- **One nav per page.** The tab bar and the header links are the same five links
  (`data-portal-tab="home|internet|shop|activity|account"`), so screen readers meet one
  "Main" landmark and tests find one element per tab. `customer-app-v2/index.html` shows
  the HTML version.
- **Routing stays with the page.** `renderPortalTabs` and `renderPortalHeader` default to
  `#home`, `#internet`… Pass `hrefs` with the real routes. Admin role rules stay in
  `admin-app*/navigation.js`; pass them to `renderAdminMenu` as `canAccess(id)`.
- **Static text:** write the English in the HTML with `data-i18n="key"` (and
  `data-i18n-aria-label`, `-placeholder`, `-title`, `-alt`), then call
  `localize(document, lang)`. Use `data-i18n` only on elements that hold plain text.
- **Placeholders:** `format("uiStepCount", { current: 1, total: 3 })` fills `{name}`.
- **Waiting screens** announce their title through one shared live region
  (`announce()`); pass `announce: false` when the screen is not the result of an
  action.
- **The data meter is decorative.** Always show the amount as text beside it.

## Known gaps for the owner

Kept as drawn on the canvas, but below WCAG 1.4.11 (3:1 for non-text UI):
the switch's off track `--nd-switch-off` (1.5:1 on paper), input and secondary-button
borders `--nd-line-strong` (1.8:1) and the meter fill on its track (2.9:1). Each is a
one-token change if the owner wants stronger outlines.
