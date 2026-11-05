# NDAHI Home readiness, migration and pilot evidence

The integration uses a WISP/NAT capability contract, not a manufacturer, model or
MAC-vendor registry. A router must provide a wireless upstream, IPv4 NAT, a private
LAN and a stable upstream MAC. Private clients can use integrated Wi-Fi, Ethernet,
or a private AP attached to the LAN. A bridge or repeater without NAT provides
separate upstream clients and does not meet this Home contract. Match the site's
Wi-Fi band/security and use an unused LAN subnet distinct from the upstream and
management networks. Configure those settings in the device's own interface.

The local challenge verifies the upstream connection. It cannot inspect the LAN
behind NAT, identify the physical model reliably or certify firmware security.
Locally administered unicast MACs are accepted; rotating the WAN MAC requires a
new owner-verified link. No printed MAC, public source IP, vendor label or uploaded
pilot report grants ownership or bypasses the local challenge. There is no custom
vendor-management API and no automatic private Wi-Fi/password configuration.

## 1. Database verification and additive migration (#171)

From the authorized owner/operator Home management page, select **Check database
and gateway readiness**. Its protected GET endpoint checks PostgreSQL through the
API's existing internal connection. External database access may remain disabled.
It reads catalog definitions, not customers/payments, and makes no router changes.

An operator with an existing authorized database session can instead run:

```sh
npm run check:home:database
```

Use the existing securely configured `DATABASE_URL` and TLS settings. Never paste
credentials into chat, issue comments, command arguments or report evidence.
Readiness requires all three migration 008 indexes in the current schema:

- `home_active_mac_unique`: usable unique MAC expression; linked/reserved/retiring predicate.
- `home_linked_customer_unique`: usable unique customer expression; linked predicate.
- `home_operations_due`: usable next-attempt expression; Home-operation predicate.

Names alone are insufficient. Wrong expressions, predicates, uniqueness, relation,
operator class or unusable indexes fail readiness. The normal database predeploy
check also requires these definitions when `NDAHI_HOME_ENABLED=true`. Production
Home enrollment/activation independently checks the indexes before new grants.

If an index is missing, keep Home disabled. Verify a retained database backup and
restore procedure first. The narrowly scoped command below applies only migration
008; it never imports legacy JSON state or clears normalized tables:

```sh
HOME_MIGRATION_CONFIRM=apply-reviewed-additive-home-indexes \
HOME_BACKUP_REFERENCE=your-verified-backup-reference \
npm run migrate:home
```

The reference is operator acknowledgement, not proof that the backup was restored.
The command refuses same-named indexes with different definitions instead of
silently dropping/replacing them. It has bounded connection/statement/lock waits.
Review those conflicts separately. No automatic production migration is performed
by the readiness endpoint. Do not use `rollback-postgres-state.mjs` as a Home
feature rollback: retain payments, vouchers, links and consumed usage.

### Isolated restore rehearsal

PostgreSQL tests cover repeated DDL, concurrent claims, rejected uniqueness
violations, transaction rollback, paid/direct balances and a fresh-schema restore.
A native `pg_dump`/`pg_restore` rehearsal is also available:

```sh
HOME_REHEARSAL_CONFIRM=isolated-synthetic-home-restore \
HOME_REHEARSAL_DATABASE_URL='postgresql://your-local-test-user@localhost/postgres' \
npm run check:home:restore
```

Use a private local PostgreSQL test cluster and installed `pg_dump`/`pg_restore`.
`HOME_PG_BIN` optionally selects their directory. The command refuses remote or
application database targets, creates two uniquely named synthetic databases,
replays migrations, tests rollback, restores a custom-format archive and compares
all normalized state. Duplicate/multiple host overrides are rejected and inherited
libpq connection overrides are removed from dump/restore child processes. It removes
only databases it created. Credentials go through
child environment variables, not command-line arguments. This is not a test of a
production encrypted R2 backup or production RPO/RTO; those remain a separate drill.

## 2. Gateway preflight and physical enforcement (#175)

The same protected readiness action performs GET-only reads of the saved live
MikroTik connection. It reports individual configured HTTPS HotSpot, enrollment
and live forwarding guards, required destinations, FastTrack exclusion and guest
IPv6 checks. Invalid HotSpot resources or missing guest interfaces fail. No CPE
model is consulted. Transport failures return a safe unavailable code.

`configuration_verified` means the reviewed settings were observed. It does not
verify certificate trust from a real client, local script permissions, native
counter semantics, forwarding/offload behavior, zero-bypass traffic, unlimited
hardware capacity or quota overshoot. Run the physical checklist in
`ndahi-home.md` against the actual topology and exact configuration hash. A
readiness result never toggles Home or installs firewall/topology rules.

Native quota/expiry cutoff records are added only after confirmed gateway
revocation and final accounting. Unconfirmed revocation remains retry/pending.
Counter/epoch loss remains fail-closed for support review; retries do not recreate
allowance. Terminal households stop generating repeat refresh/cutoff jobs.

## 3. Operational diagnostics and support (#177)

Home management reports pending/review counts, oldest known queue age, missing or
stale usage, confirmed-payment-to-first-authorization samples/p95, accounting
failures/reviews and confirmed gateway cutoff observations. Missing measurements
are null/not observed, never zero-duration success. Converted direct purchases are
excluded from Home purchase activation timing. Runtime timing includes outages;
it is not the separate healthy-pilot p95 sample set.

GET diagnostics do not expose router secrets or full upstream MACs. External
readiness work runs after the authorized session transaction, so slow management
requests do not hold the write transaction open. Owner/operator roles remain
required; reseller/auditor roles cannot inspect or mutate Home records. Retry and
revoke still require an audit reason and retain their existing revocation/accounting
barriers. Browser errors retain entered reasons and allow a fresh retry.

The 100-household synthetic worker test verifies four bounded 25-operation batches,
no duplicate refresh rows and fresh recorded observations. It does not establish
real gateway throughput or the proposed 60-second freshness target at physical load.

## 4. Pilot reports and enablement decision (#178)

Download an empty template from Home management, copy
`ndahi-home-pilot.example.json`, or run:

```sh
node scripts/check-home-pilot.mjs --template > home-pilot.json
node scripts/check-home-pilot.mjs home-pilot.json
```

Record actual model/revision/firmware and gateway version; this is evidence
metadata, not a model allow-list. Record UTC start/completion, configuration hash,
NAT/private-LAN capabilities, duplex decimal-GB accounting at an independent
capture point, and a SHA-256 evidence reference for each required scenario.

Each of at least 100 quota trials has a distinct `trialId`, `remainingBytes`,
`measuredBytes`, `newInternetConnections` after confirmed cutoff and `evidenceHash`.
Each of at least 100 healthy activation trials has a distinct `trialId`,
`latencyMs` from server-confirmed payment to gateway confirmation, and evidence
hash. Report real trials; duplicating one result is rejected. Required scenarios
include HTTPS, negative linking, two private clients, quota/expiry, IPv6/FastTrack,
backend/router restart, signal loss, off-site renewal, paid/router-offline recovery,
replacement, rollback and older-device/accessibility acceptance.

The evaluator checks ≤1 MiB maximum overshoot, zero successful new internet
connections after cutoff and ≤30s activation p95, plus scenario completeness and
valid timestamps. These are proposed acceptance targets, not RouterOS guarantees.
Keep independent traces and their byte-boundary explanation; a hash alone cannot
prove the measurement. Established-flow cessation and required portal/provider
paths must be covered in the referenced scenario evidence too.

Owner/operators can import a report with an audit reason. Only bounded summary,
report JSON fingerprint and audit metadata are stored, not raw uploaded
fields/capture contents. Reimporting the same report is idempotent. Reports are
explicitly **operator-reported**, even when complete. A synthetic report is
`simulation_only`; missing/failing results remain `incomplete_or_failed`.
`reported_pass` still requires independent review. No report automatically enables
Home, certifies every router model, closes an issue or changes any entitlement.

Leave #170/#175/#178 and relevant remaining gates open until actual evidence is
reviewed. Enabling Home is a separate controlled rollout after database, gateway,
physical/provider, security and rollback acceptance; preserve ordinary direct
customers and the recovery management path.
