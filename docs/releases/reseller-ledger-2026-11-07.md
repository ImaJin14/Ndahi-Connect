# Reseller ledger and account repair release

PR #183 integrates the reseller ledger with current main, including PR #185. Review fixes preserve cash responsibility after access refunds, prevent gift reclassification, retain credits, keep reads pure, require durable operation keys, and recover uncertain browser writes across reload. Owners can enter audited balance corrections.

The API startup performs the authorized one-time conservative existing-account repair using its existing production configuration. Before-images are encrypted and retained in the same transaction; only aggregate results are public. Ambiguous ownership is held for review. See the account reconciliation and reseller ledger runbooks.

Local validation: all 1,187 tests pass with disposable PostgreSQL, zero failures or skips. Owner and reseller journeys pass at 320px and 1280px, including lost-reply/reload retry and balance corrections. All seven PR checks pass ([PR CI](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/42401322842)); [main CI](https://github.com/ImaJin14/Ndahi-Connect/actions/runs/42401508786) passes. No real cash, provider, or router mutation was used for testing. Physical router verification remains separate.

## Production evidence

PR #183 merged as `826481a171cabd666879f18fe3047984cb2670f7`, with the exact tree of reviewed head `646c88528c9d743fcb2125bce6447e924e815b12`.

| Service | GitHub deployment | Render artifact | Success UTC |
| --- | --- | --- | --- |
| API | 7625359898 | dep-dbnmvg8473hc739r1v90 | 18:37:47 |
| Admin | 7625359889 | dep-dbnmvg8473hc739r1v4g | 18:37:38 |
| Customer | 7625359885 | dep-dbnmvg0473hc739r1utg | 18:37:37 |

API revision matches and PostgreSQL is ready. Customer asset revision `b40fda1c65f97c9181c0` and admin `9e9ed1b0ef6b80d188c9` match; seven delivered source-asset SHA-256 comparisons pass. Six strict smoke groups and six read-only browser checks at 320/1280px pass.

The real database inventory completed at `2026-11-07T18:37:36.707Z`: status `complete`, changed customers `0`, merged customers `0`, review cases `0`, historical checkout differences `6`. No eligible duplicate repair was necessary. The six historical transaction-detail differences are preserved; they do not overwrite the original profile or establish ownership. No customer data or credentials are included in this evidence.
