# Claude Code completion review — #260

Read-only review on14November2026 using the installed Claude Code binary. It read the source and paired Home/tab screenshots; it did not execute tests or grant owner visual approval.

The first review identified four P2 issues: fixed labels did not change on language selection; keyboard focus was lost; failed refreshes were unhandled; and pending payment refreshes rebuilt English content without help. Each was fixed, with browser regressions. Home network labels, reminder, payment timers and USSD help now use EN/FR strings. The reminder dialog itself is outside the French Home/tab scope.

## Follow-up result

I found **no remaining P0, P1 or P2 issues** in the French Home and language selection scope. All four earlier findings are fixed. I couldn't read the git diff without running a command, so I reviewed the current files directly and didn't run anything.

**Earlier findings, now fixed**
1. **Fixed labels now switch language.** `applyLanguage` re-translates the header, `#shopPanel`, `#portalHead` and `#activateDevice`, plus the brand, title, eyebrow and logout text (`customer-app-v2/app.js:513-524`). `load()` then redraws the content in the new language.
2. **The language select keeps focus.** The code notes whether the select had focus before the change and puts it back after `load()` when the Account view is showing (`app.js:537,541`). Focus is also put back on failure (`app.js:546`).
3. **A failed page refresh is handled.** The `try/catch` at `app.js:539-547` shows a message in the chosen language. The French message (`shared-app/i18n.js:1403`) says plainly that the choice is only saved if storage is available.
4. **A pending payment stays in French after a refresh.** `refreshPaymentRecords` rebuilds the card with `pendingPaymentContent` (`app.js:229-233,580`). That function and the timer and USSD help text all read the language at the moment they render (`customer-app-v2/payment-timing.js:4,8-21,38-41`).

**Your requirements**
- **English stays the default, even for a fr-CM browser:** the dashboard page starts with `<html lang="en">`. `mountLanguagePreference` only switches to French when `ndahi-lang` is stored as `"fr"` (`app.js:529-531`). The browser-language fallback in `getPreferredLanguage` (`i18n.js:1925`) is never reached, because `currentLanguage()` uses the page's `lang` first (`shared-app/ui/dom.js:44-47`). None of the dashboard modules call `t()` without a language.
- **French works without storage:** `setPreferredLanguage` ignores storage errors (`i18n.js:1933-1935`). The event passes the chosen language and `applyLanguage` sets the page's `lang`, so every later render uses French (`app.js:536-538`).
- **The network banner stays honest:** the logic in `networkBannerState` is unchanged; only the labels are translated (`customer-app-v2/network-status.js:40-45`). The French text keeps every caution, for example "n'est pas confirmé ; ne rachetez pas", "ne donne pas accès à Internet" and "non confirmé" (`i18n.js:1077-1091`).
- **The tab bar and network status** use the current language (`customer-app-v2/portal-nav.js:94,201,209-213`; `customer-app-v2/active-bundle.js:11-25`).

**Minor, not blocking (P3):** if the refresh fails after switching to French, the tab labels and data cards stay in English until the next successful load. That's because `mountPortalNavigation` only runs on success. The French failure message explains what happened, so I don't count this as a P2.


## Independent verification

Codex ran the full unit suite (1,300 pass,41 PostgreSQL skips locally), syntax checks, both variants’ Account journeys, v2 dashboard/PWA journeys, and the expanded French browser regression. The latter now requires a real keyboard selection with retained focus, actual countdown text change, French pending-payment refresh/help, handled refresh failure, French browser with blocked storage/English default, six network states and unclipped five-tab navigation. All pass.
