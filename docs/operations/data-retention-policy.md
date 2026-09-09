# Data retention and archival policy

Owner: NDAHI Connect product owner and security administrator  
Last reviewed: 2026-09-09  
Automation: `ndahi-data-retention`, daily at 02:17 UTC

This is a conservative operational baseline, not a statement of legal compliance.
The owner must review applicable accounting, telecommunications, privacy, dispute,
and litigation-hold requirements before shortening a period or deleting customer or
payment records.

| Record class | Online retention | Disposition | Archive retention |
| --- | ---: | --- | ---: |
| Customer/admin sessions | Expiry + 7 days | Permanently delete | None |
| Authentication challenges | Expiry + 7 days | Permanently delete; never archive secrets | None |
| Rate-limit events | 7 days | Permanently delete | None |
| Inactive network sessions | 90 days | Archive, then remove online row | 2 years |
| Application events | 1 year | Archive, then remove online row | 2 years |
| Security events | 1 year | Archive, then remove online row | 2 years |
| Provider webhook events | 2 years | Archive, then remove online row | 7 years |
| Audit logs | 2 years | Archive, then remove online row | 7 years |
| Payment records | 7 years online | Copy to archive; keep relational source pending legal/privacy review | 7 additional years |
| Customer records | Review after 2 dormant years | Flag for verified manual privacy workflow; never auto-delete | Until reviewed |

An active voucher or dashboard session prevents a customer from being flagged as
dormant. Legal holds are handled by keeping the relevant source or archive record and
recording the authorization outside this automated job; formal hold tooling belongs to
the later privacy/export work.

## Operation and access

The job executes all changes in one PostgreSQL transaction under an advisory lock.
Rows selected for removal are copied to `retention_archives` first. An insertion or
query failure rolls back the whole run and exits nonzero so Render marks the cron run
failed. Counts from successful runs are recorded in `retention_job_runs` and emitted as
JSON logs. Dormant accounts appear in `retention_reviews` for human action.

Archives and review queues have no public or administrator API. Access is limited to
database operators with production credentials. Operators should review failed cron
runs and daily counts, investigate unusual spikes, and never export archive payloads
to support tickets or general analytics systems.
