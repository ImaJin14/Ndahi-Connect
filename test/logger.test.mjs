import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { createLogger, errorFields, logRecord } from "../lib/logger.mjs";
import { routeLabel } from "../lib/api/http.mjs";

const capture = (level = "debug") => {
  const lines = [], streams = [];
  const logger = createLogger({ service: "api", level, write: (name, line) => { streams.push(name); lines.push(JSON.parse(line)); } });
  return { logger, lines, streams };
};
const record = (fields) => logRecord({ level: "info", service: "api", event: "test", fields, now: new Date(0) });

test("log records carry severity, service, event and only allowlisted fields", () => {
  const out = record({ requestId: "r-1", status: 200, phone: "677123456", pin: "1234", code: "INVALID_JSON", voucherCode: "NC-ABCD-1234", email: "a@b.cm" });
  assert.deepEqual(out, {
    time: "1970-01-01T00:00:00.000Z", level: "info", service: "api", event: "test",
    requestId: "r-1", status: 200, code: "INVALID_JSON",
    droppedFields: ["phone", "pin", "voucherCode", "email"],
  });
});

test("free-text values are redacted in place, keeping safe context", () => {
  const cases = [
    ["Payment provider request failed (400): Invalid phone 677123456", "Payment provider request failed (400): Invalid phone [redacted]"],
    ["Rejected +237677123456 by provider", "Rejected [redacted] by provider"],
    ["Email delivery failed: invalid `to` field customer.name@example.cm", "Email delivery failed: invalid `to` field [redacted]"],
    ["Voucher NC-7KQ9-M2XP already claimed", "Voucher [redacted] already claimed"],
    ["Voucher nc7kq9m2xp unknown", "Voucher [redacted] unknown"],
    ["Recovery code 7KQ9-M2XP used", "Recovery code [redacted] used"],
    ["Authorization: Bearer abc.def.ghi", "Authorization: [redacted]"],
    ["connect postgresql://service:hunter2@db.internal/ndahi failed", "connect [redacted]/ndahi failed"],
    [`Invalid key sk_live_${"a1".repeat(20)}`, "Invalid key [redacted]"],
  ];
  for (const [input, expected] of cases) assert.equal(record({ errorMessage: input }).errorMessage, expected, input);
});

test("opaque identifiers and commit hashes survive redaction", () => {
  for (let i = 0; i < 500; i++) {
    const id = randomUUID();
    assert.equal(record({ requestId: id, customerId: id }).customerId, id);
  }
  const commit = "3efe911".padEnd(40, "0123456789abcdef");
  assert.equal(record({ commit }).commit, commit);
  assert.equal(record({ route: "/api/payments/:id/confirm" }).route, "/api/payments/:id/confirm");
});

test("secrets are redacted before truncation so a cut-off value cannot leak", () => {
  const key = `whsec_${"Z9".repeat(30)}`;
  const out = record({ errorMessage: `${"x ".repeat(145)}${key}` }).errorMessage;
  assert.ok(out.length <= 300);
  assert.ok(!out.includes("Z9Z9"));
});

test("numeric tallies are kept and other structured values are dropped", () => {
  assert.deepEqual(record({ counts: { expiredSessions: 3, rateLimitEvents: 0 } }).counts, { expiredSessions: 3, rateLimitEvents: 0 });
  const out = record({ counts: { phone: "677123456" }, reason: ["677123456"], attempts: Infinity });
  assert.deepEqual(out.droppedFields, ["counts", "reason", "attempts"]);
});

test("levels filter output, warnings go to stderr, and children bind request IDs", () => {
  const { logger, lines, streams } = capture("info");
  logger.debug("hidden");
  const child = logger.child({ requestId: "req-123" });
  child.info("shown", { status: 200 });
  child.error("failed", errorFields(Object.assign(new Error("lookup for 677123456 failed"), { code: "E_LOOKUP" })));
  assert.deepEqual(lines.map((line) => line.event), ["shown", "failed"]);
  assert.equal(lines[1].requestId, "req-123");
  assert.deepEqual([lines[1].errorName, lines[1].code, lines[1].errorMessage], ["Error", "E_LOOKUP", undefined]);
  assert.deepEqual(streams, ["info", "error"]);
  assert.equal(createLogger({ level: "bogus", write: () => assert.fail("debug must stay hidden") }).debug("x"), undefined);
});

test("route labels replace identifiers and never include query strings", () => {
  assert.equal(routeLabel(`/api/account/payments/${randomUUID()}/status`), "/api/account/payments/:id/status");
  assert.equal(routeLabel("/api/vouchers/NC-7KQ9-M2XP"), "/api/vouchers/:id");
  assert.equal(routeLabel("/api/account/security/logout-everywhere"), "/api/account/security/logout-everywhere");
});

async function api(t, opts = {}) {
  const { logger, lines } = capture();
  const server = createServer({ store: createStore({ persistent: false }), logger, ...opts, env: {
    NODE_ENV: "test", PAYMENT_MODE: "mock", EMAIL_MODE: "mock", MIKROTIK_MODE: "mock", OMADA_MODE: "not-configured",
    SESSION_COOKIE_SECURE: "false", BILLING_WORKER_ENABLED: "false", SECURITY_ALERTS_ENABLED: "false",
    PAYMENT_WEBHOOK_REPLAY_ENABLED: "false", NETWORK_QUEUE_ENABLED: "false", ADMIN_PIN: "9999",
  } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { lines, call: (path, init) => fetch(base + path, init) };
}

test("API requests get a request ID header and one access log without query data", async (t) => {
  const { lines, call } = await api(t);
  const response = await call("/api/plans?phone=677123456&code=NC-7KQ9-M2XP");
  assert.equal(response.status, 200);
  const requestId = response.headers.get("x-request-id");
  assert.match(requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(lines.filter((line) => line.event === "http.request").map(({ time, durationMs, ...rest }) => rest), [{
    level: "info", service: "api", event: "http.request", requestId, correlationId: requestId, method: "GET", route: "/api/plans", status: 200,
  }]);
  const health = await call("/api/health");
  await health.arrayBuffer();
  if (health.status === 200) assert.ok(!lines.some((line) => line.route === "/api/health"), "healthy probes stay quiet");
  assert.ok(!JSON.stringify(lines).includes("677123456") && !JSON.stringify(lines).includes("7KQ9"));
});

test("malformed bodies and unhandled errors never log request data", async (t) => {
  const { lines, call } = await api(t);
  const invalid = await call("/api/account/login/pin", { method: "POST", headers: { "content-type": "application/json" }, body: '{"phone":"677123456","pin":"8642"' });
  assert.equal(invalid.status, 400);
  assert.ok(!lines.some((line) => line.event === "http.unhandled_error"));

  const real = createStore({ persistent: false });
  const failing = await api(t, { store: { ...real, transaction: async () => { throw Error("write failed for 677123456 <owner@example.cm> NC-7KQ9-M2XP"); } } });
  const purchase = await failing.call("/api/purchase", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ phone: "677123456", name: "Test Customer", email: "owner@example.cm", planId: "weekly", network: "mtn", requestKey: "log-check" }) });
  await purchase.arrayBuffer();
  const error = failing.lines.find((line) => line.event === "http.unhandled_error");
  assert.equal(error.requestId, purchase.headers.get("x-request-id"));
  assert.equal(error.errorMessage, undefined);
  const logged = JSON.stringify([...lines, ...failing.lines]);
  for (const secret of ["677123456", "8642", "owner@example.cm", "7KQ9", "Test Customer"]) assert.ok(!logged.includes(secret), secret);
});
