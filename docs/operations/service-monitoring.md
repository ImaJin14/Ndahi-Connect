# Service monitoring and alert responders (OBS-004)

The API exports service health metrics alongside the PERF-001 latency metrics at
`/api/metrics`. Prometheus evaluates the alert rules in `monitoring/prometheus/alerts.yml`,
and Alertmanager routes each alert to its responder role.

## Responders

Every alert carries a `responder` label. Alertmanager routes each role to its own channel
(`monitoring/alertmanager/alertmanager.yml`). **Assign a named person and a backup to each
role before relying on alerts; OBS-004 is not complete until this table is filled in.**

| Role | Owns | Primary | Backup | Escalate to |
| --- | --- | --- | --- | --- |
| `platform-on-call` | API, database, email delivery, latency, monitoring | _To be assigned_ | _To be assigned_ | Product owner |
| `payments-owner` | Payment providers, provider events, refunds, payments needing review | _To be assigned_ | _To be assigned_ | Product owner |
| `network-operations` | RouterOS bridge, router commands, Omada controller, on-site hardware | _To be assigned_ | _To be assigned_ | Product owner |
| `security-owner` | Login abuse, security-alert delivery | _To be assigned_ | _To be assigned_ | Product owner |
| `frontend-owner` | Mobile Core Web Vitals (PERF-005) | _To be assigned_ | _To be assigned_ | Product owner |

Escalation paths, severities and incident playbooks are in
[incident response](incident-response.md).

Critical alerts repeat every hour until resolved; warnings repeat every 12 hours. A
critical alert suppresses its matching warning (for example, `NdahiPaymentProviderDown`
suppresses `NdahiPaymentProviderErrors` for the same provider).

## Alerts and first actions

Rate-based alerts require a minimum number of calls in the window, so a single failure
at a quiet hour does not page anyone.

| Alert | Severity | Condition | Responder | First action |
| --- | --- | --- | --- | --- |
| `NdahiDatabaseUnavailable` | critical | Readiness probe cannot reach PostgreSQL for 2 min | platform | Check `api.readiness_failed` logs and the Render database; see [API deployment readiness](api-deployment-readiness.md) |
| `NdahiMonitorStale` | warning | Queue gauges not refreshed for 5 min | platform | Check `monitoring.sample_failed` logs; backlog alerts are blind meanwhile |
| `NdahiMetricsMissing` | warning | Prometheus cannot scrape the API for 5 min | platform | Check the API service, then the metrics token |
| `NdahiPaymentProviderErrors` | warning | Over 20% of a provider's calls fail for 10 min (5+ calls in 15 min) | payments | Check `payment.provider_failed` logs and the provider's status page |
| `NdahiPaymentProviderDown` | critical | Over 50% fail for 5 min (5+ calls in 10 min) | payments | As above; consider pausing checkout for that provider |
| `NdahiPaymentsNeedReview` | warning | Payments marked for review or with an uncertain charge for 30 min | payments | Admin → Payments; see [billing experience](billing-experience.md) |
| `NdahiRefundsAwaitingApproval` | warning | A customer refund request waited 24 h | payments | Approve or decline in Admin → Payments |
| `NdahiPaymentsStuckPending` | warning | A payment pending for over 6 h | payments | Recheck it from the admin dashboard; see [payment reconciliation](payment-reconciliation.md) |
| `NdahiWebhookBacklog` | warning | A provider event waited over 15 min | payments | See [webhook recovery](payment-webhook-recovery.md) |
| `NdahiWebhookDeadLetters` | critical | A provider event stopped retrying | payments | Replay it under Payments → Webhook recovery after fixing the cause |
| `NdahiEmailDeliveryErrors` | warning | Over 20% of emails fail for 15 min (5+ in 30 min) | platform | Check `email.failed` logs and Resend status |
| `NdahiEmailDeliveryDown` | critical | Every email fails for 10 min (3+ in 30 min) | platform | Check the Resend key and domain verification; customers cannot receive vouchers or PIN resets |
| `NdahiSecurityAlertBacklog` | warning | A security alert pending 30 min, or one failed after 8 attempts | security | Check `email.failed` logs with `kind=security_alert` |
| `NdahiRouterErrors` | warning | Over 20% of bridge calls fail for 10 min (5+ in 15 min) | network | Check `network.command_failed` and bridge logs |
| `NdahiRouterUnreachable` | critical | Over 80% fail for 5 min (3+ in 10 min) | network | Check the bridge, VPN/tunnel and router power; see [router command queue](router-command-queue.md) |
| `NdahiNetworkCommandBacklog` | warning | A router command waited over 15 min | network | As above |
| `NdahiNetworkCommandDeadLetters` | critical | A router command stopped retrying | network | See [router dead letters](router-command-dead-letter.md); replay after fixing the cause |
| `NdahiOmadaUnreachable` | warning | Over half of Omada status probes fail for 10 min | network | Check the controller and its API token |
| `NdahiCustomerLoginFailuresHigh` | warning | Over 10 customer logins per minute rejected or throttled for 10 min | security | Review customer security events for guessing from few addresses |
| `NdahiAdminLoginFailures` | warning | 5+ administrator logins rejected in 15 min | security | Confirm with administrators; review admin security events |
| `NdahiAdminLoginAttack` | critical | 20+ administrator logins rejected in 15 min | security | Treat as an attack; consider restricting the admin origin |

Latency and Web Vitals alerts are described in [performance](performance.md). Error-budget
burn alerts for the service-level objectives are in [service-level objectives](service-level-objectives.md).

## Metrics

| Metric | Meaning |
| --- | --- |
| `ndahi_dependency_calls_total{dependency, provider, operation, outcome}` | Completed calls to payment providers (`createPayment`, `verifyPayment`, `refundPayment`, `verifyRefund`), email (`sendVoucher`, `sendReceipt`, `sendSecurityAlert`, `sendPinReset`), the RouterOS bridge and Omada. Webhook signature checks are not counted. |
| `ndahi_database_up` | 1 when the last readiness probe reached PostgreSQL. Render probes `/api/health` continuously. |
| `ndahi_queue_pending`, `ndahi_queue_oldest_pending_seconds`, `ndahi_queue_dead_letters` `{queue}` | `payments`, `payment_webhooks`, `network_commands` and `security_alerts`. A failed security alert counts as a dead letter. |
| `ndahi_payments_attention{reason}` | `needs_review`, `uncertain`, `verification_error`, `refund_requested`, `refund_pending` |
| `ndahi_auth_responses_total{actor, outcome}` | Login responses: `success`, `rejected` (401/403), `throttled` (423/429), `invalid`, `error` |
| `ndahi_bootstrap_mode`, `ndahi_monitor_last_sample_timestamp_seconds`, `ndahi_monitor_sample_failures_total` | Bootstrap state and monitor freshness |

The API refreshes queue and payment gauges every 60 seconds by reading only the payments,
provider events, router commands and security alerts collections. When Omada is live and
configured from the environment, every fifth sample also probes the controller. Metrics
contain no customer data, and the monitor runs only when `PERFORMANCE_METRICS_ENABLED=true`.

## Setup

1. Keep `PERFORMANCE_METRICS_ENABLED=true` on the API (the Render Blueprint sets it) and copy
   `METRICS_BEARER_TOKEN` to `/etc/prometheus/secrets/ndahi-metrics-token` on the Prometheus host.
2. Deploy `monitoring/prometheus/prometheus.yml` and `alerts.yml`. The config sends alerts to
   Alertmanager on `localhost:9093`; change the target if it runs elsewhere.
3. Create one Slack-compatible incoming webhook per role and save each URL to
   `/etc/alertmanager/secrets/<role>-webhook`, then deploy `monitoring/alertmanager/alertmanager.yml`.
4. Import `monitoring/grafana/ndahi-services.json` and `ndahi-performance.json` into Grafana and
   select the Prometheus data source. For the service-level objectives, also run the blackbox
   prober, keep 31 days of data and import `ndahi-slo.json`; see
   [service-level objectives](service-level-objectives.md#setup).
5. Fill in the responder table above, then send a test alert to each role with
   `amtool alert add NdahiTest responder=<role> severity=warning --annotation=summary="Routing test" --alertmanager.url=http://localhost:9093`.

CI validates the Prometheus config, rules, rule tests, Alertmanager config, probe config and
dashboard queries with pinned, checksum-verified `promtool`, `amtool` and `blackbox_exporter`. To check locally:

```sh
promtool check rules monitoring/prometheus/alerts.yml
promtool test rules monitoring/prometheus/alerts.test.yml monitoring/prometheus/service-alerts.test.yml monitoring/prometheus/slo.test.yml
amtool check-config monitoring/alertmanager/alertmanager.yml
amtool config routes test --config.file=monitoring/alertmanager/alertmanager.yml responder=payments-owner severity=critical
```

## Limits

- Counters and gauges live in each API process and reset on deploy; `rate()` and
  `increase()` absorb the reset. Rules use `max()` and `sum()`, so they also work if the API
  later runs several instances.
- Background workers and the router reconciliation provide the router heartbeat. With no
  router traffic at all, router alerts cannot fire; the command backlog alerts still do.
- Payment, email and network outages are detected through the API's own calls. Provider
  status pages and on-site hardware power are outside this monitoring.
