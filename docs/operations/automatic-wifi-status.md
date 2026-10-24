# Automatic current-device Wi-Fi status (#134)

Extends the existing verified app/router association and scoped disconnect queue;
no new MAC, account or Wi-Fi authorization mechanism is introduced. The current
API includes #133's shared connectivity contract. A public API response, paid
bundle, passkey or online browser cannot establish Connected.

The current card checks every 10 seconds when stable, every two seconds during
server-confirmed Connecting/Disconnecting, and backs off API failures through
10/20/40/60 seconds. Identification retries retain the separate 30-second bound.
Hidden/offline/non-Home views pause; visibility, history restore, online and tab
changes resume a single read. Cancellation propagates through requestJson and
covers reading a response body. A generation fence discards obsolete replies;
no new poll overlaps a pending poll. Unmount removes listeners and timers.

Connected pulses green; confirmed Disconnected red; accepted router operations
yellow. Unknown/stale/unavailable/failure remain neutral and retain last-check
information. Local POST submission alone never starts a yellow transition.
Text and polite status announcements accompany color; reduced motion disables
pulses. Destructive controls require a fresh exact session. Disconnect continues
to send MAC, router session ID and start time; old commands cannot target a
replacement session. Saved approval and the separate main-device owner proof
are unchanged.

Validation: scheduler/cancellation/API isolation regressions, real-API current
Wi-Fi/installed-app/lost-reply journeys, and a deterministic Chromium timing/UI
suite cover hidden/offline/resume, request counts, all transitions, failures,
replacement session, reduced motion and unmount. These are synthetic router
fixtures, not physical AP/router acceptance. Follow trusted-connectivity.md for
on-site verification; no deployment or router changes are implied by this PR.
