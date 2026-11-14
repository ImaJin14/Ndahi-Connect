I found no remaining P1 or P2 issues. This was a read-only review: I didn't run the tests or make any edits.

**What I checked:**

- **No login redirect on 503.** In `app.js:95-114`, a 503 only redirects when `preservePageOnUnavailable` is false. The customer-voucher wrapper (`customer-voucher.js:14`) sets it to true for every call, including the preflight, the generate request and the lost-reply recheck. `vouchers.js:36` does the same for both the list read and the customer-name read. A 401 still goes to login, which is expected.
- **The refresh can't break the receipt.** `onReady` (`app.js:412-416`) now only clears the print containers, sets `lastBatch` and starts `voucherRecords.refresh()` without waiting for it. The reseller-ledger refresh is gone. `refresh()` is `load(true)` (`records.js:78-112`), which catches its own errors, so it can't produce an unhandled rejection. The receipt is drawn before `onReady` runs (`customer-voucher.js:99-101`), and a throw from `onReady` is caught, so the receipt stays on screen.
- **The print screen can't be bypassed.** An unverified result or an unexpected replacement calls `onReady(null)`, so `lastBatch = null`. Opening `#voucher-print` by hand then hits `showBatchPrint`, which sends the user back to `#vouchers` (`app.js:73`). An unverified receipt also shows no Print link.
- **The name cache is safe.** Several refreshes running at once share the same request for a customer, and a failed lookup is removed so a later refresh tries again. When one request fails, every refresh waiting on it removes the same entry, which does no harm. A newer request can't be wiped by an older failure, because a new request only starts after the entry is gone.

**Minor (P3, optional):**

1. **Unnamed customers are looked up again on every refresh.** `vouchers.js:49` removes any lookup that returns no name, not just failed ones. A customer who genuinely has no name gets requested again on every refresh, including the automatic one every 15 seconds while the voucher list is visible. To fix it, remove the entry only when the request fails, for example by having the `.catch` return a marker value that the code checks.
2. **A missing `items` field would throw.** `vouchers.js:53` uses `result.items.map` without a guard, unlike line 40. If the API ever leaves out `items`, the error is caught and shown as "failed to load", so the receipt is still safe. Using `(result.items || [])` would make it consistent.

Side effect, not a bug: the voucher list will now show its own failed/retry state on a 503 instead of redirecting to login. The rest of the dashboard still redirects, so I think this is acceptable.
