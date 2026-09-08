import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("external penetration-test package covers every critical product boundary", async () => {
  const brief = await readFile(new URL("../docs/security/penetration-test-brief.md", import.meta.url), "utf8"),
    register = await readFile(new URL("../docs/security/penetration-test-findings.md", import.meta.url), "utf8");
  for (const area of [
    "Customer portal", "Administrator portal", "API:", "Voucher", "MeSomb",
    "Flutterwave", "Resend", "RouterOS", "Omada", "PostgreSQL", "WebAuthn",
    "OWASP ASVS 5.0", "API Security Top 10 2023", "retest",
  ]) assert.match(brief, new RegExp(area, "i"), `${area} must remain in scope`);
  assert.match(brief, /No testing authorization exists/);
  assert.match(register, /Critical/);
  assert.match(register, /High/);
  assert.match(register, /Verified closed/);
  assert.match(register, /Risk accepted/);
});
