# Completing approved-device captive Wi-Fi sign-in (#63)

## Application behavior

The restricted `/pair` flow waits for main-device approval, code redemption and
router confirmation. It then makes one top-level GET to the deployment's existing
HTTPS `HOTSPOT_LOGIN_URL`, with only these parameters:

```text
dst=https://<this-portal>/wifi-connected.html
popup=false
```

RouterOS serves its native `alogin.html` path when `/login` is requested by an
already-authorized client. This restores the browser-side success handoff that
was absent when the server authorized the guest through the RouterOS API.
There is no username/password submission, new grant or extra device slot.
`popup=false` suppresses the router's separate status popup when its template
honors that setting; it is not a command to close an OS captive assistant.

The API's `completionReady` flag distinguishes historical operation success from
a recent, still-valid completion opportunity. It requires confirmation within
the existing two-minute reading window, an active bundle/account and saved grant,
the current router revision, the matching observed MAC/login address and no
pending disconnect/removal. Old successes offer a fresh request instead of
automatically completing sign-in. Pending attempts retain their recovery key;
terminal results clear it before any handoff. No key, code, phone, voucher, device
candidate, account destination or caller-provided redirect enters the handoff.

The pairing page offers Done and explains the device's own Done/Close control.
Missing or invalid router configuration falls back to the local completion page.
That public page gives closing/troubleshooting instructions and an explicit
Wi-Fi sign-in link; it does not assert live connection status, access the account,
redirect on reload or force-close a normal browser tab. The owner `/hotspot`
journey retains its dashboard/main-device prompt.

OS dismissal depends on the operating system recognizing an unrestricted
connection. Website JavaScript cannot guarantee closure of an OS-owned window.
Router authorization alone also does not establish working DNS or internet
routing. The fallback remains necessary even after a successful handoff.

## Site checks before rollout

These checks are not performed by automated fixtures. Inspect the actual active
HotSpot profile and its effective HTML directory, including any override. Preserve
backups and the existing custom landing pages before proposing changes.

1. From the affected guest device, confirm the configured router hostname resolves
   locally and has a trusted TLS certificate. With that device authorized, request
   `/login?dst=https%3A%2F%2F<portal>%2Fwifi-connected.html&popup=false` and verify
   `alogin.html` honors `dst` and does not loop to account sign-in. This PR installs
   no router files and resets no HotSpot HTML directory.
2. If a DHCP/RA Captive Portal API URL is advertised, inspect that exact URL from
   the same guest device before and after authorization. Preserve certificate
   validation. Verify `Content-Type: application/captive+json`, a current private
   response and per-client `captive: true` before access / `false` after access.
   Inspect the effective `api.json` template and advertisement if they disagree.
   A request from a wired administrator PC is not proof of the phone's state.
3. Observe the affected OS's actual connectivity probes and DNS results. Once
   authorized, they must reach their real destinations and receive their expected
   responses. Check existing selective direct/tunnel routes if authorization is
   successful but validation or browsing fails. Portal/API reachability is not
   an internet check, because those services are intentionally accessible before
   authentication.
4. Never spoof a successful probe, exempt probe destinations before authorization,
   hardcode a global `captive: false`, remove quota enforcement, or tunnel all
   traffic merely to hide the sign-in window. Any site configuration repair needs
   its own reviewed diff and rollback; do not blindly replace `api.json` or
   `alogin.html`.

## Acceptance and evidence

Automated checks:

- `npm test`: current grant/bundle/router/freshness gates, quota/slot/replay
  regressions and account isolation.
- `npm run check:captive:browser`: 320px completion/fallback, denied storage,
  redirect validation, secret cleanup, wrong code, all non-success states,
  historical success, direct public visits and reload without loops.
- `npm run check:hotspot:browser`: real API plus synthetic router verifies code
  transfer, one completion after confirmation, lost-response recovery, paid
  signup, approved guest reconnect after session loss, owner/main preservation,
  and an unknown third device held to the shared slot limit.

Physical release acceptance remains open. Disable mobile data during tests:

| Device/context | Actual browsing after approval | Automatic dismissal or working Done/Close | Wi-Fi retained after closing | Approved reconnect after router/AP restart |
| --- | --- | --- | --- | --- |
| iPhone captive assistant | Pending | Pending | Pending | Pending |
| iPad / supported older iPad captive assistant | Pending | Pending | Pending | Pending |
| Android / Galaxy Note 8 captive assistant | Pending | Pending | Pending | Pending |
| Laptop Wi-Fi sign-in | Pending | Pending | Pending | Pending |
| Normal Safari/Chrome/Samsung Internet | Pending | Tab stays usable | Pending | Pending |

Also test wrong/expired/declined codes, revoked/exhausted access, router failure,
blocked storage and interrupted replies. Record OS/browser version, API/portal
release, effective router template behavior, authorization, validation outcome and
dismissal separately. Keep credentials, approval codes and bearer fragments out
of screenshots/logs. Automated browser fixtures do not emulate OS dismissal,
router TLS or real internet access.

For rollback, revert the application PR and redeploy API/customer services.
No schema migration, account reset or router rollback is introduced here.

## Primary references

- [RouterOS HotSpot servlet and login completion](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/hotspot-customisation/)
- [RouterOS per-client captive status](https://manual.mikrotik.com/docs/authentication-authorization-accounting/hotspot-captive-portal/)
- [Apple captive detection and status advertisement](https://developer.apple.com/news/?id=q78sq5rv)
- [RFC 8908 Captive Portal API](https://datatracker.ietf.org/doc/html/rfc8908)
- [Browser window closing restrictions](https://developer.mozilla.org/en-US/docs/Web/API/Window/close)
