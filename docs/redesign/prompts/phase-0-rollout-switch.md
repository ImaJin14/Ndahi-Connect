# Phase 0 — rollout switch (Claude Code)

Paste this into Claude Code from the repo root. It is one PR. Production must look identical afterwards.

---

**Context.** Read `AGENTS.md`, `docs/redesign/execution-plan.md` (Phase 0) and `docs/redesign/decisions.md`. Then read `static-server.mjs` (it picks `customer-app/`, `admin-app/` or `store-app/` from `APP_KIND`), `customer-app/sw.js`, `admin-app/sw.js`, `lib/api/middleware.mjs` (`STORE_APP_URL`, CORS), `lib/performance.mjs`, `render.yaml` and `render.staging.yaml`.

**Scope.** Add the plumbing that lets one visitor see v2 while everyone else keeps v1:

1. Create `customer-app-v2/` and `admin-app-v2/` as exact copies of `customer-app/` and `admin-app/`.
2. In `static-server.mjs`, for the customer and admin kinds, choose the folder per request:
   - `?ui=new` or `?ui=old` sets a `ndahi_ui` cookie (`new`/`old`; `HttpOnly`, `Secure`, `SameSite=Lax`, 90 days) and redirects to the same URL without the parameter.
   - Otherwise use the cookie if present.
   - Otherwise, customer only: bucket the visitor into v2 with probability `UI_V2_PERCENT` (integer 0–100, default 0) and set the cookie so the choice sticks. Admin has no percentage; staff opt in with `?ui=new`.
   - `UI_V2_OFF=true` forces v1 for everyone and ignores the cookie and query.
   - `store-app` is untouched.
   - Responses that depend on the cookie send `Vary: Cookie`.
3. Service workers: put the variant in the cache name (for example `ndahi-shell-v2-…`) and make each variant delete only its own old caches, so switching never serves the other variant's files.
4. Tag performance metrics and request logs with `ui: "v1" | "v2"` so payment completion and errors can be compared.
5. Check that the portal origin can call the store endpoints with the `customer_session` cookie (CORS in `lib/api/middleware.mjs` currently expects `STORE_APP_URL`). If it can't, allow the customer portal origin too. Add a test.
6. Add `UI_V2_PERCENT` (`"0"`) and `UI_V2_OFF` (`"false"`) to both Render blueprints for the customer and admin services.
7. Add unit tests for the variant choice (query, cookie, percentage at 0 and 100, kill switch, admin ignores percentage) and add the new files to `npm run check`.

**Rules.** No framework or new dependencies. Don't change anything inside the v2 folders beyond the service-worker cache name — they start as copies. Don't touch `lib/` auth code. Keep the existing security headers and CSP on every response.

**Proof.** `npm run check` and `npm test` pass. Run the browser journeys once normally and once with `?ui=new`; both pass. Note in the PR that defaults leave production on v1.

**Stop.** Open a draft PR and stop. Never change `UI_V2_PERCENT` from `0`.
