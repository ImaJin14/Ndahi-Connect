import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { parse } from "yaml";
import { blueprintServices, environmentDrift } from "../lib/environment-drift.mjs";

const text = await readFile(new URL("../render.yaml", import.meta.url), "utf8");
const bootstrapBlueprint = blueprintServices(text);
const launchedText = text.replace(/(key: BOOTSTRAP_MODE\n\s+value: )"true"/, '$1"false"');
const launchedBlueprint = blueprintServices(launchedText);
const secret = "s".repeat(40);

// Blueprint-pinned values plus the operator-entered and generated values a launched API needs.
function apiEnv(overrides = {}, services = bootstrapBlueprint) {
  const env = {};
  for (const [key, { source, value }] of services.get("ndahi-api").env) env[key] = source === "value" ? value : secret;
  return {
    ...env,
    CUSTOMER_APP_URL: "https://portal.ndahiconnect.net",
    ADMIN_APP_URL: "https://admin.ndahiconnect.net",
    API_URL: "https://api.ndahiconnect.net",
    ALLOWED_ADMIN_ORIGINS: "https://admin.ndahiconnect.net",
    WEBAUTHN_RP_ID: "admin.ndahiconnect.net",
    MIKROTIK_API_URL: "https://router.ndahiconnect.net",
    OMADA_API_URL: "https://omada.ndahiconnect.net",
    EMAIL_FROM: "NDAHI Connect <connect@updates.ndahiconnect.net>",
    ...overrides,
  };
}
const launchedEnv = (overrides = {}) => apiEnv({ ...overrides }, launchedBlueprint);
const frontendEnv = (overrides = {}) => ({ NODE_ENV: "production", HOST: "0.0.0.0", PERFORMANCE_METRICS_ENABLED: "true", API_URL: "https://api.ndahiconnect.net", ...overrides });
const has = (messages, pattern) => messages.some((message) => pattern.test(message));

test("render.yaml pins a launchable API configuration", () => {
  assert.notEqual(launchedText, text);
  assert.deepEqual(environmentDrift("ndahi-api", bootstrapBlueprint, apiEnv()), { errors: [], warnings: [], bootstrap: true });
  assert.deepEqual(environmentDrift("ndahi-api", launchedBlueprint, launchedEnv()), { errors: [], warnings: [], bootstrap: false });
});

test("a BOOTSTRAP_MODE change outside render.yaml is drift", () => {
  assert.ok(has(environmentDrift("ndahi-api", bootstrapBlueprint, apiEnv({ BOOTSTRAP_MODE: "false" })).errors, /^BOOTSTRAP_MODE differs/));
  assert.ok(has(environmentDrift("ndahi-api", launchedBlueprint, launchedEnv({ BOOTSTRAP_MODE: "true" })).errors, /^BOOTSTRAP_MODE differs/));
  const { errors } = environmentDrift("ndahi-api", launchedBlueprint, launchedEnv({ BOOTSTRAP_MODE: "TRUE" }));
  assert.ok(has(errors, /BOOTSTRAP_MODE must be exactly/));
});

test("pinned adapters and generated secrets are checked without reporting live values", () => {
  const { errors } = environmentDrift("ndahi-api", bootstrapBlueprint, apiEnv({
    PAYMENT_MODE: "mock-live-value",
    EMAIL_MODE: "mock",
    SECRET_PEPPER: "",
    DATABASE_URL: undefined,
  }));
  for (const pattern of [/^PAYMENT_MODE differs .*"mesomb"/, /^EMAIL_MODE differs .*"live"/, /^SECRET_PEPPER is missing/, /^DATABASE_URL is missing/]) {
    assert.ok(has(errors, pattern), String(pattern));
  }
  assert.ok(errors.every((message) => !message.includes("mock-live-value") && !message.includes(secret)));
});

test("bootstrap mode reports launch blockers as warnings until launch is committed", () => {
  const missing = { MESOMB_SECRET_KEY: "", EMAIL_API_KEY: "replace-me" };
  const bootstrap = environmentDrift("ndahi-api", bootstrapBlueprint, apiEnv(missing));
  assert.deepEqual(bootstrap.errors, []);
  assert.ok(has(bootstrap.warnings, /MESOMB_SECRET_KEY must be configured/));
  assert.ok(has(bootstrap.warnings, /EMAIL_API_KEY must be configured/));
  const launched = environmentDrift("ndahi-api", launchedBlueprint, launchedEnv(missing));
  assert.ok(has(launched.errors, /MESOMB_SECRET_KEY must be configured/));
  assert.ok(has(launched.errors, /EMAIL_API_KEY must be configured/));
});

test("API origins must be exact and match the domains render.yaml declares", () => {
  // Malformed values break CORS and passkeys in any phase.
  for (const overrides of [
    { CUSTOMER_APP_URL: "https://portal.ndahiconnect.net/" },
    { ADMIN_APP_URL: "https://admin.ndahiconnect.net/login" },
    { ALLOWED_ADMIN_ORIGINS: "https://admin.ndahiconnect.net/" },
    { WEBAUTHN_RP_ID: "https://admin.ndahiconnect.net" },
  ]) {
    const [key] = Object.keys(overrides);
    assert.ok(has(environmentDrift("ndahi-api", bootstrapBlueprint, apiEnv(overrides)).errors, new RegExp(`^${key} must `)), key);
  }
  // Temporary Render hosts are allowed while bootstrapping, but not after launch.
  const temporary = {
    CUSTOMER_APP_URL: "https://ndahi-customer.onrender.com",
    ALLOWED_ADMIN_ORIGINS: "https://admin.ndahiconnect.net,https://ndahi-admin.onrender.com",
    WEBAUTHN_RP_ID: "ndahi-admin.onrender.com",
  };
  const bootstrap = environmentDrift("ndahi-api", bootstrapBlueprint, apiEnv(temporary));
  assert.deepEqual(bootstrap.errors, []);
  assert.equal(bootstrap.warnings.length, 3);
  const launched = environmentDrift("ndahi-api", launchedBlueprint, launchedEnv(temporary));
  for (const key of Object.keys(temporary)) assert.ok(has(launched.errors, new RegExp(`^${key} `)), key);
  // A parent domain is a valid WebAuthn relying-party ID.
  assert.deepEqual(environmentDrift("ndahi-api", launchedBlueprint, launchedEnv({ WEBAUTHN_RP_ID: "ndahiconnect.net" })).errors, []);
});

test("frontends require an exact API origin", () => {
  for (const name of ["ndahi-customer", "ndahi-admin"]) {
    assert.deepEqual(environmentDrift(name, bootstrapBlueprint, frontendEnv()), { errors: [], warnings: [], bootstrap: false });
    assert.ok(has(environmentDrift(name, bootstrapBlueprint, frontendEnv({ API_URL: "" })).errors, /localhost/));
    assert.ok(has(environmentDrift(name, bootstrapBlueprint, frontendEnv({ API_URL: "https://api.ndahiconnect.net/" })).errors, /^API_URL must be an exact/));
    assert.ok(has(environmentDrift(name, bootstrapBlueprint, frontendEnv({ NODE_ENV: "development" })).errors, /^NODE_ENV differs/));
    const temporary = environmentDrift(name, bootstrapBlueprint, frontendEnv({ API_URL: "https://ndahi-api.onrender.com" }));
    assert.deepEqual(temporary.errors, []);
    assert.ok(has(temporary.warnings, /^API_URL does not match the api service domains/));
  }
});

test("unknown services and malformed Blueprints fail closed", () => {
  assert.ok(has(environmentDrift("ndahi-missing", bootstrapBlueprint, {}).errors, /does not declare/));
  assert.throws(() => blueprintServices("services:\n  - name: a\n    envVars:\n      - key: X\n        value: one\n      - key: X\n        value: two\n"), /declares X more than once/);
  assert.throws(() => blueprintServices("services:\n  - name: a\n  - name: a\n"), /Duplicate Blueprint service a/);
  assert.throws(() => blueprintServices("services:\n  - name: a\n    envVars:\n      - key: X\n"), /without a value source/);
  assert.throws(() => blueprintServices("services:\n  - name: unknown\n    type: web\n    startCommand: node custom.mjs\n"), /unsupported web start command/);
  assert.equal(blueprintServices("services:\n  - name: a\n    envVars:\n      - fromGroup: shared\n").get("a").env.size, 0);
});

test("every web service checks its environment before deploying", () => {
  const web = parse(text).services.filter((service) => service.type === "web");
  assert.equal(web.length, 3);
  for (const service of web) {
    const command = service.preDeployCommand || "";
    assert.ok(command.startsWith(`npm run check:environment -- ${service.name}`), service.name);
  }
  const api = web.find((service) => service.name === "ndahi-api");
  assert.match(api.preDeployCommand, /check:environment -- ndahi-api && npm run check:database$/);
});

test("the pre-deploy command fails on drift without printing environment values", async () => {
  const run = (service, env) => promisify(execFile)(process.execPath, ["scripts/check-environment.mjs", service], { env: { PATH: process.env.PATH, ...env } })
    .then(({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }), (error) => ({ code: error.code, output: error.stdout + error.stderr }));
  const passed = await run("ndahi-customer", frontendEnv());
  assert.equal(passed.code, 0);
  assert.match(passed.output, /ndahi-customer: passed \(0 errors, 0 warnings\)/);
  const failed = await run("ndahi-api", apiEnv({ PAYMENT_MODE: "leak-check-value" }));
  assert.equal(failed.code, 1);
  assert.match(failed.output, /ERROR PAYMENT_MODE differs/);
  assert.ok(!failed.output.includes("leak-check-value") && !failed.output.includes(secret));
  const unnamed = await run("", {});
  assert.equal(unnamed.code, 1);
  assert.match(unnamed.output, /Pass the Render service name/);
});
