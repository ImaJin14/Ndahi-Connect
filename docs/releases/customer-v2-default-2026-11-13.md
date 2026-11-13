# Customer v2 default — 13 November 2026

The owner asked to switch the customer portal to v2 ("switch to customer V2"), after admin v2 became the default earlier the same day ([admin release note](admin-v2-default-2026-11-13.md)).

**What changes**
- The portal defaults to v2 in code. There is no percentage ramp, and no Render or `render.yaml` change.
- Every portal visitor so far was sampled at 0% and saved as `ndahi_ui=v1` for 30 days. That automatic cookie no longer keeps anyone on v1, so they get v2 on their next navigation.
- A deliberate `?ui=old` is saved separately as `ndahi_portal_ui=v1`, so a customer or support agent can keep the old view; `?ui=new` switches it back.
- Legacy `ndahi_ui=v2` opt-ins still work.

**Rollback**
- `UI_V2_OFF=true` stays authoritative.
- `CUSTOMER_UI_DEFAULT=v1` restores the previous behaviour exactly: the saved `ndahi_ui` sample, then `UI_V2_PERCENT` sampling.

**Unchanged**
- Authentication and session cookies, API behaviour, the public store and its launch settings.
- Home enablement, thermal printing, the Phase 6 cutover, and the MikroTik hotspot pages on the router.

**Testing**
- The v1 CI browser lane now also sets `CUSTOMER_UI_DEFAULT=v1`.
- The v2 lane, the HTTP default-policy tests and the cold-route browser suite exercise the new default: fresh and legacy-cookie visitors, plus old/new choices, at 390 and 1280 px.

Review, CI, deployment and live evidence are recorded on the pull request that adds this note.
