import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runInNewContext } from "node:vm";
import { parse } from "yaml";
import { blueprintServices, environmentDrift } from "../lib/environment-drift.mjs";

const text = await readFile(new URL("../render.staging.yaml", import.meta.url), "utf8");
const blueprint = parse(text), services = blueprintServices(text);
const production = parse(await readFile(new URL("../render.yaml", import.meta.url), "utf8"));

test("staging resources cannot share production names, domains or database links", () => {
  const productionNames = new Set([...production.services, ...production.databases].map((item) => item.name));
  const productionDomains = new Set(production.services.flatMap((item) => item.domains || []));
  const databases = new Set(blueprint.databases.map((item) => item.name));
  for (const resource of [...blueprint.services, ...blueprint.databases]) {
    assert.ok(!productionNames.has(resource.name), resource.name);
    for (const domain of resource.domains || []) assert.ok(!productionDomains.has(domain), domain);
    for (const entry of resource.envVars || []) {
      if (entry.fromDatabase) assert.ok(databases.has(entry.fromDatabase.name), resource.name);
      assert.ok(!entry.fromGroup, "staging must not inherit a production credential group");
    }
  }
  for (const service of blueprint.services) assert.equal(service.autoDeployTrigger, "off", service.name);
  const api = blueprint.services.find((service) => service.name === "ndahi-staging-api");
  assert.match(api.preDeployCommand, /check:environment -- ndahi-staging-api && npm run migrate:postgres && npm run check:database$/);
});

test("staging retains launch validation and rejects a production frontend target", () => {
  const api = services.get("ndahi-staging-api");
  assert.equal(api.env.get("BOOTSTRAP_MODE").value, "false");
  const frontend = services.get("ndahi-staging-customer");
  const env = Object.fromEntries([...frontend.env].map(([key, value]) => [key, value.value]));
  assert.deepEqual(environmentDrift(frontend.name, services, env, "render.staging.yaml").errors, []);
  assert.ok(environmentDrift(frontend.name, services, { ...env, API_URL: "https://api.ndahiconnect.net" }, "render.staging.yaml")
    .errors.some((error) => error.startsWith("API_URL differs from render.staging.yaml")));
  const failures = environmentDrift(api.name, services, { NODE_ENV: "production", BOOTSTRAP_MODE: "false", PAYMENT_MODE: "mock" }, "render.staging.yaml");
  assert.ok(failures.errors.some((error) => error.startsWith("PAYMENT_MODE differs")));
  assert.ok(failures.errors.some((error) => error.startsWith("DATABASE_URL is missing")));
});

test("staging CLI selects its own Blueprint and disallows arbitrary environment file reads", async () => {
  const run = (env) => promisify(execFile)(process.execPath, ["scripts/check-environment.mjs", "ndahi-staging-customer"], {
    env: { PATH: process.env.PATH, NODE_ENV: "production", HOST: "0.0.0.0", PERFORMANCE_METRICS_ENABLED: "true",
      API_URL: "https://staging-api.ndahiconnect.net", ...env },
  }).then(({ stdout, stderr }) => ({ code: 0, output: stdout + stderr }),
    (error) => ({ code: error.code, output: error.stdout + error.stderr }));
  const passed = await run({ RENDER_BLUEPRINT_FILE: "render.staging.yaml" });
  assert.equal(passed.code, 0, passed.output);
  const crossed = await run({});
  assert.equal(crossed.code, 1);
  assert.match(crossed.output, /render.yaml does not declare/);
  const rejected = await run({ RENDER_BLUEPRINT_FILE: "../private-secret-file" });
  assert.equal(rejected.code, 1);
  assert.match(rejected.output, /must be render.yaml or render.staging.yaml/);
  assert.ok(!rejected.output.includes("private-secret-file"));
});

test("smoke dispatch targets staging even when repository production variables exist", async () => {
  const workflow = parse(await readFile(new URL("../.github/workflows/deployment-smoke.yml", import.meta.url), "utf8"));
  const smoke = workflow.jobs.smoke.steps.find((step) => step.run === "npm run check:deployment");
  const vars = { CUSTOMER_APP_URL: "https://portal.ndahiconnect.net", ADMIN_APP_URL: "https://admin.ndahiconnect.net", API_URL: "https://api.ndahiconnect.net" };
  const evaluate = (key, environment, manual = true, values = vars) => runInNewContext(
    smoke.env[key].slice(3, -2).trim(), {
      vars: values, inputs: { environment }, github: { event_name: manual ? "workflow_dispatch" : "deployment_status",
        event: { deployment: { environment: manual ? undefined : environment } } },
    }, { timeout: 100 });
  for (const [key, host] of [["CUSTOMER_APP_URL", "portal"], ["ADMIN_APP_URL", "admin"], ["API_URL", "api"]]) {
    assert.equal(evaluate(key, "staging"), `https://staging-${host}.ndahiconnect.net`);
    assert.equal(evaluate(key, "staging", false), `https://staging-${host}.ndahiconnect.net`);
    assert.equal(evaluate(key, "production"), vars[key]);
    assert.equal(evaluate(key, "production", false), vars[key]);
    assert.equal(evaluate(key, "staging", true, { ...vars, [`STAGING_${key}`]: "https://custom-staging.invalid" }), "https://custom-staging.invalid");
  }
});
