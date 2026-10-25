# Combined Account profile editing (#130)

Account has one Edit profile action with prepopulated full name, account number and optional email. Partial API input preserves omitted fields. Name-only changes use the authenticated account/session and CSRF protections. Account-number changes, email replacement/confirmation and email removal require fresh PIN or action-bound WebAuthn proof. Account IDs, payment/payer history, vouchers, balances, saved devices and router sessions stay attached to the same customer.

## Phone and provider identification

The user clarified on25October2026 that phone handling means automatically suggesting MTN or Orange from the number, rather than adding SIM/SMS ownership verification. Reuse `shared-app/cameroon-phone.js`, the existing prefix mapping and current PIN/passkey ownership proof. The form identifies likely MTN Mobile Money or Orange Money without submitting a payment. Unknown/ported numbers retain a manual provider choice at checkout. A prefix is not proof of carrier or SIM ownership; updated numbers retain `phoneVerified:false`. No SMS provider or credential is introduced.

Cameroon local, +237 and00237 forms normalize to the same account number. The API exposes E.164 (`phoneE164`); canonical existing nine-digit storage remains compatible with login/router/payment paths. Uniqueness checks compare normalized numbers and run within the existing store transaction/constraints. Another customer's account cannot be merged or transferred.

## Atomic edits and verification

`POST /api/account/profile` accepts one, two or all three fields. Name/phone changes with unchanged email commit together after any required proof. If a new/changed email is included, all submitted changes stage inside the existing `pendingEmail` row. Until the code is confirmed, the original name, phone and trusted email remain unchanged. Confirmation applies the staged fields together, records mailbox verification, revokes old portal sessions/challenges and creates a current session. Physical Wi-Fi/approvals are preserved.

Passkey options at `/api/account/profile/options` bind the entire normalized candidate, purpose, current profile/credential version and initiating session. Expired/replayed/cross-session/changed-field proof fails. The existing six-digit email worker, keyed code hash, ten-minute expiry, five guesses, send throttles and bounded async delivery remain authoritative. Concurrent phone collisions are checked again at confirmation before any field is changed.

`expectedVersion` rejects stale browser saves; a customer-scoped `operationId` deduplicates uncertain requests. The last20 operation receipts contain only hashes, state and time and are excluded from customer responses. Browser recovery reads the authoritative profile/pending operation after a lost reply. Cancelling pending changes removes their usable confirmation. A later independent profile/credential update invalidates staged proof rather than silently overwriting it. Removing email requires an explicit acknowledgement and fresh proof, preserves usable credentials and queues a warning to the previous verified mailbox.

Legacy name/phone/email API paths remain protected for cached clients; the visible UI has no duplicate editing forms. The current issue does not reintroduce authenticator prompts. Combined-edit confirmation hashes use a distinct purpose from legacy email-only requests, so an older API rejects their codes after rollback rather than applying only the email field. The existing legacy email verifier remains compatible. No SQL schema migration is needed: new metadata uses existing customer JSONB fields and is additive. Rollback preserves stable domain IDs/history; old clients can ignore the added fields. Cancel/reissue a staged combined edit across an incompatible rollback instead of manually transplanting verification data.

## Validation and release

Coverage includes all seven field combinations, optional/removed email, normalization, malicious/partial input, CSRF/suspension, uniqueness and version races, mailbox expiry/replay/wrong session, signed passkeys/field binding, idempotency, and rollback of staged/confirmed fields. PostgreSQL tests exercise independent API requests, phone uniqueness, rollback, concurrent confirmation and reopening committed state. Browser journeys run all seven combinations at320/1280px with provider suggestions, errors, lost replies, keyboard entry, reload and retained balances/history; existing portal/email/passkey journeys remain in CI. Exact test counts and source/CI revisions belong in the PR.

Implementation does not establish physical SIM ownership, live email inbox receipt or real device/captive behavior. The user's authorized merge uses normal reviewed Git changes and CI checks. Production revisions and smoke checks are recorded separately after deployment; no real charge, message or router mutation is performed by fixture verification.
