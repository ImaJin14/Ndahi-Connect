# Reseller ledger operations

Owners manage reseller stock, prospective commission rates, cash remittances and signed balance corrections in the reseller ledger. Resellers see only their own ledger. Customer identity and payer details are excluded.

Activated sold stock creates gross cash responsibility at its historical commission rate. Revocation or access refund does not erase completed cash responsibility: use an audited correction with a reason. Negative corrections reduce debt; overpayment remains a credit. Rate changes snapshot existing stock and apply prospectively. Activated reseller sales cannot be reclassified as gifts to erase cash. Ledger reads do not change vouchers.

Cash and correction writes require an operation key. Exact retries return the original result; changed payloads or reuse for another action conflict. The browser stores the pending immutable request in session storage before sending it and retains it after an uncertain reply, including reload. Retry that pending request to resolve it. Financial writes require working session storage. Do not clear pending storage until the outcome is confirmed.

Tests use synthetic local records and disposable PostgreSQL. Deployment verification must not create real cash entries or trigger purchases.
