# Admin devices, recovery and installable app

The admin app uses **Home · Devices · Vouchers · Payments · More** navigation. Phones have a bottom bar, with safe-area spacing; wider screens have a sidebar. More contains customers, bundles, connections/security, audit and owner-only network setup. Destinations use URL hashes, so reload and Back/Forward preserve the selected view. Navigating between views retains unfinished form values. Existing server-side authorization still applies.

## Live Wi-Fi sessions

In live-router mode the Home active-session count and Devices rows use the same router-reported observations. Legacy browser sessions remain under Customers as labeled history and do not establish a physical connection. Devices can be searched, filtered and paginated; a repeated observation of the same session counts once.

Fresh readings are valid for two minutes. Older device rows remain visible with a stale indication and disabled disconnect controls; a failed read never establishes that the network has zero devices. Home shows an unknown count when no current reading is available. A successful reading reporting no devices clears the current list. Router departure detection and portal display refresh remain separate operations.

Owner/operator **Refresh devices** requests the existing durable usage-read job. Repeated requests coalesce, and a successful read is not immediately requeued within five seconds. The visible summary and device rows refresh every five seconds; these reads do not each contact the router. Normal background router reads retain their existing interval. A failed read displays its status and a controlled **Retry router reading** action. Fix bridge reachability/credentials before retrying. The existing Connections → Sync usage action remains available.

The read API is `GET /api/admin/wifi-devices`; explicit refresh is `POST /api/admin/wifi-devices/refresh`. Mutations require an owner/operator session and existing origin/production CSRF checks. Automatic refresh preserves previous rows on a temporary records-fetch failure and does not overwrite an actively edited search field.

## Disconnect recovery

New disconnects use voucher, MAC, router session ID and the observed session start. A slot stays occupied until the router confirms removal/absence. Delayed commands cannot disconnect a newer session. The updated customer/admin clients also submit the observed start, so a refreshed reading with a reused router ID cannot silently redirect their action.

An obsolete live `disconnect_device` job has no trustworthy physical-session mapping. It cannot be replayed through either UI or API. **Refresh devices** opens the current device list for an explicit new scoped action. **Mark obsolete** resolves only failed legacy disconnects, records an audit event, and retains attempts, error, target and resolution timestamp. It does not disconnect a device or assert that the device is offline. Other command failures retain their normal replay workflow.

The resolution endpoint is `POST /api/admin/network/commands/resolve` with `{ "commandId": "..." }`. It is idempotent and owner/operator-only. Resolution is distinct from successful router processing; retained command/audit history records the difference. Live reconciliation does not create new unscoped disconnects from application-session UUIDs.

For the reported legacy jobs, obtain a fresh router reading, request a scoped disconnect only if the intended device is still connected, and explicitly mark the old job obsolete. Do not bulk replay old UUID targets or convert them into new device identities automatically.

## Installation and updates

The admin site has its own **NDAHI Admin** manifest, NA icons and standalone launch at `/dashboard`. Open More for installation. Supporting browsers expose **Install app** when their native prompt is available; Apple devices receive Safari Share → Add to Home Screen instructions. Other browsers can use their installation menu or keep using the website. HTTPS is required in production and the device/browser controls installation.

The service worker provides a neutral offline retry page. It does not cache customer/payment/device records or API responses. Reopening the app still requires the normal admin session. The retry link requests a fresh page even if the offline URL contained a navigation hash.

The customer and admin apps share release-check logic. Idle open apps check every minute and on visibility/online events. New versions wait for unsaved edits, pending actions, passkey/MFA setup, unconfirmed network jobs, displayed backup secrets and generated voucher codes. Download the generated CSV and choose **Close codes** to release that output before an automatic update. A manual refresh asks before discarding edits and remains unavailable during an active operation.

Regenerate admin icons with `CHROME_PATH=/path/to/chrome node scripts/generate-app-icons.mjs --admin`; customer icon generation remains the default.

## Verification and rollout

`test/admin-live-devices.test.mjs` reproduces count/list disagreement, duplicate observations, stale/empty/failed readings, obsolete-job replay rejection and resolution history, scoped reconciliation, reused session IDs and HTTP authorization/CSRF/audit checks. Existing router and connection tests remain applicable.

`npm run check:admin:app` covers phone/desktop navigation, Back/reload, counts, legacy-job recovery, pending/successful/failed readings, confirmed disconnects, roles, install assets and prompts, Apple instructions, offline retry without record caching, and safe update deferral through edits/network setup/generated codes. It is included in `npm run test:browser`. Existing authorization, pending, network-setup, hotspot and portal journeys also exercise the changed paths.

Deploy the updated management bridge first if the existing bridge lacks `disconnectWifiDevice`; deploy API/worker before admin/customer apps. No SQL migration is required. Pilot on designated test devices: verify one scoped disconnect, continued access on another device, departure after the router's existing reachability grace, failed-read feedback, installation and updates during an unfinished task. Local mock/browser checks do not verify physical-device behavior or the currently deployed router.
