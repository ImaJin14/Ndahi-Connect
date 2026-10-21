# Current vouchers and retained history

The customer Vouchers view defaults to the current active code, with Copy code,
Download PDF, remaining data and expiry. **View voucher history** opens All;
Active, Expired and Exhausted filters remain available. History uses six cards
per page and puts the current active voucher first. Other recorded states,
including renewed/switched/refunded/revoked, remain labeled and reachable in All.
Without a current code the screen explains that state and links to history/plans.

The display checks expiry when opening the view and periodically while visible.
A newly expired current voucher leaves Active and appears in Expired without
mutating its saved record. Source status, financial references, router admission
and server authorization retain their existing behavior. Viewing, filtering,
copying or downloading an old code does not reactivate it.

Admin keeps its paginated status/search filters and adds inclusive From/Through
UTC dates. Dates use activation time, falling back to creation for unactivated
codes. Records without a recorded date remain available when no date range is
selected. Date/status/search filtering happens before paging. All existing
states and role restrictions remain; renewed/switched are now explicit options.

Expired/exhausted voucher records are not deleted. Owner-authorized historical
PDF downloads, payment/reconciliation/support/audit and router-cleanup references
are preserved. Permanent purging would need a separate retention/lifecycle design.
Voucher codes stay in their existing protected screens/downloads and do not enter
notification, log or push payloads.

Six new regressions cover current-code choice, mixed states, paging, expiry,
unchanged source references, admin date/status/search combinations, invalid ranges
and cross-account PDF protection. Real-API 320px journeys cover active-first and
historical Copy/PDF, multiple history pages, no-active/expiry states and admin
filter combinations. Deployment and physical-device acceptance remain pending.
