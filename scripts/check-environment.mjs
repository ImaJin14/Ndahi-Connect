import { readFile } from "node:fs/promises";
import { blueprintServices, environmentDrift } from "../lib/environment-drift.mjs";

const name = process.argv[2] || process.env.RENDER_SERVICE_NAME;
try {
  if (!name) throw new Error("Pass the Render service name, for example: npm run check:environment -- ndahi-api");
  const file = process.env.RENDER_BLUEPRINT_FILE || "render.yaml";
  if (!["render.yaml", "render.staging.yaml"].includes(file)) {
    throw new Error("RENDER_BLUEPRINT_FILE must be render.yaml or render.staging.yaml");
  }
  const services = blueprintServices(await readFile(new URL(`../${file}`, import.meta.url), "utf8"));
  const { errors, warnings, bootstrap } = environmentDrift(name, services, process.env, file);
  if (bootstrap) console.log("BOOTSTRAP_MODE=true: launch blockers are reported as warnings until it is committed as false.");
  for (const warning of warnings) console.log(`WARN ${warning}`);
  for (const error of errors) console.error(`ERROR ${error}`);
  console.log(`Environment check for ${name}: ${errors.length ? "failed" : "passed"} (${errors.length} errors, ${warnings.length} warnings)`);
  if (errors.length) process.exitCode = 1;
} catch (error) {
  // Blueprint and argument errors only; environment values never reach this message.
  console.error(`Environment check could not run: ${error.message}`);
  process.exitCode = 1;
}
