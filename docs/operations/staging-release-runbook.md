# Staging, release and rollback verification

DEP-001/003/004 remain in progress. Repository configuration is prepared; no
staging resources have been provisioned and no rollback drill has been run.

## Provision staging

Create a separate Render Blueprint using `render.staging.yaml`. Render allows a
custom Blueprint filename and manual deployments with `autoDeployTrigger: off`
([Blueprint reference](https://render.com/docs/blueprint-spec)). Review the paid
resource plan before provisioning. Its three web services, PostgreSQL 17 database,
backup and retention jobs have separate names from production.

Configure the declared `staging-portal`, `staging-admin` and `staging-api`
subdomains of `ndahiconnect.net` in DNS. Supply separate administrator credentials,
MeSomb test-account credentials, a dedicated Resend test configuration, isolated
RouterOS/Omada test infrastructure, and a separate R2 backup bucket and encryption
key. Use synthetic customers and test recipient addresses. Confirm MeSomb account
test mode in its dashboard before any checkout: account verification can end test
mode ([MeSomb documentation](https://docs.mesomb.com/development/test-mode)).

Staging uses `NODE_ENV=production`, secure cookies, MFA and `BOOTSTRAP_MODE=false`.
Provider and hardware adapter modes retain production validation. The Blueprint
cannot establish that operator-supplied accounts or hardware are isolated; record
that check before allowing test traffic. Never copy production data or secrets.

The API's pre-deploy command validates the staging Blueprint, applies migrations
to its isolated database using `npm run migrate:postgres`, and checks readiness.
This also allows the new empty staging database to pass its first deployment.
Existing production migration procedures remain
in [the migration runbook](normalized-state-migration-runbook.md).

## Verify a release

Run `npm run check`, `npm test`, `npm run test:browser` and
`npm run check:providers` before deploying the candidate to staging. Configure
GitHub environments named `staging` and `production`. Optional GitHub variables
`STAGING_CUSTOMER_APP_URL`, `STAGING_ADMIN_APP_URL` and `STAGING_API_URL` override
staging domains; production uses `CUSTOMER_APP_URL`, `ADMIN_APP_URL` and `API_URL`.
Staging never falls back to the production variables.
Dispatch **Deployment smoke checks** against staging with bootstrap disabled.
Successful deployment-status events naming `staging`, `production`, or the observed
Render production environments `main - ndahi-api`, `main - ndahi-customer` and
`main - ndahi-admin` trigger smoke checks. The three Render names use the GitHub
`production` environment and production URLs. Other environments and unsuccessful
deployments do not trigger checks. Record the event and smoke-run IDs when verifying
automatic execution; a smoke pass alone does not identify the deployed commit.

### Recover a missing main-branch CI run

Production services use `autoDeployTrigger: checksPass`. Render does not start an
automatic deployment when the new commit has zero checks. After merging, verify
that **CI** started for the new `main` commit and that Render deploys that revision.
Passing pull-request checks belong to the pre-merge revision.

If no main CI run exists, use **Actions → CI → Run workflow → main**, or:

```bash
gh workflow run ci.yml --repo ImaJin14/Ndahi-Connect --ref main
gh run list --repo ImaJin14/Ndahi-Connect --workflow ci.yml --branch main
```

Confirm the dispatched run's `headSha` matches the intended main revision and all
CI jobs pass. This runs the full existing checks without changing production's
deployment gate. Then record each Render deploy's commit/ID, run strict production
smoke checks, and compare the portal's release assets with the tested revision.
If CI passes without a Render deployment, inspect that service's connected branch,
auto-deploy setting and deploy events. Keep GitHub's missing-event cause separate
from the recovery: the October 21 merge had no CI run despite an active push trigger,
and the reason the event was not processed has not been established.

Record the commit and successful Render deploy ID for each service before the
candidate deploy. Rehearse synthetic guest purchase/PIN setup, returning login,
renewal, receipts, authorized/denied admin actions and provider contract checks.
Record results and promote the same commit only after the staging checks pass.

## Application rollback and database forward fix

On a failed smoke check, stop promotion. In Render's Deploys page, choose each
affected service's recorded successful deploy and select **Rollback**. Verify its
artifact is still retained. Dashboard rollback disables automatic deployments;
API rollback does not ([Render rollback documentation](https://render.com/docs/rollbacks)).
For API-based automation, disabling auto-deploys and checking the recorded target
must precede the rollback call. Automated rollback orchestration is still pending.

Check that the previous application supports the current database schema before
rolling it back. If a migration is incompatible, keep the database state and deploy
a compatible forward fix; do not restore a database backup over newer payments or
vouchers as an application rollback. Repeat the strict smoke checks and the
authenticated journeys after recovery. Record recovery duration, commits, deploy
IDs, schema compatibility and results; leave DEP-004 open until this drill succeeds.
