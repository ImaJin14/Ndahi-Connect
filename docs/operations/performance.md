# Performance targets, monitoring, and caching

This runbook covers PERF-001 to PERF-005. Targets are proposals until they are reviewed against the first four weeks of production measurements.

## Targets (PERF-001, PERF-005)

API latency is measured from request receipt to response completion, including persistence. Targets apply to the p95 over 10 minutes when at least 20 requests occurred.

| Operation | Routes | p95 target | Critical at |
| --- | --- | --- | --- |
| `login` | customer PIN, access, passkey, and setup routes; administrator login, MFA, and passkey routes | 1.0 s | 2.0 s |
| `dashboard` | `GET /api/account/dashboard`, `GET /api/admin/dashboard` | 0.5 s | 1.0 s |
| `payment_creation` | `POST /api/purchase`, `POST /api/account/plan/purchase` (includes the provider request) | 2.5 s | 5.0 s |
| `voucher_redemption` | `POST /api/vouchers/redeem` | 1.0 s | 2.0 s |
| `admin` | all other `/api/admin/*` routes | 1.5 s | 3.0 s |

Throughput objective: sustain the campus peak of 300 customers purchasing and redeeming at the same moment with no failed requests. The CI load test verifies this against memory and PostgreSQL stores. The server-error ratio must stay below 2% for each operation.

Core Web Vitals targets use the p75 of mobile visitors over one hour, when at least 50 samples were received:

| Metric | Target |
| --- | --- |
| Largest Contentful Paint (LCP) | ≤ 2.5 s |
| Interaction to Next Paint (INP) | ≤ 200 ms |
| Cumulative Layout Shift (CLS) | ≤ 0.1 |

Targets are defined in `lib/performance.mjs` and exported as `ndahi_request_target_seconds` and `ndahi_web_vital_target`. Alerts compare against these series, so a change to that file updates the alert thresholds.

## Enabling measurement

| Service | Variable | Value |
| --- | --- | --- |
| API | `PERFORMANCE_METRICS_ENABLED` | `true` |
| API | `METRICS_BEARER_TOKEN` | at least 32 random characters; `render.yaml` generates one |
| Customer and admin sites | `PERFORMANCE_METRICS_ENABLED` | `true` (injects the Web Vitals collector) |

With metrics enabled in production, startup validation requires the token. When disabled, `/api/metrics` and `/api/telemetry/vitals` return 404.

- `GET /api/metrics` returns Prometheus text and requires `Authorization: Bearer <METRICS_BEARER_TOKEN>`.
- `POST /api/telemetry/vitals` accepts browser measurements from the customer and admin origins only. It accepts LCP, INP, and CLS with fixed page, device (`mobile`/`desktop`), and network (`slow`/`fast`/`unknown`) categories. URLs, query strings, identifiers, and attribution data are never sent or stored. Requests are limited to 2 KB, and measurements to 10,000 per minute per API instance.

Metrics are held in memory per API instance and reset on restart; Prometheus retains the history.

## Prometheus and Grafana

Configuration lives in `monitoring/`:

- `prometheus/prometheus.yml` scrapes `https://api.ndahiconnect.net/api/metrics` every 30 seconds. Copy the token from the Render API service into `/etc/prometheus/secrets/ndahi-metrics-token`.
- `prometheus/alerts.yml` defines latency, error-rate, scrape-failure, and mobile Web Vitals alerts. Check changes with `promtool check rules monitoring/prometheus/alerts.yml` and `promtool test rules monitoring/prometheus/alerts.test.yml`.
- `grafana/ndahi-performance.json` is an importable dashboard with p95 latency against targets, throughput, error ratio, target status, and mobile LCP/INP/CLS by app and network.

| Alert | Severity | Responder |
| --- | --- | --- |
| `NdahiLatencyTargetMissed` | warning | platform on-call |
| `NdahiLatencyCritical` | critical | platform on-call |
| `NdahiServerErrorRate` | critical | platform on-call |
| `NdahiMetricsMissing` | warning | platform on-call |
| `NdahiMobileLcpTargetMissed`, `NdahiMobileInpTargetMissed`, `NdahiMobileClsTargetMissed` | warning | frontend owner |

Route these labels to named people in Alertmanager before relying on the alerts.

## Static asset delivery (PERF-004)

The customer and admin servers build an in-memory asset catalogue at first request:

- CSS, JavaScript, images, and fonts get a content-derived revision. References in HTML (`src`/`href`), CSS (`url()`), and JavaScript imports are rewritten to `/static/<path>.<revision>.<ext>`.
- Versioned URLs are served with `Cache-Control: public, max-age=31536000, immutable`. HTML and unversioned paths use `no-cache` with an ETag, so browsers revalidate and receive `304 Not Modified` when nothing changed.
- Text assets over 512 bytes are pre-compressed with Brotli and gzip, and served according to `Accept-Encoding`.
- The revision covers every asset, so any deployment changes every versioned URL, and an old page cannot mix with new scripts.
- The hero image is served as WebP: 47 KB at 1600 px for desktop and 9 KB at 800 px for mobile, down from a 1.36 MB PNG.

Measured locally on 2026-09-28 with Chrome at 390 px, a Slow 4G profile (150 ms RTT, 1.6 Mbps), and 4× CPU throttling:

| Page | Before: first / repeat transfer | After: first / repeat transfer | LCP before → after (first / repeat) |
| --- | --- | --- | --- |
| `/login` | 122.6 KB / 33.8 KB | 92.7 KB / 2.7 KB | 1100 → 948 ms / 460 → 200 ms |
| `/onboarding.html` | 141.1 KB / 65.2 KB | 99.0 KB / 2.7 KB | 1320 → 920 ms / 536 → 192 ms |

## Write concurrency (PERF-002)

The PostgreSQL store no longer serializes every write behind one lock and rewrites every row:

- Transactions write only rows that changed. Updates and deletes are guarded by the payload that was read, so a concurrent change raises a conflict instead of being overwritten. New rows receive ordinals around existing rows; migration `004_incremental_ordinals.sql` permits negative ordinals for prepends.
- Customer transactions (checkout, voucher redemption, PIN login, dashboard, authentication throttling) and read-only admin views lock only their customer or session scope, plus a shared global lock. Different customers proceed concurrently. A conflict outside the scope, such as expiry housekeeping, retries the transaction; responses are buffered until commit.
- All other transactions, including workers and administrator mutations, take the global lock exclusively, as before. The retention job takes the same lock.

On the 300-customer purchase and redemption load test against local PostgreSQL 17, total runtime fell from 6 min 15 s to 16 s. Median latency fell from 103.9 s to 4.8 s and p95 from 183.3 s to 6.3 s, with no failed requests. The load generator and API share one process, so these figures compare the two stores and are not production latency.

Each transaction still reads the full state. Moving reads to per-workflow queries is the next scaling step; see [API architecture](../architecture/api-domains.md).

## Production verification

1. Apply migration 004 before the new API starts; see [API deployment readiness](api-deployment-readiness.md#migration-004-perf-002). The pre-deploy check fails with `migration_required` until it is applied.
2. Deploy with metrics enabled, add the scrape job and alert rules, and import the dashboard.
3. Confirm `up{job="ndahi-api"} == 1` and that every operation reports samples after smoke tests.
4. Confirm mobile Web Vitals samples arrive from both sites. Record the first week's p75 values and review the targets.
5. Check a deployed page for `/static/…` URLs with `immutable` caching, and confirm a repeat visit receives `304` for the HTML.
6. Watch `ndahi_request_duration_seconds` for `login`, `payment_creation`, and `voucher_redemption` during the first busy period, and record the results in the checklist.
