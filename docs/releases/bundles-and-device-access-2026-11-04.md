# Bundle and device access release — 4 November 2026

The owner authorized merging and deploying issues #164–#166. Implementation,
production software deployment and read-only hosted verification are complete.
Physical phone/router acceptance and real Mobile Money transactions were not
performed for this release.

## Changes and merges

- [PR #167](https://github.com/ImaJin14/Ndahi-Connect/pull/167): `6f22e1709d26ef4f0934dd9d28e039a172d6b205`.
- [PR #168](https://github.com/ImaJin14/Ndahi-Connect/pull/168): `3e987c7b75f1fea178a7f9d7ef021065f10bbd41`.
- [PR #169](https://github.com/ImaJin14/Ndahi-Connect/pull/169): `772654f7fce4bb2ce0bd931898d7e0840f52b867`.

Daily remains 250 FCFA / 1 GB / 24 hours from verified payment and can be bought
again immediately after expiry or data exhaustion, including on the same day.
Usable active bundles remain protected against stacking. Connect 75 stays at
15,000 FCFA and Max / 100 GB stays at 20,000 FCFA.

Main-device setup is restricted to a usable purchased allowance supporting more
than one device, including custom limits. A one-device owner connects directly;
replacing an occupied connection requires explicit PIN/passkey proof and router
confirmation that the exact prior session is disconnected. Main registration
remains dormant for single-device allowances and can be reused after a valid
upgrade. Queued requests recheck current entitlement, quota, expiry and capacity.

## Automated verification

The final merged tree `772654f7fce4bb2ce0bd931898d7e0840f52b867` exactly matches reviewed head `8083814b5583d76a2abe88c46aea2dd743a536a0`. [Main CI](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41771734586) passed all 1,079 tests with PostgreSQL enabled, zero failures or skips, offline provider contracts, memory/PostgreSQL 300-customer load checks, desktop/mobile browser journeys, dependency audit, secret scanning and CodeQL. Dedicated tests include single-slot races, PostgreSQL rollback/store reopen/multi-worker admission, unconfirmed removal, stale sessions and bundle transitions. No database migration was introduced by these PRs.

## Production deployment and rollback baseline

Production revision: `772654f7fce4bb2ce0bd931898d7e0840f52b867`. Intermediate main CI runs were cancelled so the capability and safe-replacement changes deployed together through the existing Render `checksPass` gate.

- [main - ndahi-admin](https://dashboard.render.com/web/srv-da2u8g0u01pc7387q7sg/deploys/dep-dblb4rk9v7es73cu4140): GitHub deployment `7537814000`, success at `2026-11-04T04:21:42Z`.
- [main - ndahi-customer](https://dashboard.render.com/web/srv-da2u8g0u01pc7387q7s0/deploys/dep-dblb4rk9v7es73cu40sg): GitHub deployment `7537813966`, success at `2026-11-04T04:22:01Z`.
- [main - ndahi-api](https://dashboard.render.com/web/srv-da2u950u01pc7387rlq0/deploys/dep-dblb4rk9v7es73cu3vsg): GitHub deployment `7537813957`, success at `2026-11-04T04:21:43Z`.

Previous successful production revision: `52eb69540202017d935131b3d7edbbeed98d55c3`. Baseline retained artifacts:

- [main - ndahi-customer](https://dashboard.render.com/web/srv-da2u8g0u01pc7387q7s0/deploys/dep-dbkughh7lnhs738c0a1g).
- [main - ndahi-api](https://dashboard.render.com/web/srv-da2u950u01pc7387rlq0/deploys/dep-dbkughh7lnhs738c091g).
- [main - ndahi-admin](https://dashboard.render.com/web/srv-da2u8g0u01pc7387q7sg/deploys/dep-dbkugh97lnhs738c08t0).

No rollback or database restoration was performed. Use the existing release/rollback runbook if recovery is required.

## Hosted acceptance

Live API revision matched `772654f7fce4bb2ce0bd931898d7e0840f52b867` with PostgreSQL ready. All eight public prices/allowances/device limits match the approved catalogue. All six strict deployment smoke groups passed. 18 deployed asset SHA-256 hashes match the tested source. Customer asset revision: `588c05731e55eff52423`. Admin asset revision: `0d6538eff1aa72b47cc9`. 

The 320px and 1280px browser checks confirm all eight offers, repeatable Daily billing terms, protected dashboard entry through public bundles and no JavaScript errors. Only GET/HEAD/OPTIONS requests reached production during browser verification; account/payment/device mutations were blocked. Public pairing configuration at verification: `{"approvalRequired": true, "enabled": true, "matchingReferences": true}`.

Successful automatic deployment smoke runs: [41772765543](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41772765543), [41772733604](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41772733604), [41772733053](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/41772733053).

Actual router/phone switching, private MAC behavior, captive closure and real provider acceptance remain physical checks under the existing release acceptance issues #143/#128. A source/asset deployment check does not certify those physical results.
