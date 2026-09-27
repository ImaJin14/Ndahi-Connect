# API domain modules (ARCH-001, ARCH-002)

`server.mjs` composes request handlers, attaches background workers, and starts the HTTP server. Its existing public exports remain available for scripts and tests.

## Module boundaries

| Module under `lib/api/` | Responsibility |
| --- | --- |
| `http.mjs` | JSON responses, bounded body parsing, cookies, bearer credentials, and client IP resolution |
| `middleware.mjs` | Browser security headers, trusted origins, CSP reports, customer CSRF checks, and authentication throttling |
| `public.mjs` | Catalogue, readiness, and service status |
| `customer-auth.mjs`, `account.mjs` | Customer sign-in/recovery and authenticated account, security, and device actions |
| `admin-auth.mjs` | Administrator sign-in, passkeys, MFA, and logout |
| `admin.mjs` | Administrator authorization, transaction orchestration, and execution of deferred operations |
| `admin-profile.mjs`, `admin-customers.mjs` | Administrator accounts/security and customer support mutations |
| `payments.mjs`, `admin-payments.mjs` | Checkout, payment recovery, receipts, webhooks, and administrator refund/replay operations |
| `vouchers.mjs`, `admin-vouchers.mjs` | Redemption, generation, revocation, and delivery retries |
| `bundles.mjs` | Package creation, editing, and retirement |
| `network.mjs` | Owner setup requests, command replay, integration status, usage sync, disconnection, and zone status |
| `reporting.mjs` | Administrator dashboard, paginated record lists, and CSV export |
| `performance.mjs` | Prometheus metrics endpoint and browser Web Vitals intake |
| `services.mjs` | Per-instance dependency construction, session helpers, settlement, adapters, and workers |
| `state.mjs` | Initial state, local store, catalogue helpers, audit events, voucher views, and expiry cleanup |
| `routing.mjs` | The explicit `NOT_HANDLED` sentinel |

Existing billing, reconciliation, queue, provisioning, persistence, and adapter modules under `lib/` retain their responsibilities.

## Service and repository boundary (ARCH-002)

| Layer | Modules | Knows about |
| --- | --- | --- |
| HTTP | `lib/api/*` route factories | Requests, cookies, sessions, status codes, and choosing a transaction scope |
| Domain services | `lib/domain/vouchers.mjs` (`redeemVoucher`), `lib/domain/purchases.mjs` (`reservePurchase`), `lib/billing.mjs`, `lib/admin-records.mjs` | Business rules on application state. They return outcomes and never write responses or open connections. |
| Repository / unit of work | `store.transaction(fn, { scope })` and `store.snapshot()`, implemented by the memory/JSON store (`lib/api/state.mjs`) and PostgreSQL (`lib/postgres-store.mjs`) | Loading state, change tracking, locking, conflict detection, and retries |

Domain services are tested directly on plain state in `test/domain.test.mjs` and `test/admin-records.test.mjs`, without a server, store, or database. External effects (payment provider submission, router commands, email) are requested through returned identifiers or queued records and run after commit.

Other handlers (PIN reset, passkeys, account security, and administrator mutations) still keep their rules inline. Move them behind domain functions as they change. The repository still loads the full state for each transaction. Per-workflow queries are the next step when dataset size requires it.

## Request and transaction contract

1. The server resolves the client IP and rejects non-API paths.
2. Common middleware runs before any domain handler. A rejection terminates dispatch.
3. A handler returns `NOT_HANDLED` only when no route matched. A matched route can return `undefined` after sending its response or scheduling deferred work; it must not fall through to another handler.
4. Administrator authentication endpoints run before the protected administrator wrapper. Protected domain handlers are composed only inside that wrapper, after session, CSRF, and role validation.
5. Administrator preflight handlers consume bodies for setup/replay/refund-check operations. Other administrator operations share one parsed body and the authorized transaction state.
6. Handlers record deferred network/refund operations in a request-local `effects` object. The administrator wrapper executes these after the transaction resolves. Some legacy handlers still call external services inside unscoped transactions, which is why those transactions are never retried.
7. `mutate(fn)` runs an exclusive transaction. `mutate(fn, { scope, res })` runs a scoped transaction that takes a shared global lock plus locks on its scope keys (`customer:<phone>`, `admin-session:<token>`, `edge:<scope>:<ip>`). It may run concurrently with other scopes and is retried after a write conflict. Scoped callbacks must therefore have no external side effects, and must write responses only through the `res` passed in, which is buffered until commit. `sessionScope(req)` derives the customer scope from the session cookie using a partial read. See [performance](../operations/performance.md#write-concurrency-perf-002).

Each `createHandler()` gets its own services and route instances. Domain modules import shared helpers directly and accept runtime dependencies explicitly. They do not import `server.mjs` or use a global service registry.

## Verification and rollout

Local validation for ARCH-001 on 2026-09-27:

- `npm run check`: passed; includes syntax checks for every extracted module.
- `npm test`: 224 tests passed, including six focused module/composition tests.
- `npm run load-test`: 300 activations, 300 redemptions, zero failed requests, 300 unique voucher codes, and no detected persistence races.

Local validation for ARCH-002 and PERF-001 to PERF-005 on 2026-09-28:

- `npm test`: 246 tests passed. With `TEST_DATABASE_URL` pointing at PostgreSQL 17, the 11 store tests also passed. They cover concurrency, scope serialization, conflict retry, and incremental writes.
- `npm run load-test`: passed on the memory store, and on PostgreSQL 17 via `LOAD_TEST_DATABASE_URL` (300/300, zero failures, 8 conflicts resolved by retry).
- `npm run verify:postgres`, and the billing, plan, security, and network-setup browser journeys: passed.

Changes: migration `004_incremental_ordinals.sql`; `GET /api/admin/records`; `GET /api/metrics`; `POST /api/telemetry/vitals`. The admin dashboard no longer embeds full customer, voucher, payment, session, and audit lists. New variables are `PERFORMANCE_METRICS_ENABLED` and `METRICS_BEARER_TOKEN`. New runtime dependencies are `@prometheus-io/client` and `web-vitals`. Before completing production verification, deploy the reviewed change and smoke-test readiness, customer authentication and checkout, administrator authentication/dashboard, and network setup status/preview. Live hardware writes require the existing commissioning procedure in [network provisioning](../operations/network-provisioning.md).
