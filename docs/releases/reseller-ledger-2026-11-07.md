# Reseller ledger and account repair release

PR #183 integrates the reseller ledger with current main, including PR #185. Review fixes preserve cash responsibility after access refunds, prevent gift reclassification, retain credits, keep reads pure, require durable operation keys, and recover uncertain browser writes across reload. Owners can enter audited balance corrections.

The API startup performs the authorized one-time conservative existing-account repair using its existing production configuration. Before-images are encrypted and retained in the same transaction; only aggregate results are public. Ambiguous ownership is held for review. See the account reconciliation and reseller ledger runbooks.

Local validation: all 1,187 tests pass with disposable PostgreSQL, zero failures or skips. Owner and reseller journeys pass at 320px and 1280px, including lost-reply/reload retry and balance corrections. Hosted CI, production rollout and the actual repair counts will be recorded on the PR after deployment. No real cash, provider, or router mutation was used for testing. Physical router verification remains separate.
