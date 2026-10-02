# Application logging (OBS-001)

The API, customer and admin frontends, retention job and network bridge write one JSON
object per line to stdout (debug/info) or stderr (warn/error). Render collects both
streams in each service's **Logs** view.

```json
{"time":"2026-10-02T17:04:11.512Z","level":"info","service":"api","event":"http.request","requestId":"6f1c…","method":"POST","route":"/api/payments/:id/confirm","status":200,"durationMs":41.7}
```

| Field | Meaning |
| --- | --- |
| `time`, `level`, `service`, `event` | Always present. `service` is `api`, `customer`, `admin`, `retention` or `bridge`. |
| `requestId` | API request ID, also returned as the `x-request-id` response header. |
| `method`, `route`, `status`, `durationMs` | Access-log fields. `route` is a template: identifiers become `:id` and query strings are never logged. |
| `code`, `hint`, `errorName`, `errorMessage` | Failure details. Unexpected errors log their class and code only; database errors include a fixed hint. |
| `customerId`, `paymentId`, `voucherId`, `commandId`, … | Opaque record IDs (UUIDs), never phone numbers or voucher codes. |
| `droppedFields` | Names of fields a call tried to log that are not allowlisted. Their values are discarded. |

## Events

| Event | Level | When |
| --- | --- | --- |
| `http.request` | info, error for 5xx | Every API request, except successful `/api/health` and `/api/metrics` probes |
| `http.unhandled_error` | error | A handler threw an unexpected error |
| `api.readiness_failed` | error | Readiness probe failed (logged once per distinct failure code) |
| `billing.worker_failed`, `security_alerts.worker_failed`, `payment.webhook_worker_failed`, `payment.reconciliation_failed`, `network.command_worker_failed`, `network.reconciliation_failed`, `network.setup_worker_failed` | error | A background worker pass failed |
| `api.listening`, `app.listening`, `bridge.listening` | info | Process started; the API includes its commit |
| `static.assets_unavailable` | error | A frontend could not build its asset catalog |
| `retention.completed` | info | Daily retention finished, with per-table `counts` |
| `bridge.startup_failed` | error | The management bridge could not start |

## Levels

`LOG_LEVEL` sets the minimum level: `debug`, `info` (default), `warn` or `error`.
An unrecognized value falls back to `info`. Tests run with `LOG_LEVEL=warn`.

## What is never logged

`lib/logger.mjs` enforces two layers:

1. **Field allowlist.** Only the field names above are written. A call such as
   `logger.info("x", { phone, pin })` writes neither value. Request and provider bodies,
   query strings, headers, cookies, PINs and session tokens have no allowlisted field.
2. **Value redaction.** String values are checked before truncation, and these patterns
   are replaced with `[redacted]`: email addresses, numbers of 9–15 digits (phone or
   account), voucher codes (`NC-XXXX-XXXX`), recovery codes (`XXXX-XXXX`), bearer
   tokens, credentials in URLs, and token-like strings of 32+ characters. UUIDs and
   commit hashes are not affected.

A four-digit PIN cannot be distinguished from other numbers by pattern, so PINs are
protected by the allowlist alone. Do not put PINs, codes or customer data into log fields. `errorFields()` excludes
raw error messages because providers can echo PINs and names that pattern redaction
cannot recognize.

## Tracing a request

Ask the customer or support agent for the `x-request-id` from the failing response
(browser developer tools, Network tab), then search the API logs for that value. The
access log and any `http.unhandled_error` for the request share the ID. The `correlationId` initially equals the request ID. It is persisted on payments,
router commands and security alerts, and restored for their asynchronous work.
Payment, webhook, email and router outcome logs use that operation ID; the router
adapter sends it to the authenticated management bridge in `x-correlation-id`.
Third-party providers do not receive this header. Existing records without an ID
remain supported. Live tracing across Render and physical devices is still pending.

## Adding a log call

Use `context.logger`; async request context automatically attaches `requestId`
and `correlationId`. Name events `area.past_tense_outcome`. Add a field to the allowlist only
when its values can never contain personal data or secrets, and add a test in
`test/logger.test.mjs`.
