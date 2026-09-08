import test from "node:test";
import assert from "node:assert/strict";
import { ApiError, friendlyError } from "../customer-app/errors.js";

test("WebAuthn diagnostics are replaced with customer-safe guidance", () => {
  const error = new Error("The operation either timed out or was not allowed. See: https://www.w3.org/TR/webauthn-2/");
  error.name = "NotAllowedError";
  const copy = friendlyError(error, "passkey");
  assert.equal(copy.title, "Passkey not completed");
  assert.match(copy.message, /voucher and PIN/);
  assert.doesNotMatch(copy.message, /w3\.org|timed out|not allowed/i);
});

test("API failures keep useful safe messages while server errors stay generic", () => {
  assert.equal(friendlyError(new ApiError(409, "Your bundle is still active.")).message,
    "Your bundle is still active.");
  const server = friendlyError(new ApiError(503, "provider stack trace"));
  assert.equal(server.title, "Service temporarily unavailable");
  assert.doesNotMatch(server.message, /provider|stack/i);
});
