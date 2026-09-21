# RouterOS reconciliation (NET-002)

Every voucher and network session carries a status the app considers
authoritative (`active` for a voucher that should be enabled and reachable,
`online` for a session that should currently be connected). The router command
queue (NET-001) keeps the router in sync with that status as changes happen,
but a router reboot, manual change, or lost command could still leave the
router disagreeing with the app. Reconciliation is a periodic check that finds
that drift and repairs it.

## What it compares

A reconciliation pass calls the router adapter's `readState()` — outside any
database transaction, mirroring the payment reconciler — which returns the
router's own view: `{ vouchers: [{ voucherId, enabled }], sessions: [{
deviceId, active }] }`. It then compares that against every voucher and
session in the app:

- Voucher `active` locally but not `enabled` on the router → `missing_on_router`.
  Repaired by enqueuing `sync_voucher` (NET-001).
- Voucher not `active` locally (expired, exhausted, revoked, suspended,
  renewed, switched, or still `available`) but `enabled` on the router →
  `still_enabled_on_router`. Repaired by enqueuing `disconnect_voucher`.
- Session `online` locally but not reported `active` by the router → the
  router is authoritative for actual connectivity, so the session is corrected
  to `inactive` locally. No network command is needed; the router already
  agrees there is nothing connected.
- Session not `online` locally but reported `active` by the router →
  repaired by enqueuing `disconnect_device`.

A voucher or session with an unresolved command already queued, processing,
retrying, or dead-lettered for the relevant action is not re-reported or
re-enqueued — the queue is already handling it, or (for `dead_letter`) an
operator already has it to review under NET-003. This keeps a normal, brief
propagation delay between a purchase and the router picking it up from ever
appearing as reconciliation drift, and keeps a dead-lettered command's
attempt history and one-time alert intact instead of silently resetting it
every pass.

Router-side vouchers or sessions with no matching local record are not acted
on: there is no safe repair without knowing what they represent, so they are
left for provider/router-side review rather than guessed at.

## Reporting and repair

Findings are recorded on the voucher (`voucher.networkReconciliation = {
checkedAt, issue }`) and exposed at `GET /api/admin/dashboard` as
`networkReconciliation.issues`, visible under **Connections → Network
reconciliation** in the admin dashboard. An issue is logged once as
`network.reconciliation_issue` when it first appears (not on every pass while
it persists) and `network.reconciliation_resolved` when it clears, avoiding
event-log spam from an unresolved finding being seen every interval.

Repairs reuse the same durable, idempotent command queue as NET-001 — this
module never calls the router directly. That means repairs inherit the
queue's crash recovery and bounded backoff; reconciliation itself does not
retry a failed `readState()` call beyond the next scheduled pass.

## Automatic processing

A background pass starts when the server listens and repeats every 300
seconds (`NETWORK_RECONCILIATION_INTERVAL_SECONDS`), enabled by default only
in production (`NETWORK_RECONCILIATION_ENABLED=true`/`false` overrides in any
environment, matching the payment reconciler's convention). A router adapter
that does not implement `readState()` causes a pass to skip rather than
report every voucher as drifted.

## Verification and limits

Run `node --test test/router-reconciliation.test.mjs test/router-queue.test.mjs`,
`npm run check`, and `npm test`. Tests use a fake router adapter; no live
MikroTik bridge is contacted. Tests cover missing/still-enabled voucher drift
and its repair and resolution logging, in-flight commands suppressing a
duplicate report, a stale session being corrected locally, a fully matched
snapshot producing no findings, an adapter without `readState` being skipped,
and concurrent passes coalescing into one run.

`readState()` is a new contract on the router adapter (`lib/routeros.mjs`);
the mock adapter returns an empty snapshot and the live adapter posts to
`/ndahi/readState`. Before production rollout, confirm the live MikroTik
bridge implements this endpoint and returns the documented shape, and confirm
reconciliation findings and repairs against it in staging. No live-router or
deployed-environment verification is implied by local tests. NET-003
(`router-command-dead-letter.md`) handles commands that keep failing after
repair is attempted here, with dashboard visibility, alerting, and replay.
