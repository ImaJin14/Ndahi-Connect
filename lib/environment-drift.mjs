import { parse } from "yaml";
import { productionConfigErrors } from "./config.mjs";

// Findings name keys and committed Blueprint values only; live values may be secrets.
const roles = { "start:api": "api", "start:customer": "customer", "start:admin": "admin" };

export function blueprintServices(text) {
  const services = new Map();
  for (const service of parse(text)?.services || []) {
    if (!service?.name) throw new Error("Every Blueprint service needs a name");
    if (services.has(service.name)) throw new Error(`Duplicate Blueprint service ${service.name}`);
    const env = new Map();
    for (const entry of service.envVars || []) {
      // Environment groups are managed outside this file, so their keys cannot be compared.
      if (entry?.fromGroup) continue;
      if (!entry?.key) throw new Error(`${service.name} has an environment entry without a key`);
      if (env.has(entry.key)) throw new Error(`${service.name} declares ${entry.key} more than once`);
      const source = "value" in entry ? "value"
        : entry.generateValue ? "generated"
          : entry.fromDatabase || entry.fromService ? "linked"
            : entry.sync === false ? "operator"
              : null;
      if (!source) throw new Error(`${service.name} declares ${entry.key} without a value source`);
      env.set(entry.key, { source, value: source === "value" ? String(entry.value) : undefined });
    }
    const script = String(service.startCommand || "").match(/npm run (start:\w+)/)?.[1];
    if (service.type === "web" && !roles[script]) throw new Error(`${service.name} has an unsupported web start command`);
    services.set(service.name, { name: service.name, role: roles[script], domains: service.domains || [], env });
  }
  return services;
}

const isOrigin = (value) => {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.origin === value;
  } catch {
    return false;
  }
};

export function environmentDrift(name, services, env, blueprintName = "render.yaml") {
  const service = services.get(name);
  if (!service) return { errors: [`${blueprintName} does not declare a service named ${name}`], warnings: [], bootstrap: false };
  const errors = [], warnings = [];
  const bootstrap = service.role === "api" && env.BOOTSTRAP_MODE === "true";
  // Bootstrap mode is the declared setup phase: launch blockers and temporary hosts are reported, not fatal.
  const launch = bootstrap ? warnings : errors;
  const set = (key) => String(env[key] ?? "").trim() !== "";

  for (const [key, declared] of service.env) {
    if (declared.source === "value" && env[key] !== declared.value) {
      errors.push(env[key] === undefined
        ? `${key} is not set; ${blueprintName} expects ${JSON.stringify(declared.value)}`
        : `${key} differs from ${blueprintName} (expected ${JSON.stringify(declared.value)}); commit the change or restore the value`);
    } else if (["generated", "linked"].includes(declared.source) && !set(key)) {
      errors.push(`${key} is missing; Render should provide it from the Blueprint`);
    }
  }
  if (service.env.has("BOOTSTRAP_MODE") && !["true", "false"].includes(env.BOOTSTRAP_MODE)) {
    errors.push('BOOTSTRAP_MODE must be exactly "true" or "false"');
  }

  const roleOrigins = (role) => {
    const owners = [...services.values()].filter((other) => other.role === role);
    if (owners.length !== 1) return null;
    return owners[0].domains.map((domain) => `https://${domain}`);
  };
  const checkOrigin = (key, role, findings) => {
    if (!set(key)) return;
    if (!isOrigin(env[key])) return errors.push(`${key} must be an exact HTTPS origin with no path or trailing slash`);
    const expected = roleOrigins(role);
    if (expected?.length && !expected.includes(env[key])) {
      findings.push(`${key} does not match the ${role} service domains in ${blueprintName} (${expected.join(", ")})`);
    }
  };
  const checkRpId = (key, role) => {
    if (!set(key)) return;
    if (!/^[a-z0-9.-]+$/i.test(env[key])) return errors.push(`${key} must be a hostname with no scheme, port or path`);
    const hosts = (roleOrigins(role) || []).map((origin) => new URL(origin).hostname);
    if (hosts.length && !hosts.some((host) => host === env[key] || host.endsWith(`.${env[key]}`))) {
      launch.push(`${key} must match the ${role} service domains in ${blueprintName} or one of their parent domains`);
    }
  };

  if (service.role === "api") {
    // Production-config messages start with the key name; skip keys already reported as drift.
    const reported = new Set(errors.map((message) => message.split(" ")[0]));
    for (const error of productionConfigErrors(env)) if (!reported.has(error.split(" ")[0])) launch.push(error);
    checkOrigin("CUSTOMER_APP_URL", "customer", launch);
    checkOrigin("ADMIN_APP_URL", "admin", launch);
    checkOrigin("API_URL", "api", launch);
    const admins = String(env.ALLOWED_ADMIN_ORIGINS || "").split(",").map((v) => v.trim()).filter(Boolean);
    const expected = roleOrigins("admin");
    if (admins.some((origin) => !isOrigin(origin))) {
      errors.push("ALLOWED_ADMIN_ORIGINS must list exact HTTPS origins with no path or trailing slash");
    } else if (expected?.length && admins.some((origin) => !expected.includes(origin))) {
      launch.push(`ALLOWED_ADMIN_ORIGINS includes an origin outside the admin service domains in ${blueprintName} (${expected.join(", ")})`);
    }
    checkRpId("WEBAUTHN_RP_ID", "admin");
    checkRpId("CUSTOMER_WEBAUTHN_RP_ID", "customer");
  } else if (service.role === "customer" || service.role === "admin") {
    // A frontend without API_URL silently falls back to localhost.
    if (!set("API_URL")) errors.push("API_URL is missing; the frontend would call localhost");
    // Frontends cannot see the API's bootstrap phase, so a temporary API host stays a warning.
    checkOrigin("API_URL", "api", warnings);
  }
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)], bootstrap };
}
