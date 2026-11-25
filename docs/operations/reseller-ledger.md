# Reseller ledger operations

Owners manage reseller stock, prospective commission rates, cash remittances and signed balance corrections in the reseller ledger. Resellers see only their own ledger. Customer identity and payer details are excluded.

Activated sold stock creates gross cash responsibility at its historical commission rate. Revocation or access refund does not erase completed cash responsibility: use an audited correction with a reason. Negative corrections reduce debt; overpayment remains a credit. Rate changes snapshot existing stock and apply prospectively. Activated reseller sales cannot be reclassified as gifts to erase cash. Ledger reads do not change vouchers.

Cash and correction writes require an operation key. Exact retries return the original result; changed payloads or reuse for another action conflict. The browser stores the pending immutable request in session storage before sending it and retains it after an uncertain reply, including reload. Retry that pending request to resolve it. Financial writes require working session storage. Do not clear pending storage until the outcome is confirmed.

Tests use synthetic local records and disposable PostgreSQL. Deployment verification must not create real cash entries or trigger purchases.

## One commission rate for every reseller (#390, 25 November 2026)

The owner chose one commission rate for all resellers ([#390](https://github.com/ImaJin14/Ndahi-Connect/issues/390#issuecomment-7153995042)).

- **Admin → Resellers shows "Commission split: N%".**
- **"Change" sets the rate** (owner only). It is stored as `resellerSettings.commissionPercent` and applies to codes issued from then on, for every reseller.
  - Before anything changes, each reseller's existing codes get the rate they had recorded on them. Codes already issued, sold or not, keep their rate (#261), so no completed sale is rewritten.
  - A reseller account with no rate of its own uses the stored rate; it is 10% until the owner sets one.
- **Audit:** the change is audited as `reseller.commission_split_updated`, and each reseller's commission history notes it.
- **v1's per-reseller form still works.** It sets one reseller's own rate until the next Change.
- **The v2 screen:** amounts use the comma in English. Each reseller shows their @sign-in name, because accounts have no location. The cash handoff form has no note field, as drawn. Balance corrections and the two histories stay below the drawn screen (owner, 25 Nov).
