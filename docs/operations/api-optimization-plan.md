# API optimization plan

Status, 18 November 2026: phase 1 is merged (#290, `f31cd8f`) and deployed to
production; see [Production after phase 1](#production-after-phase-1). Phases 2–7
are not started. The receipt-retry item from phase 3 is also deployed (#291).
This plan supersedes the ordering in the unmerged
`api-performance-rollout-plan-2026-11-14.md` draft and keeps its deployment-safety
rules (one reviewable release at a time, a switch back to the old path, no
outage).

## Why the API is slow

**Every request loads the whole database.** The store reads every row of every
collection (customers, all payments, all vouchers, all events…), parses it,
serializes it again to detect changes, and often deep-copies it, even to answer
`GET /api/plans`. Cost therefore grows with total stored data, not with the
request. On top of that:

- **One global lock.** 66 of the 76 request transactions, and all 55
  transactions that workers and services open directly, take the database-wide
  lock exclusively, so they queue behind each other; a slow full-state read holds
  everyone else up.
- **Polling multiplies it.** An open Home screen asks for bundle status every 15
  seconds; checkout asks for payment status every 3 seconds, and each payment
  status request ran five full-state reads (one snapshot, three billing checks,
  one write).
- **The billing worker never runs out of work.** Every 30 seconds it takes up to
  25 payments, at about seven full-state transactions each. A paid payment whose
  receipt email is not sent (for example, the customer has no confirmed email)
  stays a candidate on every pass, forever.
- **Distance is a fixed floor.** A request that never touches the database
  (`/api/authentication-policy`) takes about 150 ms end to end from Cameroon to
  the Frankfurt API. Code changes cannot remove that part.

### Production sample (16 Nov, one warm HTTP/2 connection, 10 requests each)

| Request | Median | Max | Above the no-database floor |
| --- | ---: | ---: | ---: |
| `GET /api/authentication-policy` (no database) | 153 ms | 160 ms | — |
| `GET /api/health` | 173 ms | 258 ms | +20 ms |
| `GET /api/plans` | 708 ms | 2,228 ms | +555 ms |
| `GET /api/status` | 558 ms | 3,120 ms | +406 ms |
| `GET /api/account/dashboard` (signed out, 401) | 460 ms | 1,176 ms | +307 ms |
| `GET /api/admin/dashboard` (signed out, 401) | 499 ms | 1,492 ms | +346 ms |

Even requests that are refused for having no session spend ~300 ms in the
database, because the session check itself loaded everything. These are spot
samples, not a production p95.

### Local measurement before phase 1 (origin/main `f9b060e`)

The real API code against PostgreSQL 17 on one machine, with synthetic data cloned
from records the real purchase flow produces. Median of sequential requests:

| Stored data | 300 payments (1.7 MB) | 2,400 (8.7 MB) | 12,000 (38 MB) | 40,000 (120 MB) |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/plans` | 26 ms | 100 ms | 412 ms | 1,417 ms |
| `GET /api/account/dashboard` | 26 ms | 103 ms | 431 ms | 1,439 ms |
| `GET /api/account/bundle-status` | 24 ms | 101 ms | 415 ms | 1,352 ms |
| `GET /api/account/payments/:id/status` | 119 ms | 521 ms | 2,197 ms | 7,211 ms |
| 16 customers open their dashboard at once (wall) | 0.3 s | 1.3 s | 6.0 s | 20.9 s |

At 40,000 payments one request spent its time on: reading and transferring rows
444 ms, parsing them 297 ms, re-serializing for change detection 179 ms and
deep-copying 648 ms. The same answers from targeted, indexed reads took 0.2–1 ms.

## Plan

Each phase is a separate PR with its own measurement, and each keeps the old
path behind a switch until it has run through a busy period in production.

### Phase 1 — targeted reads for public and polled routes (implemented)

- Store: `read(steps)` and `transaction(fn, { load })` load only the rows a
  request names, by indexed columns, in dependent steps (session → customer →
  that customer's bundles → their payments). A targeted transaction takes the
  shared lock, so it runs beside other customers. If its callback would add a
  row to a partly loaded collection or write anything it did not load, the
  store reruns it once on the full state, so no write is lost or misplaced.
- Snapshots no longer deep-copy or track changes (each one is built fresh).
- Targeted: `GET /api/plans`, `GET /api/status`, the customer CSRF session check
  on every protected POST, `GET /api/account/bundle-status`, and payment status
  (`/api/payments/:id/status`, `/api/account/payments/:id/status`) including its
  billing checks. The billing worker's per-payment steps (stamp, checkout
  closing, verification and refund leases, receipt email) load one payment.
- Housekeeping (bundle expiry, quota cut-off, stale sessions) used to ride on
  every request, including the public catalogue. Targeted requests tidy only the
  rows they load; anything more reruns on the full state exactly as before. A
  new worker runs full housekeeping every 30 s
  (`HOUSEKEEPING_INTERVAL_SECONDS`, off with `HOUSEKEEPING_WORKER_ENABLED=false`).
- Switch: `STORE_TARGETED_READS=false` on the API service restores every
  original path (and turns the housekeeping worker off) after the restart.
- Tests: store tests and a route test on PostgreSQL that requires identical
  responses with the switch on and off; the full unit suite passes either way.
  `scripts/benchmark-api-reads.mjs` reproduces the numbers below.

Results: see [Phase 1 results](#phase-1-results).

### Phase 2 — account and admin pages

`GET /api/account/dashboard`, security, Wi-Fi devices, notifications and voucher
history; then the admin dashboard and records with filtering and pagination in
SQL. Each callback's reads must be audited before it gets a `load` (the
dashboard alone reads router jobs, device grants, revocations and Home links).
Target: the dashboard as flat as bundle status is after phase 1.

### Phase 3 — workers

- Webhook processor, payment reconciliation, router queue, usage sync,
  notification delivery, store orders and security alerts claim their job with
  a targeted load, and pick candidates with an indexed query instead of a full
  snapshot.
- Receipts blocked on a missing email or on transactional email being off were
  retried on every billing pass, forever. Owner-approved on 18 November and
  deployed in #291 (`ec7cbf2`): they are checked hourly, and
  on the next pass once the customer confirms an email or turns transactional
  email back on.

### Phase 4 — customer writes

Purchase, redemption, sign-in and the sign-in rate limiter add rows, which
targeted transactions cannot do yet. Allocate the new rows' position with one
indexed query so these can load only their customer's rows too.

### Phase 5 — retire full-state housekeeping

Run expiry and quota cut-off as indexed SQL (new expression indexes built with
`CREATE INDEX CONCURRENTLY`, outside the migration transaction), then remove the
full-state housekeeping worker and, finally, full-state transactions.

### Phase 6 — fewer requests from the apps

One shared bundle-status poll per app; stop optional polling on hidden pages
(already done for most); answer unchanged polls with `304 Not Modified`; split
the caller-independent catalogue from `GET /api/plans` so Cloudflare can cache it
for a short time.

### Phase 7 — hosting, once the code is flat

The API runs on Render's starter plan and PostgreSQL on basic-256mb in
Frankfurt. After phases 1–3, compare CPU and database load during a busy period
before paying for larger plans. Confirm the API uses the database's internal
connection.

## Rolling out phase 1

1. Done: merged as `f31cd8f`, live at 17:39 UTC on 18 November.
2. Done for one quiet period; see below. Repeat after deploy: compare the production sample above (same requests, same
   connection reuse) and watch `ndahi_request_duration_seconds` for the routes.
3. Pending: watch error rates, bundles expiring on time and pending-payment outcomes
   through one busy evening.
4. If anything is wrong, set `STORE_TARGETED_READS=false` on `ndahi-api`; the
   restart restores the original behaviour without a code change.

Unchanged by phase 1: payment settlement, voucher creation, redemption,
purchases and sign-in still run on the full state.

## Phase 1 results

Measured on 18 November with `scripts/benchmark-api-reads.mjs` (Node 22, local
PostgreSQL 17, one machine). Median milliseconds, `STORE_TARGETED_READS=false` →
**on**, same database and code:

| Median | 300 payments | 2,400 payments | 12,000 payments | 40,000 payments |
| --- | ---: | ---: | ---: | ---: |
| `GET /api/plans` | 18 → **1.1** | 93 → **0.7** | 392 → **0.8** | 1,279 → **0.7** |
| `GET /api/status` | 12 → **0.8** | 58 → **0.7** | 224 → **0.7** | 668 → **0.6** |
| `GET /api/account/bundle-status` (Home poll, every 15 s) | 17 → **2.3** | 90 → **1.9** | 390 → **2.4** | 1,278 → **3.2** |
| `GET /api/account/payments/:id/status` (checkout poll, every 3 s) | 81 → **4.3** | 422 → **3.5** | 1,852 → **3.7** | 5,870 → **2.9** |
| `POST /api/account/gift/recipient` (CSRF check targeted; its write is not yet) | 30 → **21** | 151 → **91** | 639 → **387** | 1,976 → **1,284** |
| `GET /api/account/dashboard` (phase 2, unchanged) | 19 → **19** | 90 → **90** | 428 → **388** | 1,298 → **1,274** |
| 16 customers poll Home at once (wall time) | 320 → **37** | 1,478 → **20** | 6,501 → **28** | 20,340 → **37** |
| One billing worker pass (25 payments) | 2,964 → **203** | 15,803 → **259** | 70,153 → **693** | 225,614 → **2,061** |

The targeted routes now take about the same time whatever is stored. The
dashboard and the routes that write customer data still grow with the data;
they are phases 2 and 4. The billing worker's remaining cost is the two
whole-state reads it makes to pick candidates (phase 3).

What this means in production: the server part of the polled and public
requests should fall to a few milliseconds, leaving roughly the ~150 ms network
floor from Cameroon. Pages that load the dashboard stay at today's speed until
phase 2. Requests also stop queueing behind each other during busy periods,
because the polls no longer hold the database-wide lock. Confirm with the
production sample after deploy; local numbers are not production latency.

## Production after phase 1

Same sample as above (10 rounds on one warm HTTP/2 connection), median ms. The
first sample right after each deploy was slower across the board while the new
instance started its workers, so samples were repeated five minutes later.

| Request | Before (18 Nov) | After #290 | After #291 and #292 too |
| --- | ---: | ---: | ---: |
| `GET /api/authentication-policy` (no database: network floor) | 155 | 159 | 276 |
| `GET /api/plans` | 821 (max 4,996) | **166** (max 401) | **271** (max 2,721) |
| `GET /api/status` | 620 (max 1,468) | **172** (max 284) | **282** (max 1,098) |
| `GET /api/account/bundle-status` (signed out) | 1,061 | **168** | **291** |
| `GET /api/account/dashboard` (signed out, not yet targeted) | 1,069 | **349** | **450** |
| `GET /api/admin/dashboard` (signed out, not yet targeted) | 1,095 | **446** | **571** |

The network floor itself varies (155–276 ms across these samples), so compare
each column with its own floor: the targeted routes now take within ~15 ms of
it. The dashboards are faster
too, because the polls no longer hold the database-wide lock ahead of them.
Single requests still spike to ~2 s while waiting behind a worker's exclusive
lock (phase 3). Signed-in timings, the busy-evening check and error-rate
monitoring are still to do.

