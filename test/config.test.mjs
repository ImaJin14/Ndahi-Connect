import test from "node:test";
import assert from "node:assert/strict";
import { assertProductionConfig, enabledPaymentProviders, productionConfigErrors } from "../lib/config.mjs";

const production = {
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://service:secret@db.internal/ndahi",
  CUSTOMER_SESSION_SECRET: "c".repeat(40),
  ADMIN_SESSION_SECRET: "a".repeat(40),
  SECRET_PEPPER: "p".repeat(40),
  ADMIN_USERNAME: "owner",
  ADMIN_BOOTSTRAP_PASSWORD: "strong-admin-bootstrap-credential",
  WEBAUTHN_RP_ID: "admin.ndahi.test",
  CUSTOMER_WEBAUTHN_RP_ID: "portal.ndahi.test",
  CUSTOMER_APP_URL: "https://portal.ndahi.test",
  ADMIN_APP_URL: "https://admin.ndahi.test",
  API_URL: "https://api.ndahi.test",
  ALLOWED_ADMIN_ORIGINS: "https://admin.ndahi.test",
  SESSION_COOKIE_SECURE: "true",
  ADMIN_MFA_ENABLED: "true",
  MIKROTIK_MODE: "live",
  MIKROTIK_API_URL: "https://router.ndahi.test",
  MIKROTIK_USER: "service",
  MIKROTIK_PASSWORD: "router-secret",
  OMADA_MODE: "live",
  OMADA_API_URL: "https://omada.ndahi.test",
  OMADA_API_TOKEN: "omada-secret",
  PAYMENT_MODE: "live",
  FLW_API_URL: "https://api.flutterwave.test/v3",
  FLW_SECRET_KEY: "flutterwave-secret-key",
  FLW_SECRET_HASH: "flutterwave-webhook-secret",
  EMAIL_MODE: "live",
  EMAIL_API_URL: "https://api.resend.com",
  EMAIL_API_KEY: "resend-secret-key",
  EMAIL_FROM: "NDAHI Connect <connect@updates.ndahi.test>",
};

test("production configuration accepts fully live infrastructure", () => {
  assert.doesNotThrow(() => assertProductionConfig(production));
  assert.deepEqual(enabledPaymentProviders(production), ["flutterwave"]);
});

test("production configuration rejects mock and fallback infrastructure", () => {
  const errors = productionConfigErrors({ NODE_ENV: "production", PAYMENT_MODE: "mock" });
  assert.ok(errors.some((error) => error.includes("DATABASE_URL")));
  assert.ok(errors.some((error) => error.includes("PAYMENT_MODE")));
  assert.ok(errors.some((error) => error.includes("MIKROTIK_MODE")));
});

test("development keeps mocks explicitly available for automated tests", () => {
  assert.deepEqual(enabledPaymentProviders({ NODE_ENV: "test", PAYMENT_MODE: "mock" }), ["mock"]);
  assert.deepEqual(enabledPaymentProviders({ NODE_ENV: "production", PAYMENT_MODE: "flutterwave" }), ["flutterwave"]);
  assert.deepEqual(enabledPaymentProviders({ NODE_ENV: "production", PAYMENT_MODE: "mesomb" }), ["mesomb"]);
});

test("production validates only the selected payment provider", () => {
  const mesomb = {
    ...production,
    PAYMENT_MODE: "mesomb",
    MESOMB_APPLICATION_KEY: "mesomb-application-key",
    MESOMB_ACCESS_KEY: "mesomb-access-key",
    MESOMB_SECRET_KEY: "mesomb-secret-key",
    MESOMB_WEBHOOK_SECRET: "whsec_mesomb-webhook-key",
    FLW_SECRET_KEY: "",
    FLW_SECRET_HASH: "",
  };
  assert.doesNotThrow(() => assertProductionConfig(mesomb));
  assert.deepEqual(enabledPaymentProviders(mesomb), ["mesomb"]);
});

test("rotation overlap secrets must be strong and distinct", () => {
  assert.doesNotThrow(() => assertProductionConfig({
    ...production,
    CUSTOMER_SESSION_SECRET_PREVIOUS: "q".repeat(40),
    ADMIN_SESSION_SECRET_PREVIOUS: "b".repeat(40),
    SECRET_PEPPER_PREVIOUS: "r".repeat(40),
  }));
  const errors = productionConfigErrors({
    ...production,
    CUSTOMER_SESSION_SECRET_PREVIOUS: "short",
    ADMIN_SESSION_SECRET_PREVIOUS: production.ADMIN_SESSION_SECRET,
  });
  assert.ok(errors.includes("CUSTOMER_SESSION_SECRET_PREVIOUS must be at least 32 characters"));
  assert.ok(errors.includes("ADMIN_SESSION_SECRET_PREVIOUS must differ from ADMIN_SESSION_SECRET"));
});
