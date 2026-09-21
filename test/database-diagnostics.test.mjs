import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { databaseDiagnostic } from "../lib/database-diagnostics.mjs";

test("database failures expose actionable codes without driver messages or row data", () => {
  for (const code of ["42P01", "28P01", "23505", "EAI_AGAIN"]) {
    const diagnostic = databaseDiagnostic({ code, message: "secret database password", detail: "customer phone" });
    assert.equal(diagnostic.code, code);
    assert.ok(diagnostic.hint.length > 10);
    assert.doesNotMatch(JSON.stringify(diagnostic), /secret|customer phone/);
  }
  assert.equal(databaseDiagnostic({ code: "sensitive-unknown-value" }).code, "DATABASE_UNAVAILABLE");
  assert.equal(databaseDiagnostic(null).code, "DATABASE_UNAVAILABLE");
});

test("database readiness CLI fails safely when no database URL is configured", () => {
  const env = { ...process.env }; delete env.DATABASE_URL;
  const child = spawnSync(process.execPath, ["scripts/check-db-readiness.mjs"], { env, encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.equal(JSON.parse(child.stderr.trim()).code, "DATABASE_URL_MISSING");
});

test("API deployment validates the database before startup instead of running unapproved migrations", async () => {
  const blueprint = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
  const api = blueprint.split("name: ndahi-api")[1].split("\n  - type:")[0];
  assert.match(api, /preDeployCommand: npm run check:database/);
  assert.doesNotMatch(api, /preDeployCommand:.*migrate/);
  const source = await readFile(new URL("../scripts/check-db-readiness.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /INSERT INTO|UPDATE |DELETE FROM|CREATE TABLE|ALTER TABLE/);
});
