# Login and Wi-Fi device reliability

The implementation supports storage-restricted captive browsers, reports router-confirmed device disconnection, and explicitly configures departure detection for managed HotSpot users. Application changes do not configure or test a live router until the updated application/bridge is deployed and a voucher is synchronized.

## Login behavior

The critical login, verification and router-handoff module graph targets Safari 12.1 / Chrome 73 or newer. It avoids optional chaining and nullish syntax and does not require `Object.fromEntries`, `replaceChildren`, `AbortSignal.timeout` or browser storage. Passkey code loads only when selected and supported. Optional notices or a blocked passkey download cannot prevent voucher/PIN initialization.

Return-path storage has a memory fallback; authenticator verification stays on the login page when session storage is denied. PINs are never stored. A lost login response triggers an authenticated account check, including the entered phone number, before continuing; one-use challenges are not blindly replayed. When modules cannot initialize, a classic-script loading message gives a reload/full-browser recovery path. Forms explicitly use POST and submission remains disabled until a handler is attached.

Connection preparation uses a two-minute total deadline and bounded requests, with an AbortController/timer fallback. Safe credential-status GETs may retry after a transient failure. The final HTTPS router form is submitted once per connection attempt, with credentials in its POST body and never in URLs or browser storage. A router rejection requires an explicit retry.

The application login challenge remains ten minutes; account sessions retain their existing timeout. New topology provisioning sets the owned HotSpot server's unauthenticated `login-timeout` to `10m`. Existing manually configured server timeouts are not changed automatically. Inspect those settings and capture the current values before any site-specific adjustment. The two-minute departure grace applies to authenticated device reachability, separately from pre-login timing.

## Disconnect behavior

`POST /api/account/wifi-devices/disconnect` accepts `{ mac, sessionId }`, checks the signed-in customer's active voucher and a router reading no older than two minutes, and returns `202` with an operation and the unchanged device list. Repeated requests for the same observed session coalesce. The slot remains occupied while its device is “Disconnecting…” or retrying.

`GET /api/account/wifi-devices` reports the latest successful router reading, per-device pending/failure status and recent completed outcomes. The customer can also read their own operation at `/api/account/wifi-devices/operations/<encoded operation id>`. Other customers cannot read it. Existing session, origin and production CSRF checks apply.

The worker wakes after the request commits. The target includes the voucher, owned router username, MAC, router session ID and observed session start. The router adapter rechecks those values, clears only the intended user's remembered login, removes the intended active session and reads back the result. A newer/replaced session is reported as superseded instead of being disconnected. Accepted deletes or unrecognized bridge responses are insufficient confirmation.

After confirmation, the worker removes only the matching cached session and queues fresh usage/device readings. A usage read started before that confirmation cannot restore an ended session; it schedules another reading. Failed operations retain the last device list and surface retry/support feedback. Existing retry limits, worker leases, admin recovery and alerts remain in use. No SQL migration is required; scoped operations use the existing command collection with a payload kind that older workers skip during rolling deployments.

Administrators have a paginated **Wi-Fi devices** list under **Customers and devices**, using the same session identities, pending states and scoped operation. Legacy app/browser session IDs are not treated as live MAC/session mappings. Old unscoped live disconnect jobs stop for review; refresh the Wi-Fi list and request a scoped operation rather than replaying them.

Normal disconnection leaves the bundle, its expiry and other devices active. A deliberate later reconnect is allowed subject to quota, validity and the actual router device limit. This is not persistent device blocking.

## Devices leaving Wi-Fi

New managed profiles are versioned as `ndahi-users-<limit>-presence-v1` and set:

```text
shared-users=<bundle device limit>
keepalive-timeout=2m
idle-timeout=none
```

The router removes unreachable authenticated sessions locally, even when the backend is unavailable. An idle but reachable device is not removed because its portal tab closed or it stopped transferring traffic. Brief loss of signal gets a grace period. Screen sleep and AP roaming must be tested on the actual devices before widening rollout.

The backend imports router device lists on successful usage reads, and open customer/admin device views refresh automatically while visible. Read failures retain the last list with a stale/unavailable indication. Router slot release and the portal's displayed update are separate events; normal display delay includes the next successful usage sync.

Reconciliation detects owned vouchers assigned to an old profile and queues a normal voucher sync to the versioned profile. Existing profiles are not overwritten; an existing versioned profile must match the expected limit and policy or the update fails. Active sessions can retain the profile settings they had at login: verify the effective timeout on a designated test session, reconnect test devices, and plan migration of remaining existing sessions before claiming all old sessions use the new policy. Backend-generated browser session IDs are not used to infer physical departure.

## Deploy and verify

1. Deploy the updated management bridge first if the site uses the HTTPS bridge. It adds `disconnectWifiDevice`; an older bridge cannot confirm the new operation. Saved direct REST connections use the updated adapter in the API.
2. Deploy the API/worker and customer/admin portals. Preserve the purchase-only coverage settings from PR #38. Leave the command worker and usage reads enabled.
3. Check failed legacy jobs under **Connections → Network commands**. Use fresh Wi-Fi device actions instead of replaying a job that lacks a session mapping.
4. On test accounts, verify profile reconciliation, the expected shared-user limit, `keepalive-timeout=2m`, `idle-timeout=none`, and the effective settings on a newly authenticated session. Do not edit unrelated users, profiles or the site's existing manual network topology.
5. On the Note 8 and iPad Air 2, record the OS/browser version. Test both the Wi-Fi sign-in popup and full browser: Continue, PIN, authenticator fallback, slow requests, router handoff and eventual internet access. Verify portal/API DNS, walled-garden asset access and router certificate trust. Never whitelist connectivity-check destinations simply to bypass captive detection.
6. Connect two test devices. Disconnect one manually and confirm its session/cookie removal, slot release, accurate UI status, unchanged quota and the other device's continued access. Repeat with the router temporarily unreachable, a page reload and a fresh login before a delayed retry.
7. Turn Wi-Fi off or leave coverage on one test device. Verify removal after the reachability grace and the next portal refresh. Test roaming, screen sleep, a closed portal, a backend outage and reconnecting within the grace period.

For rollback, retain the updated worker while any scoped disconnects are pending, or disable new requests and explicitly resolve those jobs before rolling it back. Older workers skip the new payload kind. Capture and retain the previous router user/profile assignments; rolling back application code does not revert an already-applied router profile. Reassign only owned affected users to their previous profiles if the pilot requires reversal, accounting for settings retained by already-active sessions.

## Automated verification

`npm test` covers ownership/CSRF, scoped operation visibility, retained slots, failure/retry, obsolete bridge replies, delayed commands, legacy-job safety, profile migration and successful-versus-failed presence readings. It also checks the critical module graph for unsupported syntax and runtime shortcuts.

`npm run check:hotspot:browser` includes storage denied, missing modern APIs, blocked optional passkeys, slow sign-in, inline authenticator fallback, startup failure, and pending/confirmed/failed disconnection. `npm run check:coverage` verifies automatic removal after a fresh reading and preservation of stale lists on failures. The regular billing, authorization and pending-state browser suite remains applicable.

These are isolated fixtures. Physical hardware behavior, certificate compatibility, sleeping-device reachability and live router timing require the pilot above.
