# Account identity reconciliation

Account numbers identify the saved account; a different name/email entered at
checkout does not replace that identity. Mobile Money payer numbers identify the
transaction, never the account owner. Signed-in general Packages purchases use
the original account and its saved details. Established public checkouts offer
sign-in/recovery before payment; abandoned unpaid signups remain recoverable.

## Inventory and repair

Run inside the API service's existing configured environment. Do not export the
production database or its credentials to a workstation. No API server, payment
adapter, notification worker, router action or schema migration is started.

```bash
node scripts/reconcile-accounts.mjs
```

The default is a read-only PostgreSQL snapshot. Output contains account IDs,
three-digit number suffixes and conflict counts; no names, addresses, full phone
numbers, credentials, voucher codes or checkout keys. `--file` supports read-only
offline fixture inventory; file writes are deliberately unsupported.

Review `duplicateGroups`, `repairs`, `review`, invalid numbers, orphaned payments
and mismatched voucher ownership. A single original account with conflicting
historical guest-checkout details does not need merging: those are transaction
records, not verified profile changes. Do not rewrite receipts or payer details
to make them match the current profile. Legitimate verified profile edits remain
authoritative.

Automatic repairs normalize an unambiguous stored number or merge later unclaimed
duplicate shells into the earliest registered, credentialed account. All dates
must establish that original account unambiguously. Competing credentials,
verified mailboxes, additional account state, suspensions, pending profile edits,
device/Home authority, unsettled payments/setup, and overlapping active bundles
require case-specific ownership review through existing support recovery.
Sharing a number alone cannot transfer another credentialed identity.

To apply reviewed safe repairs:

```bash
node scripts/reconcile-accounts.mjs --apply \
  --expected-digest REVIEWED_DIGEST \
  --backup-file /tmp/ndahi-account-repair-UNIQUE.json
```

Apply re-reads and validates the keyed digest under the PostgreSQL store's
exclusive transaction lock. Identity/ownership changes after inventory abort
with `STALE_RECONCILIATION`; regenerate and review the report. The backup is
created exclusively with mode 0600 before commit. A backup failure rolls back
all changes. Existing backup files are never overwritten. Retain this private
artifact in the operator's approved secure backup location before the service's
ephemeral filesystem is replaced. Never commit it or attach it to a PR/handoff.

Payment/voucher ownership references move together; IDs, amounts, payer numbers,
receipt snapshots, allowances, usage, expiries, device limits, network sessions
and router commands stay intact. The original name/email/PIN/passkeys/recovery
methods remain intact. Affected browser sessions and authentication challenges
are revoked, requiring original-account sign-in. Each repair writes an audit
entry with the original and retired account IDs. A rerun is a no-op once the
safe repairs are complete. Remaining review cases are not claimed as repaired.

If a commit fails after backup creation, inspect the stored inventory/audit
before retrying with a new backup path. For reversal, use the private before/after
artifact only after comparing current rows with its recorded post-state. Never
restore an old database over later purchases, usage, payments or profile edits.
No automated bulk rollback is provided.

## Validation and acceptance

Regression coverage includes original-profile retention, alternate payers,
private inventory, ambiguous identity blockers, current-credential changes,
backup failure, digest stability after JSONB round trips, transactional foreign
keys, independent-worker races, reopen and repeat-run behavior. Production
inventory/application counts and deployment revisions belong in the release
report. Synthetic tests do not establish real Mobile Money/router acceptance.

## Authorized deployment repair

Production `start:api` runs `scripts/deploy-account-reconciliation.mjs` before serving requests. Version 1 takes an exclusive transaction, inventories the current database and applies the same conservative repair policy as the CLI. Ambiguous ownership remains for review. A durable version marker makes subsequent starts no-ops.

Changed-row before-images are encrypted with AES-256-GCM using a purpose-derived SECRET_PEPPER key and retained atomically in the private zone setting. Preserve the deployment pepper for recovery. Neither the encrypted backup nor account identifiers appear in public status or the owner dashboard. `/api/status` exposes only aggregate completion counts. Startup fails if the repair transaction fails; no router or payment-provider work is performed by this script.
