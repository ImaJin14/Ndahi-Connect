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
  CUSTOMER_APP_URL: "https://portal.ndahi.test",
  ADMIN_APP_URL: "https://admin.ndahi.test",
  API_URL: "https://api.ndahi.test",
  ALLOWED_ADMIN_ORIGINS: "https://admin.ndahi.test",
  SESSION_COOKIE_SECURE: "true",
  ADMIN_MFA_ENABLED: "true",
  OTP_DELIVERY: "live",
  SMS_API_URL: "https://sms.ndahi.test/send",
  SMS_API_KEY: "sms-secret",
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
  assert.ok(errors.some((error) => error.includes("OTP_DELIVERY")));
});

test("development keeps mocks explicitly available for automated tests", () => {
  assert.deepEqual(enabledPaymentProviders({ NODE_ENV: "test", PAYMENT_MODE: "mock" }), ["mock"]);
});
