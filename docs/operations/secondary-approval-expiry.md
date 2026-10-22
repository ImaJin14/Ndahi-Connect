# Secondary saved-approval expiry (#80)

The policy removes a secondary device's saved approval after 30 minutes of
accumulated, confirmed router absence. Main-device approval is exempt. Closing
the app, screen sleep, stale list timestamps and missing router responses do not
prove disconnection. Saved approval does not itself reserve a connected slot.

## Observation and generation guards

Approval generations survive reconnects and change when a revoked grant is newly
approved. A reconnect also advances an observation revision, fencing reads that
started before it even within one clock tick. The worker captures that revision
under the queue claim transaction and rechecks it when committing an observation.

Only complete device readings for all relevant account vouchers can advance
absence. The HotSpot adapter samples system uptime around the full read, attaching
start/completion/boot evidence. A reboot during a read, denied uptime permission,
an old bridge without evidence, malformed/partial/duplicate readings, older
responses, failed reads, process restarts or gaps over two minutes establish or
pause a baseline; their unobserved interval never accrues. Previously observed
absence is retained. A fresh presence resets the accumulated absence.

At the boundary, the locked state transaction checks the current router, grant,
main-device exemption and queued/in-flight/unresolved access work. It invalidates
the app association, cancels unused access codes and queues one generation-bound
cleanup command, with the old voucher targets captured rather than retargeted to
a new bundle. Its new job kind is ignored by older workers during rolling release.

Cleanup uses the existing bounded, leased removal path. Each router mutation
checks its deadline and targets exact rows matching the old NDAHI voucher/MAC.
Approval remains blocked until cleanup is confirmed; retry/dead-letter work never
silently frees a slot or enables reapproval. Claim and completion both recheck
generation/router/main identity. A superseded worker cannot rewrite a newer
grant's connection projection. A single Devices notice per generation reports
approval expiry and pending, confirmed or failed cleanup. Its historical name is
captured at expiry; retries update that same notice.

## Rollout control

`WIFI_SECONDARY_EXPIRY_ENABLED` defaults off. Only the exact value `true` enables
new automatic expiries, absence observations and observation scheduling for
expired-only accounts. The API passes this explicit configuration to its worker;
process-global environment defaults cannot override a supplied API environment.
Normal usage/quota accounting continues while expiry is off. Queued revocations
continue to reconcile even after the flag is turned off. Disabling the flag does
not restore a revoked grant or mark cleanup confirmed.

1. Deploy the compatible API/worker and the updated bridge where applicable,
   leaving the flag unset. Verify normal accounting, main-device reconnection
   and scoped removal. Older bridges may continue accounting but cannot supply
   trusted expiry evidence.
2. Ensure the management account can read `system/resource` uptime and complete
   HotSpot users/sessions. Verify polling stays below the two-minute maximum gap;
   interval gaps freeze expiry rather than guessing absence. Confirm clocks.
3. In staging, enable the flag and exercise the physical pilot below. Record the
   exact API/bridge/frontend revisions and actual results separately from CI.
4. Only after reviewed rollout authorization, enable the production policy.
   Existing grants start from a new trusted baseline; timestamps are not backdated.
5. To stop new expiries, turn the flag off. Inspect unresolved cleanup commands
   through existing network incident/replay controls; never clear their barrier
   manually to make a device appear connected or free a slot.

## Verification record

Automated boundary, reconnect, main exemption, stale-read, boot/outage, generation,
scoped router cleanup, rollout and notification regressions are in
`test/secondary-approval-*.test.mjs`. The PostgreSQL case tests competing boundary
transactions, rollback before commit, persisted duration across restart, concurrent
cleanup claims and a lost completion transaction followed by lease recovery.
Run it with `TEST_DATABASE_URL`; a skipped local database test is not a pass.
Existing quota/pairing/current-Wi-Fi/history regressions remain applicable.

Physical acceptance is pending. Use a real secondary device and retain main
access throughout: observe 29:59/30:00, return before the boundary, reboot router
and backend during absence, verify no outage duration accrues, confirm active
rows/cookies are cleared, complete fresh main-device approval/code, and check a
new session is unaffected by a delayed cleanup retry. Record actual deployment,
strict smoke and this pilot before claiming live behavior is complete.
