# Independent review of device approval and notification inboxes

Review performed on an isolated read-only source snapshot from the implementation
PC: `feat/main-device-approval-inbox`, base `a61988721d04ca83dec23692938754306314c142`,
captured 2026-10-20 07:05:25 UTC. The snapshot included that PC's uncommitted work.
No production credentials, accounts, router configuration or deployments were used.

The existing approval/pairing/notification suite passed 27 tests. Independent
regressions in `test/approval-inbox-independent.test.mjs` reproduced the following
gaps. These are findings against the snapshot, not claims about deployed behavior.

| Case | Trigger and observed result | Required result |
| --- | --- | --- |
| Failed recovery: slots | Verify owner recovery while the bundle's device slots are full; API returns 409 and clears the working main controller. | Preserve the existing controller when connection cannot be queued. |
| Failed recovery: freshness | Verify owner recovery with a stale router reading; the refresh response still clears main control. | Reject/retry without revoking main control. |
| Device observation freshness | Queue a connection, let the other sessions' reading become stale, then confirm only the new connection. The old sessions appear fresh again. | Keep unrelated observations stale until a complete router reading succeeds, or use individual freshness timestamps. |
| Secret rotation | Issue a code, rotate the server pepper with the old pepper still accepted, then reopen the main controller. It displays a different code which does not match the saved verifier. | Preserve the issued code for its bounded lifetime, or explicitly cancel it; never display a code that cannot redeem. |
| Archived activity | Archive an unread alert before the push worker runs. It still sends a new push. | Suppress archived content in the initial selection and locked delivery recheck. |
| Staff deactivation | Disable staff between the worker snapshot and claim. It still claims delivery using the snapshot's authority. | Re-read active staff status before claiming. |
| Staff demotion | Change an owner's role to viewer between snapshot and claim. Owner-only activity still triggers delivery. | Recheck current role and visible notification content before claiming. |
| Unsubscription | Remove a device subscription between snapshot and claim. The worker still sends to the removed endpoint. | Verify current subscription membership before claiming. |
| Customer storage rollback | A preference mutation writes its HTTP 200 response before the transaction commits; a synthetic commit failure rolls back the change but the response remains successful. | Buffer the response with the existing transaction response helper until commit. |
| Admin storage rollback | The admin notification mutation has the same premature-success response on storage failure. | Buffer notification responses in the authorized admin transaction until commit. |

Ten independent cases now reproduce these findings. All reproduction data is synthetic. Run after integrating the implementation:

```sh
node --test test/approval-inbox-independent.test.mjs
```

The tests should pass with the implementation fixes. They exercise behavior across
the real local API and store and simulate consent/role changes between a snapshot
and a claim. They do not assume that a request accepted by a router means the
connection was confirmed.

Implementation resolution (2026-10-20): all ten independent cases now pass.
Recovery revokes the prior controller only after admission has successfully queued
the replacement. Targeted connection confirmation leaves the full-device reading's
timestamp unchanged. Both notification APIs use the existing deferred-response
transaction helper, so a failed commit discards the success response. Code rotation
and push selection/claim rechecks also pass, including archive, current staff role,
deactivation and subscription changes. These tests are included in the normal API
suite; production and hardware checks below remain separate.

Additional rollout checks: wait for all API/bridge instances to run the private
Wi-Fi credential policy before enabling it; verify unpaid portal/API access on
the physical Wi-Fi; test first-device setup, offline-main recovery, missing and
duplicate DHCP names, and Note 8/iPad Air 2 on real hardware. Existing drafts on
the other PC remain preserved. The implementation owner should update the product
checklist and PR with independent regression results after these fixes.
