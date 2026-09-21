# Payment webhook recovery (PAY-002)

Both MeSomb and Flutterwave webhook endpoints authenticate the original provider
signature before saving an event. The record contains provider/event IDs, order
and transaction IDs, event type, a payload digest, timestamps, attempts, and state.
Raw webhook bodies, signatures, credentials, and customer details are not stored
in the replay record. Invalid signatures are rejected without being queued.

Records use the existing `providerEvents` collection and normalized `events`
table (`kind = 'provider'`). No database migration is required. The event is
committed before verification or fulfillment begins. Provider reads run outside
database write transactions. Voucher issuance and the successful event marker
commit together, using the existing transactional store and fulfillment rules.

## Automatic processing

The API attempts a newly received event immediately. A background worker also
starts when the server listens and runs every 30 seconds, processing up to 25
due events per pass. `PAYMENT_WEBHOOK_REPLAY_ENABLED=false` disables this
background worker only; incoming webhooks are still stored and processed.

- `queued`: durable event awaiting processing.
- `processing`: claimed with a durable 50-second lease and attempt count.
- `retry`: temporary verification failure or missing local order; retry delays
  are 30, 60, 120, and 240 seconds for the default five-attempt cycle.
- `dead_letter`: five attempts exhausted, mismatched provider details, refunded
  payment, or fulfillment conflict. Requires operator review.
- `processed`: provider verification and local handling committed successfully.

Provider verification has a 20-second deadline. Expired processing leases allow
recovery after crashes. Lease tokens prevent stale workers from applying results.
Repeated provider deliveries do not bypass backoff or reset retry counts. An event
ID is scoped to its provider; events without an ID use a hash of the signed body.
Reusing an event ID with conflicting normalized content is rejected.

A successful payment must match the order ID, amount, currency, and the signed
event's transaction ID when present. Providers may replace an initial pending
reference with their final transaction ID. Existing vouchers prevent duplicate
issuance even if local payment status was changed. Out-of-order failed/pending
events cannot downgrade fulfilled payments; paid callbacks cannot revive refunds.
Valid pending/failed status callbacks are processed as status updates; PAY-001
continues to identify delayed or missing settlements.

## Manual replay

1. Open **Payments → Webhook recovery**. Review the payment ID, provider, state,
   attempt count, and reason.
2. Check the provider transaction and resolve the underlying cause. Do not create
   another charge to resolve a failed callback. A mismatch must never be bypassed
   by editing the queue payload or marking an event successful manually.
3. An owner or operator can select **Replay** and confirm. This queues a new
   retry cycle; the worker verifies current provider state before fulfilling it.
4. Refresh the Payments tab after the worker runs. Successfully processed events
   disappear from the recovery list; unresolved events remain visible.

The API is `POST /api/admin/payments/webhooks/replay` with `{ "eventId": "..." }`.
It requires an owner/operator session and production origin/CSRF checks. Only
`retry` and `dead_letter` events can be replayed. The action resets cycle attempts
while preserving total attempts and replay count, and emits the audit action
`payment.webhook_replay_requested`. Customers, resellers, and auditors cannot replay.

Temporary failures on initial delivery return a non-success status after durable
storage. Subsequent delivery of a stored dead-letter event returns `200` with
`requiresReview`; it does not restart retries. Successful duplicate delivery returns
an idempotent acknowledgment. If persistence fails, no successful acknowledgment
is sent. Storage/worker errors emit `payment.webhook_worker_failed` in API logs.

Unresolved queue records are excluded from automatic provider-event archival.
Processed records follow the existing provider-event retention policy. There is
no in-memory history cap that silently drops unresolved work. Archived old events
may be delivered again; the existing payment/voucher guard still prevents duplicate
fulfillment.

## Verification and limits

Run `node --test test/payment-webhooks.test.mjs test/retention.test.mjs`,
`npm run check`, and `npm test`. Automated tests use fake providers; no customers
are charged. Tests cover duplicates, concurrent delivery, provider failures,
timeouts, mismatches, conflicts, restarts, refunds, and replay access controls.

Before production rollout, exercise failed delivery and replay with provider
sandbox credentials, then confirm queue visibility and worker progress in staging.
No live-provider or deployed-environment verification is implied by local tests.
RouterOS/email side effects retain their existing idempotency and retry behavior;
durable network command processing is tracked separately under NET-001.
