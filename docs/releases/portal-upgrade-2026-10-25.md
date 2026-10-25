# Portal upgrade release verification — 25 October 2026

This report covers parent [#128](https://github.com/ImaJin14/Ndahi-Connect/issues/128) and release acceptance [#143](https://github.com/ImaJin14/Ndahi-Connect/issues/143). It replaces the earlier draft's incorrect PR mapping and unsupported completion claims. Software integration and automated verification are complete; physical/provider acceptance remains open. Current deployment and the documentation-merge revision are recorded in [PR #158's final release evidence](https://github.com/ImaJin14/Ndahi-Connect/pull/158).

## Feature provenance

Every row was checked against GitHub's actual merged PR and exact-head check runs on 25 October. All fourteen feature PRs are merged; the issue number is not inferred from a numerical PR range.

| Issue | Feature | Implementation PR | Merge commit | Exact-head CI |
| --- | --- | --- | --- | --- |
| [#129](https://github.com/ImaJin14/Ndahi-Connect/issues/129) | PIN/passkey and recovery management | [#145](https://github.com/ImaJin14/Ndahi-Connect/pull/145) | `553a88fcf59f5f0196340f2d95ba713401f41b74` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40090624787/job/120862360747) |
| [#130](https://github.com/ImaJin14/Ndahi-Connect/issues/130) | Atomic name, account-number and optional-email editing | [#160](https://github.com/ImaJin14/Ndahi-Connect/pull/160) | `dac2fb674339420fd451e09d362c86a9d8625d43` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40171715915/job/121103750031) |
| [#131](https://github.com/ImaJin14/Ndahi-Connect/issues/131) | Retire voucher/account WhatsApp sharing | [#159](https://github.com/ImaJin14/Ndahi-Connect/pull/159) | `4a6be433895f9127ab5f88ee78042c73ccabe34e` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40170340664/job/121099716239) |
| [#132](https://github.com/ImaJin14/Ndahi-Connect/issues/132) | Protect active subscriptions from replacement | [#144](https://github.com/ImaJin14/Ndahi-Connect/pull/144) | `2b471b133065f9e03e13fcfd567e1d30f585855e` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40090402903/job/120861724449) |
| [#133](https://github.com/ImaJin14/Ndahi-Connect/issues/133) | Trusted router, HotSpot and internet evidence | [#146](https://github.com/ImaJin14/Ndahi-Connect/pull/146) | `ac5eb56dad1e072fb1f61b470984766b4ec02ca8` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40095460135/job/120876649912) |
| [#134](https://github.com/ImaJin14/Ndahi-Connect/issues/134) | Automatic accessible device Wi-Fi status | [#147](https://github.com/ImaJin14/Ndahi-Connect/pull/147) | `9450502a38a8229247ab596db2bef299bc5636b4` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40095480851/job/120876714978) |
| [#135](https://github.com/ImaJin14/Ndahi-Connect/issues/135) | Dashboard destination after authentication | [#148](https://github.com/ImaJin14/Ndahi-Connect/pull/148) | `b732f295f3d6a2ceb7d23526e27d6a60e56a70ee` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40097282327/job/120882070459) |
| [#136](https://github.com/ImaJin14/Ndahi-Connect/issues/136) | Informational active-bundle card and quota refresh | [#151](https://github.com/ImaJin14/Ndahi-Connect/pull/151) | `ce6d067fd1a28547ab783ad6c05fa8f539211465` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40113264047/job/120929216043) |
| [#137](https://github.com/ImaJin14/Ndahi-Connect/issues/137) | Persistent notification settings | [#153](https://github.com/ImaJin14/Ndahi-Connect/pull/153) | `4e354fdaaea540f1fb77d31f41f0ecbbdaacc038` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40117690463/job/120942326804) |
| [#138](https://github.com/ImaJin14/Ndahi-Connect/issues/138) | Optional installation and private-safe PWA recovery | [#155](https://github.com/ImaJin14/Ndahi-Connect/pull/155) | `f6414a63e38d98070c50e634ec0ecb5c562a0b30` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40127461081/job/120971838941) |
| [#139](https://github.com/ImaJin14/Ndahi-Connect/issues/139) | Consented background push and verified-email fallback | [#156](https://github.com/ImaJin14/Ndahi-Connect/pull/156) | `414cc9ee00e9b94c505b44bd222dbd14cffd6ca3` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40127574871/job/120972181037) |
| [#140](https://github.com/ImaJin14/Ndahi-Connect/issues/140) | MTN/Orange checkout suggestion with manual correction | [#152](https://github.com/ImaJin14/Ndahi-Connect/pull/152) | `efae6c6453014880e0d1eddf92974586752d4ad0` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40113281509/job/120929267650) |
| [#141](https://github.com/ImaJin14/Ndahi-Connect/issues/141) | Verified transactional-email association and delivery | [#154](https://github.com/ImaJin14/Ndahi-Connect/pull/154) | `8c48cfebce691d7babd66aa64b30faeee06de592` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40127325050/job/120971427568) |
| [#142](https://github.com/ImaJin14/Ndahi-Connect/issues/142) | Retained purchase voucher and repeatable private PDF | [#157](https://github.com/ImaJin14/Ndahi-Connect/pull/157) | `4cefefd267530c036b226c896ca532b9001e5595` | [7 checks green](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40127668904/job/120972467341) |

PR #149 (`7784b79cf059eb6a0363ba66dfe031eb36677aba`) removes a duplicate connection-evidence banner. PR #150 (`c9a66963a87941c3a04aaefe28e244965c8b9a2a`) adds live reduced-motion verification. Neither implements profile editing, WhatsApp retirement or payment-provider suggestions. Previously merged baseline PR #127 retired runtime authenticator flows; this release retains customer PIN/passkey and administrator password/passkey methods. Wi-Fi approval codes remain separate.

The final feature order is #159 → #160 → this corrected report; earlier dependencies #153 → #154 → #155 → #156 → #157 are already integrated. PR #160 merged at `dac2fb674339420fd451e09d362c86a9d8625d43`, with source tree `93c365d68eea746cee629314e24b0d5a40e52550`, exactly matching its reviewed head. This report changes documentation only relative to that code.

## Automated evidence

- PR #160 exact head `4c4da7fe040afeac3db228f1bc026bd42a721c03`: [CI run 40171715915](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40171715915), all seven checks successful. The verify log records **1,023 tests, 1,023 passed, zero failed and zero skipped**, with PostgreSQL 17 enabled. It also runs syntax/environment validation, runtime dependency audit, offline provider contracts and 300-customer load checks in memory and PostgreSQL. Browser CI includes the complete desktop suite and mobile authorization journeys. CodeQL and secret-scanning success are recorded as checks, rather than a claim of independently querying every alert.
- Independent continuation on that same head: `node --test test/unified-profile.test.mjs test/portal-account-tools.test.mjs test/authenticator-retirement-api.test.mjs` passed **44/44**, no skips. `node scripts/check-unified-profile-journeys.mjs` passed **14/14** journeys, all seven field combinations at 320/1280 px, including uncertain replies, reload, retained ownership/history and MTN/Orange suggestions.
- Merged main feature CI: [run 40172440772](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/40172440772). Its final result and this report's exact-head/main checks are linked in PR #158. Prior local runs which skipped PostgreSQL are historical, not the acceptance count for this release.

The source review covered session/CSRF/suspension enforcement; fresh PIN and field/session/credential-bound single-use passkeys; normalized unique account numbers; atomic mailbox-confirmed profile changes; stale/concurrent edits; store rollback and lost-response recovery; private voucher/inbox access; channel consent and payment/approval separation. Existing signed-passkey, rollback, concurrency and browser cases are retained.

The user's 25 October clarification means automatic **MTN/Orange identification**, not SIM/SMS ownership verification. Credential proof authorizes an account-number change; a prefix only suggests the network, manual checkout correction remains available, and `phoneVerified:false` is preserved. Email replacements continue to require mailbox confirmation.

## Deployment and rollback contract

Production targets are the existing Render API, customer and admin services:

| Service | Origin | Release checks |
| --- | --- | --- |
| API | https://api.ndahiconnect.net | `/api/authentication-policy.apiRevision` equals the merged release; `/api/health` reports PostgreSQL ready |
| Customer | https://portal.ndahiconnect.net | `/version.json` matches the built catalog; SHA-256 of delivered profile, voucher, notification, PWA and shared assets matches reviewed source |
| Admin | https://admin.ndahiconnect.net | `/version.json` and delivered login/app/shared-notification hashes match reviewed source |

Render uses `autoDeployTrigger: checksPass`. The merge triggers main CI; successful Render deployment-status events then trigger the existing strict production smoke workflow. API routes are additive and backward compatible with cached clients. Worker/frontend rollouts may overlap through the existing independent services; we do not claim an enforced API-first orchestration. Exact service events, source revisions, deployment smoke runs and read-only live-browser outcomes are recorded in the final PR release comment after convergence.

The pre-feature rollback baseline observed in this continuation is `4a6be433895f9127ab5f88ee78042c73ccabe34e` (#159): PostgreSQL ready, API revision confirmed at 07:25 UTC. GitHub deployment records: API `7309847360`, customer `7309847376`, admin `7309847389`; these are **GitHub deployment record IDs**, not invented Render rollback IDs. Confirm the corresponding successful retained artifact in Render before rolling back. No production rollback drill was performed. [Existing release/rollback runbook](../operations/staging-release-runbook.md).

There is no new SQL migration or destructive data deletion in the final profile/sharing changes. Pending profile metadata and operation receipts use existing customer JSONB fields; customer IDs, bundles, balances, vouchers, historical payer/receipt data and physical Wi-Fi grants remain stable. PostgreSQL uniqueness/race, transaction rollback, concurrent confirmation and reopen coverage runs in CI. Combined-edit confirmation hashes have a distinct purpose: an older API rejects them rather than applying the email half after rollback. Cancel/reissue such pending edits after an incompatible rollback. Never restore an older database over newer payments or vouchers to roll back application code. [Profile compatibility contract](../operations/profile-editing.md).

Separate staging is not provisioned in the recorded runbook; no paid environment was created here. The user authorized the existing production rollout. Production verification performs public reads only, blocks browser writes and does not sign in as or mutate a real customer. Fixture provider acceptance is not a live Mobile Money debit or inbox receipt.

## Acceptance still requiring the operator

| Area | Evidence available | Outstanding acceptance |
| --- | --- | --- |
| Router/AP and genuine browsing | Router/queue/identity fixtures, backend and browser regressions | Real MikroTik/AP restart, primary/secondary reconnect and actual internet browsing |
| Captive portal and installed app | Chromium journeys, separate cookie jars, offline/storage/update fixtures and delivered assets | Native iOS/Android/macOS/Windows captive dismissal, installation, storage continuity and older devices |
| Mobile Money | Expiry/idempotency/concurrency/reconciliation and offline provider contracts | Real configured MTN/Orange request/debit, cancellation/expiry and late settlement acceptance |
| Email | Verified-recipient, durable leases, consent, retry, rollback and template tests | Actual configured-domain inbox/bounce receipt and voucher attachment |
| Background push | Durable dispatch, fingerprints, consent, authority and expiry fixtures | Closed-app OS display, offline/TTL behavior and actual receipt on supported platforms |
| Voucher PDF | Authenticated ownership, valid PDF and repeatable/manual-offer browser tests | File actually saved/opened in native captive and installed browsers |
| Recovery and rollback | PIN/passkey/recovery and transactional rollback tests | Physical credential recovery and a production/staging rollback drill |

Keep #143 and #128 open until these relevant real-world checks are evidenced or explicitly resolved by the user. This report does not add unrelated printer acceptance or claim that tests certify all production behavior. No real outbound message, charge, router configuration or customer-account edit was performed for this verification.
