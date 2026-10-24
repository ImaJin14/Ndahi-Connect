# Customer entry destinations (#135)

Ordinary voucher/PIN, passkey and completed PIN setup land on Dashboard Home.
Dashboard reload, browser history and installed-app restart retain the account's
server session and reuse the same current-device/connection evidence. A paid
bundle is not proof that this device has internet access.

Only validated intended destinations are retained: known Dashboard tabs/setup
panels and authenticated renew/switch pages. Explicit account-settings links
(`/login?account=1`) retain their stated intent; this is not the ordinary sign-in
default. Stored intended paths are consumed once. External, protocol-relative,
encoded backslash/control, malformed and login/verify/hotspot/pair loops are
rejected. Arbitrary query fields and automatic checkout triggers are discarded.
All target routes still enforce server authentication and authorization.

A fresh #133 contract controls whether a captive sign-in needs a Wi-Fi
completion step: confirmed ingress, an active subscription, reachable router,
validated device candidate and no current HotSpot authentication. Candidate
query parameters alone cannot authorize Wi-Fi. Unknown/unavailable evidence
keeps account access on Dashboard; confirmed expired/exhausted bundles show
Bundles unless a necessary payment/settings destination was requested.

Existing onboarding stays intact: the public root remains the package catalogue;
checkout recovery and payment confirmation still exchange the request-bound PIN
setup/login handoff. They are not bypassed by a redirect. The existing onboarding
completion passes through the normalized hotspot entry when configured; an
already-connected, off-network or unidentified account proceeds to Dashboard
without duplicate router activation. A failed router check with a candidate keeps
an explicit retry and Dashboard escape. Main-device approval, owner recovery,
scoped session disconnect and lost-reply reconciliation remain server enforced.
Guest approval grants Wi-Fi only; it does not create an account session or expose
Dashboard data.

Tests cover real PIN/passkey/setup, safe/unsafe intended paths, Home restoration,
mobile account access, evidence failures, lost sign-in replies, existing connected
captive return and approval isolation. Existing provisioning, paid onboarding,
captive completion and delayed-router suites remain part of standard CI. These
are local API/browser/synthetic-router checks. Physical installed/native captive
behavior and on-site RouterOS/AP acceptance remain separate release checks;
see trusted-connectivity.md. No merge, deployment or router changes are implied.
