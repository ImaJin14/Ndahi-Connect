# Network command dead-letter handling (NET-003)

The RouterOS command queue (NET-001) retries a failing command with capped
exponential backoff. This adds a limit to that: after `NETWORK_QUEUE_MAX_ATTEMPTS`
attempts (default 8, roughly an hour of retrying at the backoff schedule), or
immediately for a failure that retrying cannot fix (a `sync_voucher` command
whose voucher no longer exists), the command stops retrying on its own and
becomes `dead_letter`. A router or network problem that lasts longer than
ordinary transient failures needs an operator, not another retry.

## What changes at dead-letter

- `status` becomes `dead_letter`, `nextAttemptAt` becomes `null` — the
  background worker will not pick it up again.
- `deadLetteredAt` records when.
- `lastError` keeps the last failure reason (never the raw router response
  body — only the adapter's error message, capped at 240 characters).
- For `sync_voucher`/`disconnect_voucher`, the affected voucher's
  `routerSyncStatus` becomes `dead_letter` too, so it is visible alongside
  the voucher itself, not only in the command list.
- `attempts`/`totalAttempts` are preserved for the review.

RouterOS reconciliation (NET-002) does not reset a dead-lettered command back
to `queued` on its next pass, even if it still detects the same drift — doing
so would erase the attempt history and mean the problem never dead-letters
again, silently muting the alert on a persistent issue. The drift is still
reported as a reconciliation finding either way; only the command itself is
left for an operator to replay.

## Alerting

When a command newly transitions into `dead_letter`, one alert fires: a POST
to `NETWORK_ALERT_WEBHOOK_URL` (if configured) with a Slack-compatible
`{"text": "..."}` payload naming the action, target, attempt count, and
reason. This follows the same convention as the existing backup-failure alert
(`BACKUP_ALERT_WEBHOOK_URL` in `backups/backup.sh`) — a plain incoming-webhook
POST, fire-and-forget, with alert delivery failure never affecting command
processing (caught and ignored, exactly like the bash version's `|| true`).
No alert fires again for the same command while it remains dead-lettered;
replaying it and having it fail through the full attempt cycle again will.

## Operator review and replay

1. Open **Connections → Network commands** in the admin dashboard. It lists
   every command that is not `processed`: pending/retrying counts, and a
   table of action, target, status, attempts, and reason for anything
   unresolved.
2. Investigate the underlying router/network problem (credentials, MikroTik
   bridge reachability, a malformed voucher) before replaying. Replaying does
   not change what the command will attempt to do — it only gives it a fresh
   attempt cycle.
3. An owner or operator can select **Replay**. This resets `attempts` to 0
   and requeues the command immediately; `totalAttempts` and the replay count
   are preserved for the audit trail.
4. The API is `POST /api/admin/network/commands/replay` with `{ "commandId":
   "..." }`. It requires an owner/operator session and production origin/CSRF
   checks (same controls as `POST /api/admin/payments/webhooks/replay`).
   Only `retry` and `dead_letter` commands can be replayed (`409` otherwise).
   A successful replay emits the audit action `network.command_replay_requested`.

## Verification and limits

Run `node --test test/router-queue.test.mjs test/router-reconciliation.test.mjs`,
`npm run check`, and `npm test`. Tests use a fake router adapter and a stubbed
`fetch` for the alert call; no live MikroTik bridge or webhook endpoint is
contacted. Tests cover reaching `dead_letter` after the attempt limit, a
permanent failure dead-lettering on its first attempt, exactly one alert
firing on the transition, alert delivery failure not blocking command
completion, replay resetting attempts while preserving history, replay being
rejected for a healthy or nonexistent command, HTTP role/CSRF/audit coverage
for the replay endpoint, and reconciliation leaving a dead-lettered command
alone instead of resetting it.

Before production rollout, set `NETWORK_ALERT_WEBHOOK_URL` and confirm a test
dead-letter reaches it, and confirm replay recovers a command against a real
MikroTik bridge in staging. No live-router, live-webhook, or
deployed-environment verification is implied by local tests.
