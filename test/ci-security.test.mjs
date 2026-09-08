import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("CI blocks high vulnerabilities, leaked secrets, and CodeQL findings", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
    dependabot = await readFile(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  assert.match(workflow, /npm audit --omit=dev --audit-level=high/);
  assert.match(workflow, /gitleaks\/gitleaks-action@[a-f0-9]{40}/);
  assert.match(workflow, /github\/codeql-action\/init@v4/);
  assert.match(workflow, /queries: security-extended/);
  assert.match(workflow, /security-events: write/);
  assert.match(dependabot, /package-ecosystem: npm/);
  assert.match(dependabot, /package-ecosystem: github-actions/);
  assert.equal(workflow.includes("continue-on-error: true"), false);
});
