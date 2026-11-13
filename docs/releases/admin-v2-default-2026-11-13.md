# Admin v2 default — 13 November 2026

The owner requested making admin v2 the production default, while leaving the customer portal default unchanged.

Admin now defaults to v2 without a percentage ramp or a Render environment change. A separate host-only interface preference (`ndahi_admin_ui`) migrates the old automatically saved v1 preference. Explicit old/new links remain available, legacy v2 opt-ins work, the kill switch remains authoritative and authentication/session cookies are unchanged. `ADMIN_UI_DEFAULT=v1` retains the legacy admin default for controlled testing or default configuration; production needs no new setting.

The v1 CI browser lane explicitly requests its legacy default; the v2 lane and default-policy/role-isolation regressions continue to exercise the new UI and its guards. Customer sampling, public store settings, API authentication policy, Home enablement and printing policy are not changed.

Exact review, CI and production deployment evidence are recorded in [issue #246](https://github.com/ImaJin14/Ndahi-Connect/issues/246) and its linked PR. Deployment acceptance requires fresh and legacy admin-cookie requests to select v2, explicit old/new choices to work and customer defaults to stay unchanged. Physical account/device acceptance remains separately tracked.
