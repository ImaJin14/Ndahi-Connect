# Issue 259: collected peer branches and integration review

Reviewed 16 November 2026 against local `main` at `f9b060e`. The other PC's
committed Git branches were fetched into this checkout as `peer/outages`
(`2e50d72`) and `peer/outages-screens` (`0afd9d5`). The latter contains the
server and screen changes. These refs are review inputs, not merged or deployed
changes. The peer still owns the outage files and active shared translations.

## Blocking behavior: a second active bundle

`affectedVouchers` in `peer/outages:lib/outages.mjs` includes a previously
expired voucher whose lifetime overlaps the outage. `giveTimeBack` revives that
voucher if the added time moves its expiry into the future, without checking
whether the customer has since acquired another active voucher.

A read-only reproduction loaded the committed module from Git and used a
customer whose old bundle expired at 09:00, whose replacement started at
09:30, and an outage from 08:00 to 10:00. Giving two hours back produced
`{"affected":["old","new"],"active":["old","new"]}`. This violates
the single-active-bundle rule. The reconciliation must preserve the customer's
credit without creating concurrent active bundles or discarding purchase terms;
cover replacement and concurrent purchase cases in transaction-level tests.

An independent draft fix now exists in `lib/outage-credit-selection.mjs` with
tests in `test/outage-credit-selection.test.mjs`. It selects a single
unambiguous voucher per customer and holds replacements or multiple-active
histories for review. The focused tests pass. It has not been wired into the
peer-owned outage routes: integration must persist the review outcome, avoid
silently treating deferred credits as delivered, and verify concurrency with
purchases under the real transaction boundary.

## Integration and verification

`git merge-tree --write-tree` identified conflicts in twelve files, including
admin and customer screens, PostgreSQL storage/migration, the shared
translations and the preview. Resolve them only after the affected peer claims
are explicitly handed off; preserve the already merged main changes.

The reproduction above is a synthetic unit-level check. No outage code was
merged or deployed, no production outage was modified, and no customer phone,
notification, real router, or compensation was physically verified.
