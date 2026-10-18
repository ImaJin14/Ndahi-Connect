# Connection and device-session reliability plan

Date: 2026-10-18. Status: application and bridge implementation completed on `feat/connection-reliability`; deployment and physical-device/router validation remain. See [rollout and behavior](connection-reliability.md).

## Scope and order

The customer reported that a Samsung Note 8 and iPad Air 2 load the login page but the login button does not work. Fix this before tightening device-departure cleanup. Follow with reliable manual disconnection and automatic release of departed devices' slots. Preserve the purchase-only network restriction delivered in PR #38.

| Priority | Change | Customer outcome |
| --- | --- | --- |
| P0 | Compatible, recoverable voucher/PIN login and router handoff | Login controls work on the affected browsers and failures explain how to recover. |
| P1 | Confirmed manual disconnect with accurate device slots | “Disconnected” means the router has actually ended the intended session. |
| P2 | Router-managed departure detection and fresh device lists | Devices that leave Wi-Fi release their slots automatically after a short grace period. |

Deliver these as separate changes so a router policy rollout does not delay the login fix. Keep PR #38 focused on portal access and purchases.

## Evidence before implementation

| Finding | Evidence | Implication |
| --- | --- | --- |
| Login initialization requires session storage. | `customer-app/login.js` reads `sessionStorage` before registering the submit handler and before enabling `#loginSubmit`. | If access throws, the page remains visible but Continue stays disabled. This matches the reported symptom, but storage behavior on the actual devices is not yet confirmed. |
| The handoff requires `AbortSignal.timeout()`. | `customer-app/hotspot.js` calls it directly for access and credential requests. | An unsupported browser throws before sending the request. This is a separate blocker after sign-in. MDN's compatibility data lists Safari support starting at 16; an iPad running Safari 15 needs a fallback. |
| More recent APIs are assumed by the critical path. | Form serialization uses `Object.fromEntries`; error rendering uses `replaceChildren`; modules contain optional chaining. | Missing runtime APIs need alternatives. Older JavaScript syntax support needs a compatible build or entry point; a runtime polyfill cannot fix a parse failure. Device model alone does not identify the installed browser version. |
| Optional passkey code is on the initial loading path. | `login.html` loads a classic passkey bundle before the login module. | Load it on demand so downloading optional functionality cannot delay voucher/PIN initialization. |
| Authentication timing is not uniformly too short. | The phone/voucher challenge lasts 10 minutes; dashboard sessions default to 30 minutes with refresh. The handoff permits 20 pending responses, with a 2-second delay and 15-second request timeouts. | Fix initialization and compatibility first. Measure the actual router and browser timing before extending authentication lifetimes. The handoff currently uses an attempt count, not a clear total deadline. |
| Disconnect success is optimistic. | `/api/account/wifi-devices/disconnect` removes the row and reports success when it queues the command. | The displayed slot count can disagree with the router during delays or failures. |
| Router disconnect targeting is broad. | `disconnectDevice()` receives a MAC and removes matching sessions/cookies for any NDAHI-managed user. | Ownership must also be enforced at execution time, against the expected voucher and session. A delayed retry should not terminate a later login. |
| Departure policy is implicit. | Managed user profiles explicitly set only `shared-users`; keepalive and idle policy are not configured. | Make reachability-based cleanup explicit and validate it against the deployed router. |
| The device list eventually stops refreshing. | The dashboard polls after login for up to two minutes, stopping after a fresh reading. | A page left open can continue showing a device that later leaves Wi-Fi. |

Two isolated executions of the original source confirmed the storage-denied startup failure and the missing-timeout handoff failure. These used Node VM stubs, not the physical devices. The implemented fixes now have passing browser fixture coverage, including denied storage and missing APIs. The exact failure on each device still needs its OS/browser version and a real-device check.

## P0: Restore dependable login on older devices

### Implementation

1. Add small shared compatibility helpers for form serialization, safe DOM replacement, request timeouts and optional storage. Keep return paths and login notices in memory when storage is unavailable. Do not persist PINs or voucher credentials as a workaround.
2. Initialize voucher/PIN handlers independently of optional notices, telemetry, passkeys and installation features. Only enable Continue after its handler is attached. Preserve the protection against native GET submission of credentials.
3. Add a small compatibility bootstrap that can show a useful loading/unsupported-browser message when the main module fails to initialize. If the installed browser cannot parse the entry point, provide a compiled entry point appropriate to the agreed browser baseline; do not attempt to solve syntax support with a runtime shim.
4. Replace direct `AbortSignal.timeout()` calls with a helper using `AbortController` and a cleared timer where supported. Provide a bounded fallback for supported browsers without abort support; ignore late results so they cannot trigger a second router submission.
5. Load the passkey library only when supported and selected. Voucher/PIN login remains usable even if passkeys, browser storage or installation APIs are unavailable.
6. Give the connection page an explicit total preparation deadline and distinguish slow provisioning, request timeout, expired account session and router rejection. Automatically retry safe status reads within that deadline. Do not blindly replay one-use authentication completion or the router credential POST after an ambiguous timeout.
7. Preserve phone/voucher input in the current page while recovering from a transient error. On an ambiguous login response, check whether an authenticated session exists before asking the customer to start again. Keep PINs out of durable storage, logs and URLs.
8. Provide a visible “Try again” path and instructions for opening the portal in the full browser while remaining on NDAHI Wi-Fi. Do not assume cookies or session storage transfer from the captive popup to Safari/Chrome.
9. Check unauthenticated DNS, portal/API walled-garden access, hashed script paths, router HTTPS certificate trust and captive-portal detection on both devices. Do not whitelist internet-connectivity probe destinations simply to suppress the captive popup.

### Timing policy

Keep three clocks separate:

- **Before login:** retain the existing 10-minute application challenge. Inspect the active HotSpot's unauthenticated `login-timeout` and related host settings; align an owned server's login grace with the login journey if needed. No broad router timeout changes without a captured configuration and device validation.
- **During connection preparation:** use a clear, bounded deadline with recoverable status, rather than a silent spinner or an attempt-count-only loop. Start with a proposed 2-minute preparation budget and tune from actual timings.
- **After connection:** use the reachability grace described under P2. It must not treat an unfinished login or a closed portal tab as a departed authenticated device.

### Acceptance

- Both devices reach the PIN step, complete sign-in and establish internet access in their full browser and Wi-Fi sign-in popup.
- Denied storage, absent optional browser APIs and a failed passkey download cannot leave Continue permanently disabled.
- Slow requests and interrupted responses produce a recovery action and never submit credentials through a GET URL.
- Test missing APIs explicitly and check syntax against the chosen browser baseline. A modern browser with an old user-agent string is not an old-browser compatibility test.

## P1: Make manual disconnect reflect router-confirmed state

### Implementation

1. Persist an operation scoped to customer, voucher and the observed router session. Return `202 Accepted` with an operation identifier instead of reporting completed disconnection immediately.
2. Keep the device visible as “Disconnecting…” and continue counting its slot until router confirmation. Show pending state consistently on the dashboard and the full-slot connection page, including after a page refresh.
3. Wake the durable worker immediately after the transaction commits. Keep its existing lease recovery, bounded retries and idempotency. Network I/O stays outside database transactions.
4. Pass the expected voucher/user and session identity through the saved-router adapter and HTTPS bridge. Recheck those values before mutation. Treat an already-absent session as completed and a superseded session as a separate outcome; do not target a newer login with a stale MAC-only command.
5. Remove only the intended active session and remembered login for that user/device. Read back router state before declaring completion, then import a fresh device list and counters.
6. Expose only the signed-in customer's operation status. Show “Router unreachable—retrying” during temporary failures and a clear failure/support action when retries are exhausted. Reuse admin alerting and replay controls.
7. Use trusted router identities for customer and admin actions. If the legacy browser-device-ID path cannot map to a live router session, explain that it cannot perform the operation rather than returning apparent success.

Normal Disconnect ends the current internet session and frees its slot after confirmation. The bundle stays active. A deliberate later reconnect is allowed when a slot is free; persistent device blocking is a separate feature.

### Acceptance

Test delayed router responses, loss of the response after successful removal, repeated clicks, expired worker leases, router outages, account isolation and a fresh login occurring before an old retry executes. Other devices and voucher usage must remain correct. The portal must never advertise a slot as free before the router does.

## P2: Automatically release devices that leave Wi-Fi

### Implementation

1. Apply an explicit **2-minute keepalive timeout** to NDAHI-managed HotSpot user profiles as the initial reachability grace. Use router reachability to detect departure; do not use page visits, browser heartbeats or lack of data transfer.
2. Keep an idle but reachable device connected. Configure the owned profile's idle policy deliberately so it does not undermine that behavior. Validate screen sleep and AP roaming on the affected devices before adopting the timeout for every customer.
3. Preserve the bundle and remaining data when a device leaves. Reconnection remains subject to bundle validity and the actual device limit.
4. Reconcile the portal's device list from successful router reads. Refresh while the device section is visible, pause unnecessary polling in the background, and refresh on return. Show the last successful update and stale/unavailable status during a router or tunnel outage; a failed read is not an empty device list.
5. Define migration for existing `ndahi-users-*` profiles and already-active sessions. Prefer a versioned managed profile where ownership is uncertain. Existing names alone must not authorize overwriting arbitrary profile settings. Document which sessions require a fresh login for profile changes to apply.
6. Let the router perform departure cleanup locally even if the cloud backend is unavailable. The backend learns the result on its next successful sync.

The target is roughly two minutes of unreachability for slot release on a healthy router, followed by the next successful backend refresh for the portal display. These are separate events; queue or connectivity problems can delay the displayed update.

### Acceptance

On the real MikroTik, connect two designated test devices, turn Wi-Fi off on one or move it out of range, and confirm its HotSpot session disappears and another device can use the freed slot. Repeat with a brief signal interruption, AP roaming, screen sleep, a closed portal tab, an unavailable backend and a returning device. Confirm the other device, bundle expiry and remaining balance remain correct.

## Release sequence

1. Ship P0 independently and verify the Note 8 and iPad Air 2. Record OS, browser/WebView version, captive-popup/full-browser context, and the exact step that failed. Avoid collecting phone numbers, voucher codes, PINs, tokens or cookies in diagnostics.
2. Ship P1 with compatible API, worker and bridge changes. Reject unsupported bridge capability explicitly. Preserve or safely supersede existing queued MAC-only commands rather than silently changing their meaning.
3. Pilot P2 on designated NDAHI profiles and test accounts, with the old profile values captured for rollback. Validate existing sessions before widening the rollout.
4. Run focused adapter/API/browser tests and the existing regression suite for each phase. A real-device and router pilot is required to verify physical connectivity and older-browser behavior that local mocks cannot establish.

## References

- [MDN: AbortSignal.timeout](https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static)
- [MDN browser compatibility data: AbortSignal](https://github.com/mdn/browser-compat-data/blob/main/api/AbortSignal.json)
- [MikroTik HotSpot user profiles, keepalive and timeout behavior](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/)
- [Existing external portal deployment procedure](external-hotspot-login.md)
- [Existing durable router queue](router-command-queue.md)
