const placeholder = /(replace|change-me|example|development|localhost|2468)/i;

function requireValue(env, name, errors) {
  const value = String(env[name] || "").trim();
  if (!value || placeholder.test(value)) errors.push(`${name} must be configured`);
  return value;
}

function requireHttps(env, name, errors) {
  const value = requireValue(env, name, errors);
  if (value && !/^https:\/\//i.test(value)) errors.push(`${name} must use HTTPS`);
}

export function productionConfigErrors(env = process.env) {
  if (env.NODE_ENV !== "production") return [];
  const errors = [];
  requireValue(env, "DATABASE_URL", errors);
  for (const name of [
    "CUSTOMER_SESSION_SECRET",
    "ADMIN_SESSION_SECRET",
    "SECRET_PEPPER",
  ]) {
    const value = requireValue(env, name, errors);
    if (value && value.length < 32) errors.push(`${name} must be at least 32 characters`);
  }
  const bootstrapPassword = requireValue(env, "ADMIN_BOOTSTRAP_PASSWORD", errors);
  if (bootstrapPassword && bootstrapPassword.length < 14) errors.push("ADMIN_BOOTSTRAP_PASSWORD must be at least 14 characters");
  requireValue(env, "ADMIN_USERNAME", errors);
  requireValue(env, "WEBAUTHN_RP_ID", errors);
  requireValue(env, "CUSTOMER_WEBAUTHN_RP_ID", errors);
  for (const name of ["CUSTOMER_APP_URL", "ADMIN_APP_URL", "API_URL"]) {
    requireHttps(env, name, errors);
  }
  const origins = String(env.ALLOWED_ADMIN_ORIGINS || "").split(",").map((x) => x.trim()).filter(Boolean);
  if (!origins.length || origins.some((origin) => !/^https:\/\//i.test(origin))) {
    errors.push("ALLOWED_ADMIN_ORIGINS must contain only explicit HTTPS origins");
  }
  if (env.SESSION_COOKIE_SECURE !== "true") errors.push("SESSION_COOKIE_SECURE must be true");
  if (env.ADMIN_MFA_ENABLED !== "true") errors.push("ADMIN_MFA_ENABLED must be true");
  if (env.MIKROTIK_MODE !== "live") errors.push("MIKROTIK_MODE must be live");
  requireHttps(env, "MIKROTIK_API_URL", errors);
  requireValue(env, "MIKROTIK_USER", errors);
  requireValue(env, "MIKROTIK_PASSWORD", errors);
  if (env.OMADA_MODE !== "live") errors.push("OMADA_MODE must be live");
  requireHttps(env, "OMADA_API_URL", errors);
  requireValue(env, "OMADA_API_TOKEN", errors);
  if (!["live", "flutterwave"].includes(env.PAYMENT_MODE)) {
    errors.push("PAYMENT_MODE must be live");
  }
  requireHttps(env, "FLW_API_URL", errors);
  requireValue(env, "FLW_SECRET_KEY", errors);
  requireValue(env, "FLW_SECRET_HASH", errors);
  if (env.EMAIL_MODE !== "live") errors.push("EMAIL_MODE must be live");
  requireHttps(env, "EMAIL_API_URL", errors);
  requireValue(env, "EMAIL_API_KEY", errors);
  requireValue(env, "EMAIL_FROM", errors);
  return [...new Set(errors)];
}

export function assertProductionConfig(env = process.env) {
  const errors = productionConfigErrors(env);
  if (errors.length) throw new Error(`Invalid production configuration:\n- ${errors.join("\n- ")}`);
}

export function enabledPaymentProviders(env = process.env) {
  if (env.PAYMENT_MODE === "mock" && env.NODE_ENV !== "production") return ["mock"];
  return ["live", "flutterwave"].includes(env.PAYMENT_MODE)
    ? ["flutterwave"]
    : [];
}
