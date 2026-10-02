# Service-level objectives (OBS-005)

**Status: proposed.** The product owner and role owners must agree these objectives at the
first review below. Until then they drive alerts but are not commitments to customers.

Each objective is measured over a rolling 30 days. The error budget is the share of events
allowed to fail: for a 99.5% objective, 0.5%. Rules are in `monitoring/prometheus/slo.yml`;
the dashboard is `monitoring/grafana/ndahi-slo.json`.

## Objectives

| Objective | Good event | Counted events | Target | Budget in practice | Owner |
| --- | --- | --- | --- | --- | --- |
| `availability` | An external probe loads the page with HTTP 200 over HTTPS within 10 s | One probe per minute for each of `portal…/login`, `admin…/login` and `api…/api/health` | 99.5% per endpoint | About 3 h 36 min of failed probes per endpoint per month | platform-on-call |
| `api_success` | An API request completes without a server error (5xx) | Every API request except health and metrics probes | 99.5% | 1 in 200 requests | platform-on-call |
| `payment_completion` | A provider-confirmed payment issues its voucher within 10 minutes of checkout, without manual review | Provider-confirmed payments, plus confirmed payments held for review | 99% | 1 in 100 paid orders | payments-owner |
| `voucher_provisioning` | A new voucher's `sync_voucher` command reaches the router within 2 minutes of being queued | `sync_voucher` commands completed or dead-lettered | 99% | 1 in 100 vouchers | network-operations |
| `network_enforcement` | A `disconnect_voucher` or `disconnect_device` command reaches the router within 5 minutes | Those commands completed or dead-lettered | 99% | 1 in 100 disconnects | network-operations |

What these measure, and what they leave out:

- **Payments** count only orders the provider confirmed as paid. Declined, abandoned and
  expired checkouts are customer outcomes, not failures. The 10 minutes include the
  customer's approval on their phone; MeSomb allows up to 5 minutes for that.
  An order held for review (the customer already has an active bundle, Daily is still
  cooling down, or the plan or customer record is missing) counts as a failure once,
  however many provider retries follow.
- **Network commands** are timed from when the command was last queued. A dead-lettered
  command counts as a failure; a later operator replay of it is not counted again.
- **Availability** is probed from the monitoring host, so a failure there can look like
  an outage. Planned maintenance counts against the budget unless the review agrees otherwise.
- With no events in a window (for example, no payments overnight), the ratio is undefined
  and cannot alert. The report shows "no data".

## Alerts

Burn rate is how fast the budget is being spent: at 1, the budget lasts exactly 30 days.
Both windows must exceed the rate, and a minimum number of events stops one failure at a
quiet hour from paging.

| Alert | Severity | Condition | Meaning |
| --- | --- | --- | --- |
| `NdahiErrorBudgetFastBurn` | critical | Burn rate above 14.4 over 1 h and 5 min, with 5+ events in the hour | 2% of the monthly budget spent in an hour; gone in about two days |
| `NdahiErrorBudgetSlowBurn` | warning | Burn rate above 6 over 6 h and 30 min, with 10+ events in 6 h | 5% of the budget spent in six hours; gone in about five days |
| `NdahiErrorBudgetExhausted` | warning | Budget below zero for an hour, with 20+ events in 30 days | Apply the error-budget policy |
| `NdahiAvailabilityProbeMissing` | warning | The prober is down or not reporting for 10 min | The availability objective is blind |

Each alert carries the objective's `responder`, so Alertmanager routes it like the
[service monitoring](service-monitoring.md) alerts. Availability alerts also name the endpoint.

## Error-budget policy

| Budget left | Status | Action |
| --- | --- | --- |
| 25% or more | met | Normal releases |
| Under 25% | at risk | The owner reviews recent failures; reliability work is prioritized in the next planning cycle |
| Below zero | missed | Pause non-urgent releases touching that area until the 30-day figure recovers; fixes and security updates still ship. Write a short incident review |

Every fast-burn page also gets a short incident review, whatever the remaining budget.

## Reviews

Hold a review in the first week of each month, and after any fast-burn page. The product
owner and every role owner attend.

1. Generate the report and paste it into the log below:

   ```sh
   PROMETHEUS_URL=https://prometheus.example.internal \
   PROMETHEUS_BEARER_TOKEN=replace-with-token npm run slo:report
   ```

   The report lists each objective's target, 30-day achievement, budget left, event count,
   status and owner. Without `PROMETHEUS_URL` it queries `http://localhost:9090`.
2. For each objective that is at risk or missed: what consumed the budget, and which action
   from the policy applies.
3. Every quarter, decide whether each target still matches what customers need, and change
   `slo.yml`, `slo.test.yml` and this page together.

### Review log

| Date | Attendees | Summary | Decisions |
| --- | --- | --- | --- |
| _Not yet held_ | — | First review due after 30 days of production data | Agree or adjust the proposed objectives |

## Setup

1. Run `blackbox_exporter` on the Prometheus host on port 9115 with
   `monitoring/blackbox/blackbox.yml`. The `ndahi-probe` job in `prometheus.yml` probes the
   three endpoints through it once a minute.
2. Load `slo.yml` alongside `alerts.yml` (already listed in `prometheus.yml`) and keep at
   least 31 days of data: `--storage.tsdb.retention.time=31d`. The default 15 days cannot
   compute a 30-day budget.
3. Import `monitoring/grafana/ndahi-slo.json`.

CI checks the rules, the rule tests in `monitoring/prometheus/slo.test.yml` and the probe
configuration. Budgets fill in over the first 30 days after deployment; earlier figures
cover less than a full window.
