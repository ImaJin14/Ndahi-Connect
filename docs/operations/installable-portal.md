# Installable customer portal (#138)

The manifest keeps the existing `/dashboard` app id and now starts at Dashboard.
The server still authenticates every private API call. The existing destination
allowlist strips unsafe `next` values and credentials; a missing/expired session
returns to web sign-in/packages. A remembered Wi-Fi candidate is not proof of
current connectivity: the shared connectivity/current-device flow checks it anew.
Installation never grants account or Wi-Fi access.

The optional dashboard offer uses the browser's `beforeinstallprompt` only after
an explicit tap. Rejected prompts leave the website usable; accepted/dismissed
choices are snoozed for 14 days, with actual standalone detection hiding the card.
iPhone/iPad users receive Safari Share → Add to Home Screen guidance. Android
WebViews receive normal-browser guidance; other browsers get optional menu
instructions without claiming installation support. Denied storage is tolerated.
No forced app launch, captive-window close, OS probe spoof or credential transfer
is attempted. Separate captive/browser/standalone storage may require sign-in.

## Offline, updates and privacy

The service worker never writes or reads cached navigation responses, private
APIs, checkout pages/keys, credentials, PDFs or account data. Activation removes
only obsolete `ndahi-shell-*` caches (including older checkout URL entries), not
other origin caches. Navigation remains network-only; online HTTP errors retain
their status. Fetch failures show a self-contained public 503/no-store shell with
Dashboard retry, package, sign-in/recovery and help links. These links need network
access. Cold-cache/zero-balance/pre-auth access depends on the real router allowlist;
the app does not create connectivity or promise purchases while offline.

Service-worker activation itself does not reload a client. Existing release checks
refresh an idle page, defer while payment/checkout/dialog work is pending and
protect dirty forms. Service-worker registration bypasses HTTP update caching.
No offline private-page reuse can pair an old dashboard with a new API. Existing
voucher/receipt history stays on the authenticated server; #142 handles delivery.
Push changes are coordinated in #139 rather than introducing another worker.

## Verification and release boundaries

`node --test test/installable-portal.test.mjs test/mobile-experience.test.mjs`
checks the served manifest/icons, all-page metadata, online/offline responses,
private URL cache exclusion and safe old-cache deletion.
`node scripts/check-dashboard-entry-journeys.mjs` includes PWA browser journeys:
real PIN/passkey/setup navigation, safe deep links, session restart, separate app
cookie jars, blocked storage, native prompt fixtures, iPhone guidance, offline
recovery and release deferral during payment. Prompt/UA/standalone fixtures in
Chromium are not proof of native installation or closed-app OS behavior.

Before release, record actual Android/iOS/iPadOS/Windows/desktop results (including
older supported devices): install/menu availability, captive browser switching,
separate-session sign-in, retained voucher access, app-switch return, offline/cold
cache/pre-auth/zero balance, update during a pending payment, native popup
handling and genuine internet access. No physical results, merge or deployment
are claimed by this implementation.

Browser capability references: [MDN installation guidance](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable),
[web.dev installation/storage restrictions](https://web.dev/learn/pwa/installation).
