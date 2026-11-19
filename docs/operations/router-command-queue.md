# RouterOS command queue (NET-001)

Voucher sync, disconnect (from expiry, quota exhaustion, suspension, revocation,
or a customer/admin ending a device session), the inactive-session marker, and
the admin-triggered usage pull no longer call the MikroTik bridge synchronously
inside a request or webhook transaction. Each side effect is recorded as a
durable command and applied by a background worker outside any database lock.

Records use the existing `routerCommands` collection and normalized `events`
table (`kind = 'router_command'`). No database migration is required. Enqueuing
a command is a plain state write; no network I/O happens inside the transaction
that enqueues it, so a slow or unreachable router can no longer hold open the
single write lock the store uses for every request.

## Commands

- `sync_voucher`: register a voucher (id, code, plan, expiry, quota, device
  limit) with the router.
- `disconnect_voucher`: disconnect all sessions for a voucher.
- `disconnect_device`: disconnect one device by ID.
- `mark_inactive`: tell the router to drop sessions it considers stale.
- `sync_usage`: pull usage readings and apply them to vouchers monotonically
  (a reading is only ever used to raise `usedBytes`, matching the previous
  admin-triggered behavior). See [Router counter restarts](#router-counter-restarts).

A command's ID is derived from its action and target (`router:<action>:<target>`),
so enqueuing the same action for the same target while an attempt is already
queued, processing, or retrying is a no-op. Enqueuing again after a command has
finished (`processed`) starts a fresh cycle; total attempts still accumulate.

## Automatic processing

A background worker starts when the server listens and runs every 15 seconds
(`NETWORK_QUEUE_INTERVAL_SECONDS`), processing up to 25 due commands per pass.
`NETWORK_QUEUE_ENABLED=false` disables this background worker only; commands
are still enqueued and visible in the store. Two paths that previously blocked
the caller on the router call — resale voucher redemption/claim and the admin
usage-sync endpoint — still resolve synchronously: they enqueue and then
process that one command inline before responding, so their response shape and
timing are unchanged from before this change.

- `queued`: durable command awaiting processing.
- `processing`: claimed with a lease (router timeout + 15 seconds).
- `retry`: last attempt failed. Backoff is 30, 60, 120, 240... seconds,
  doubling per attempt and capped at one hour (five minutes for `sync_usage`,
  which keeps usage counting and quotas enforced).
- `dead_letter`: the attempt limit (`NETWORK_QUEUE_MAX_ATTEMPTS`, default 8 —
  roughly an hour of retrying) was reached, or the failure was permanent (a
  `sync_voucher` command whose voucher no longer exists dead-letters on its
  first attempt rather than retrying pointlessly). See NET-003
  (`router-command-dead-letter.md`) for review, alerting, and replay. A
  dead-lettered `sync_usage` (about 22 minutes of failed reads) alerts as usual,
  then the usage scheduler queues it again after a 15-minute cool-down
  (`network.usage_read_resumed` event); before 18 November 2026 usage stopped
  counting until an operator replayed it.
- `processed`: the router accepted the command.

Voucher-affecting commands (`sync_voucher`, `disconnect_voucher`) set
`routerSyncStatus` on the voucher: `pending` while queued/retrying, `dead_letter`
if the command exhausts its attempts, and `synchronized` or `disconnected` once
the worker succeeds. `routerError` holds the last failure reason. The command's
completion and the voucher's status commit atomically, so a crash between the
router call and the completion transaction leaves the command `processing`
with a lease that expires and is safely reclaimed — it does not leave a
voucher's router status stuck on a lie.

## Router counter restarts

A reading is the hotspot user's own counters plus its live sessions, i.e. what
the router has counted since those counters last started. RouterOS restarts
them from zero when the router reboots (for example after a power cut) or the
hotspot user is re-created. Since 18 November 2026 the worker notices this when
a user's own counters (`counterBytes`) go down, or when a voucher's total stays
below its recorded usage for 45 seconds or more (one lower reading is normal: a
session ending between the router's two reads is missed once). It then:

- keeps the usage counted so far in `routerUsageOffset` and adds new readings to it;
- records `routerCountersRestartedAt` and a `network.usage_counters_restarted` event;
- re-syncs an active fixed-quota voucher, so the router's `limit-bytes-total`
  becomes the data actually left instead of the whole quota again.

Before this, recorded usage froze until the new counters passed it, and the
router allowed the full quota again. Admin voucher detail shows when usage was
last read from the router, and warns when an active bundle has not been read for
ten minutes.

## Verification and limits

Run `node --test test/router-queue.test.mjs test/integration.test.mjs
test/postgres-schema.test.mjs test/state-migration.test.mjs test/retention.test.mjs`,
`npm run check`, and `npm test`. Tests use a fake router adapter; no live
MikroTik bridge is contacted. Tests cover idempotent enqueue, requeue after
completion, bounded exponential backoff, restart/crash recovery via an expired
lease, that a hanging router call no longer blocks the HTTP response, and that
a fresh server picks up commands enqueued before it started.

Before production rollout, confirm queue drain and `routerSyncStatus` recovery
against a MikroTik bridge in staging. No live-router or deployed-environment
verification is implied by local tests. NET-002 (RouterOS reconciliation)
repairs drift through this same queue; NET-003 (`router-command-dead-letter.md`)
adds the attempt limit, alerting, and operator replay controls described above.
