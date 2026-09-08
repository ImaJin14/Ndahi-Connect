# CI security gates

Last reviewed: 2026-09-08

Every push to `main` and every pull request runs three blocking jobs:

- `verify` installs the locked dependency tree and runs `npm audit --omit=dev --audit-level=high`, syntax checks, integration tests, and the load test.
- `secret-scan` scans full Git history with Gitleaks v3. The action is pinned to its immutable release commit.
- `codeql` runs GitHub CodeQL's extended JavaScript/TypeScript security queries and uploads results to code scanning.

Dependabot checks npm packages and GitHub Actions weekly. Render's `checksPass` deployment trigger means a failing required check must not deploy.

## Repository settings

In GitHub branch protection for `main`, require `verify`, `Secret scanning`, and `CodeQL security analysis` before merging. Require the branch to be current and prevent administrators from bypassing these checks during routine changes. Enable GitHub dependency-graph and code-scanning alerts.

If this repository belongs to a GitHub organization, configure the `GITLEAKS_LICENSE` Actions secret required by Gitleaks. Personal repositories do not require it.

## Finding policy

Critical and high-severity dependency findings, detected credentials, and CodeQL errors block merge and deployment. Never suppress an exposed live secret: revoke and rotate it first, then remove it from Git history according to the incident plan.

A false positive or temporarily accepted high-severity finding requires a time-limited GitHub issue containing the scanner rule/advisory, affected component, exploitability analysis, compensating controls, owner, reviewer approval, and expiry date. Any inline scanner suppression must link to that issue and be scoped to the smallest possible path or fingerprint. Expired approvals block the next release.

Run the local portions before pushing:

```bash
npm ci
npm audit --omit=dev --audit-level=high
npm run check
npm test
```
