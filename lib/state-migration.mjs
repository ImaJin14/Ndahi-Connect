export const collectionKeys = Object.freeze([
  "customers", "adminUsers", "bundles", "payments", "vouchers", "sessions",
  "dashboardSessions", "adminSessions", "adminPasskeyChallenges",
  "customerPasskeyChallenges", "customerMfaChallenges",
  "customerAccessChallenges", "pinResetChallenges", "adminLoginChallenges",
  "otpChallenges", "adminMfaChallenges", "securityEvents", "events",
  "providerEvents", "rateLimitEvents", "auditLogs",
]);

const unique = (values, label, errors) => {
  const seen = new Set();
  for (const value of values.filter((value) => value !== undefined && value !== null && value !== "")) {
    if (seen.has(value)) errors.push(`${label} is duplicated: ${value}`);
    seen.add(value);
  }
};

export function migrationCounts(state) {
  return Object.fromEntries(collectionKeys.map((key) => [
    key, Array.isArray(state?.[key]) ? state[key].length : 0,
  ]));
}

export function validateLegacyState(state) {
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return ["Legacy state must be a JSON object"];
  }
  for (const key of collectionKeys) {
    if (state[key] !== undefined && !Array.isArray(state[key])) errors.push(`${key} must be an array`);
  }
  const rows = (key) => Array.isArray(state[key]) ? state[key] : [];
  for (const key of ["customers", "adminUsers", "bundles", "payments", "vouchers", "sessions"]) {
    if (rows(key).some((item) => !item?.id)) errors.push(`${key} contains a row without an id`);
    unique(rows(key).map((item) => item?.id), `${key}.id`, errors);
  }
  unique(rows("customers").map((item) => item?.phone), "customers.phone", errors);
  unique(rows("adminUsers").map((item) => item?.username), "adminUsers.username", errors);
  unique(rows("payments").map((item) => item?.providerReference), "payments.providerReference", errors);
  unique(rows("vouchers").map((item) => item?.code), "vouchers.code", errors);
  unique(rows("dashboardSessions").map((item) => item?.tokenHash), "dashboardSessions.tokenHash", errors);
  unique(rows("adminSessions").map((item) => item?.tokenHash), "adminSessions.tokenHash", errors);

  const customerIds = new Set(rows("customers").map(({ id }) => id));
  const paymentIds = new Set(rows("payments").map(({ id }) => id));
  const voucherIds = new Set(rows("vouchers").map(({ id }) => id));
  const adminIds = new Set(rows("adminUsers").map(({ id }) => id));
  const requireRef = (items, field, targets, label) => items.forEach((item) => {
    if (item?.[field] && !targets.has(item[field])) errors.push(`${label} ${item.id || "<no-id>"} references missing ${field} ${item[field]}`);
  });
  requireRef(rows("payments"), "customerId", customerIds, "payment");
  requireRef(rows("vouchers"), "customerId", customerIds, "voucher");
  requireRef(rows("vouchers"), "paymentId", paymentIds, "voucher");
  requireRef(rows("sessions"), "voucherId", voucherIds, "session");
  requireRef(rows("dashboardSessions"), "customerId", customerIds, "dashboard session");
  requireRef(rows("adminSessions"), "userId", adminIds, "admin session");
  for (const key of collectionKeys.filter((key) => key.endsWith("Challenges"))) {
    requireRef(rows(key), "customerId", customerIds, key);
  }
  return errors;
}

export function reconcileMigration(source, destination) {
  const expected = migrationCounts(source), actual = migrationCounts(destination);
  const mismatches = Object.keys(expected).filter((key) => expected[key] !== actual[key])
    .map((key) => `${key}: expected ${expected[key]}, found ${actual[key]}`);
  return { expected, actual, mismatches, matched: mismatches.length === 0 };
}
