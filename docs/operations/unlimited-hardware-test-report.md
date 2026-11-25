# Unlimited catalogue: hardware test report (#337)

Every acceptance test in spec §6 (`docs/redesign/specs/unlimited-catalog-and-device-locking.md`), what proves it, and its result on the **test HotSpot** and the **RB5009**. The owner fills in the on-site results from the three test plans. Results are recorded, never assumed: a row without a date is untested.

| Status | Meaning |
|---|---|
| ✅ automated | Proved by tests in CI on every change. No router needed. |
| ⏳ on site | Needs the router, phones or a WISP router. Pending until recorded below. |

## Equipment and versions

| | Test HotSpot | RB5009 |
|---|---|---|
| Date tested | | |
| RouterOS version | | 7.24.5 (15 Oct; recheck) |
| Board | | RB5009UPr+S+ |
| Access points | | EAP650-Outdoor (standalone) |
| Phones (models, Android/iOS versions) | | |
| WISP routers (models, firmware) | | |
| API release (`/api/authentication-policy` → `apiRevision`) | | |

## Catalogue and payments

| Spec §6 test | Proved by | Status |
|---|---|---|
| An admin can add, edit, publish, unpublish, reorder and delete bundles; storefront changes take effect without a deployment. | `test/unlimited-catalogue.test.mjs` ("admins create, edit, publish…", "deleting…"); Admin journeys for Bundles and Edit bundle (#338, #339) | ✅ automated |
| Non-admins can't change the catalogue; checkout refuses client overrides of amount, validity, device count or access type. | `test/unlimited-catalogue.test.mjs` ("only owners and operators…"); `test/unlimited-checkout.test.mjs` ("the server prices the checkout…") | ✅ automated |
| Editing or deleting a bundle keeps recorded pending orders, receipts and active subscriptions, including a Home WISP subscriber's sharing entitlement until expiry or revocation. | `test/unlimited-checkout.test.mjs` ("the terms and quote are fixed at checkout…"); `test/unlimited-catalogue.test.mjs` ("an edit may change the access type…", "deleting…"); Home WISP: `home-wisp-test-plan.md` tests 9–10 | ✅ automated, ⏳ on site for Home WISP |
| Old URLs can't start checkout for a deleted or unpublished bundle; restarts and deploys never recreate deleted bundles. | `test/unlimited-catalogue.test.mjs` ("the seed runs once…"); `test/unlimited-checkout.test.mjs` (off-sale refusal) | ✅ automated |
| Payment retries and duplicate callbacks don't create duplicate subscriptions or restart validity. | `test/unlimited-checkout.test.mjs`; the payment idempotency tests | ✅ automated |

## Network

Results come from the test plans: **S** = `unlimited-device-slots-test-plan.md` (#334), **T** = `unlimited-sharing-rules-test-plan.md` (#335), **H** = `home-wisp-test-plan.md` (#336).

| Spec §6 test | Plan tests | Test HotSpot | RB5009 | Notes |
|---|---|---|---|---|
| Phone A on a single-device bundle can browse. Phone B is denied direct access even when Phone A is offline. | S 2, 3, 4 | ⏳ | ⏳ | |
| With mobile data off on both phones, Phone B can join Phone A's hotspot but can't browse through ordinary NAT forwarding over NDAHI. | T 2 (IPv4), T 4 (IPv6 blocked) | ⏳ | ⏳ | |
| A conventional WISP router on personal access can't provide ordinary forwarded internet access to downstream clients. | T 3 | ⏳ | ⏳ | |
| An active registered Home WISP router passes internet traffic to downstream clients. Another router can't use that subscription. | H 2, 3, 4, 5 | ⏳ | ⏳ | |
| Device replacement disconnects the old device before the new one gets access, including under concurrent requests and provisioning retries. | S 6, 7; H 6 | ⏳ | ⏳ | |
| Expiry and revocation end access and clear WISP exceptions. Verify after reconnect, address changes, failed provisioning and router reboot. | S 8; T 6; H 7, 8, 9, 10 | ⏳ | ⏳ | |
| Captive portal sign-in, checkout, payments, reconnection and existing valid subscriptions still work. | S 10; T 7; H 12; HotSpot, billing and Home journeys in CI | ⏳ | ⏳ | Legacy bundle checks before and after each step (`unlimited-rollout.md`) |

## Limitations to record

- TTL and Hop Limit restrict ordinary forwarding; they do not guarantee that all proxying or packet rewriting is blocked (#335).
- IPv6 stays blocked on the HotSpot until IPv6 authorization and its Hop Limit rule are built and tested (#443).
- Only WISP router models that pass H 2–3 count as "supported routers".

## Sign-off

| | Name | Date | Result |
|---|---|---|---|
| Test HotSpot complete | | | |
| RB5009 complete | | | |
| Catalogue switched on (`catalogue.mode_changed` audit entry) | | | |

Post this report, filled in, on #337 before switching the catalogue on.
