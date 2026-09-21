const hints = {
  "42P01": "Required database table is missing; check schema migrations.",
  "42501": "Database role lacks required permissions.",
  "28P01": "Database authentication failed; check credentials.",
  "3D000": "Configured database does not exist.",
  "53300": "Database connection limit reached.",
  "57014": "Database query exceeded its timeout or was canceled.",
  "23503": "Stored data violates a foreign-key constraint.",
  "23505": "Stored data violates a uniqueness constraint.",
  "23514": "Stored data violates a check constraint.",
  ECONNREFUSED: "Database connection refused; check address and availability.",
  ETIMEDOUT: "Database connection timed out; check network access.",
  ENOTFOUND: "Database hostname cannot be resolved from this environment.",
  EAI_AGAIN: "Database DNS lookup failed; check private-network connectivity.",
  HEALTH_TIMEOUT: "Readiness probe exceeded its four-second deadline.",
};

export function databaseDiagnostic(error) {
  const code = Object.hasOwn(hints, error?.code) ? error.code : "DATABASE_UNAVAILABLE";
  return { code, hint: hints[code] || "Database operation failed; check connectivity, SSL, and schema from the API environment." };
}
