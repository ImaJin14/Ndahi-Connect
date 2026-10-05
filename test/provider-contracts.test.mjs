import test from "node:test";
import assert from "node:assert/strict";
import {
  runContracts, main, sandboxConfig, guardedFetch, FLUTTERWAVE_RULES, MESOMB_RULES,
  readOnlyMeSombClient, transactionMismatches, MESOMB_TEST_ACK,
} from "../scripts/check-provider-contracts.mjs";

const flwEnv = {
  CONTRACT_FLW_SECRET_KEY: "FLWSECK_TEST-synthetic-secret",
  CONTRACT_FLW_TRANSACTION_ID: "901", CONTRACT_FLW_TX_REF: "synthetic-ref",
  CONTRACT_FLW_EXPECTED_AMOUNT: "500", CONTRACT_FLW_EXPECTED_CURRENCY: "XAF",
};

test("all real adapters satisfy offline fixtures without reaching the supplied transport", async () => {
  const original = globalThis.fetch;
  let contacted = false;
  const result = await runContracts({ env: flwEnv, fetchImpl: async () => { contacted = true; throw Error("Network must not run"); } });
  assert.equal(result.ok, true);
  assert.deepEqual(result.results.map((entry) => entry.provider), ["flutterwave", "mesomb", "resend"]);
  for (const entry of result.results) {
    assert.ok(entry.checks.length >= 4);
    assert.ok(entry.checks.every((check) => check.pass && check.evidence === "offline_fixture"));
  }
  assert.equal(contacted, false);
  assert.equal(globalThis.fetch, original);
});

test("sandbox configuration fails before any network call and reports key names only", async () => {
  let calls = 0;
  const result = await runContracts({ mode: "sandbox", providers: ["flutterwave"],
    env: { CONTRACT_FLW_SECRET_KEY: "FLWSECK-live-sensitive-value" }, fetchImpl: async () => { calls++; } });
  assert.equal(result.ok, false);
  assert.ok(result.results[0].missing.includes("CONTRACT_FLW_TRANSACTION_ID"));
  assert.equal(calls, 0);
  assert.ok(!JSON.stringify(result).includes("live-sensitive-value"));
  assert.equal(sandboxConfig("flutterwave", { ...flwEnv, FLW_SECRET_KEY: flwEnv.CONTRACT_FLW_SECRET_KEY }).ok, false);
  assert.equal(sandboxConfig("flutterwave", { ...flwEnv, NODE_ENV: "production" }).ok, false);
});

test("Flutterwave sandbox checks reject mismatched settlement fields and restore fetch after failure", async () => {
  const original = globalThis.fetch, requests = [];
  const result = await runContracts({ mode: "sandbox", providers: ["flutterwave"], env: flwEnv,
    fetchImpl: async (url, options) => {
      requests.push({ url: String(url), method: options.method || "GET", redirect: options.redirect });
      return Response.json({ status: "success", data: { id: 901, tx_ref: "foreign-reference", amount: 600, currency: "EUR", status: "successful" } });
    } });
  assert.equal(result.ok, false);
  assert.deepEqual(result.results[0].checks[0].issues, ["reference_mismatch", "amount_mismatch", "currency_mismatch"]);
  assert.equal(requests.length, 3);
  assert.ok(requests.every((request) => request.method === "GET" && request.redirect === "error"));
  assert.equal(globalThis.fetch, original);
});

test("sandbox provider errors cannot echo credentials or customer response data", async () => {
  const result = await runContracts({ mode: "sandbox", providers: ["flutterwave"], env: flwEnv,
    fetchImpl: async () => { throw Error(`secret=${flwEnv.CONTRACT_FLW_SECRET_KEY}; alice@private.invalid; NC-ABCD-2345`); } });
  assert.equal(result.ok, false);
  const output = JSON.stringify(result);
  for (const value of [flwEnv.CONTRACT_FLW_SECRET_KEY, "alice@private.invalid", "NC-ABCD-2345"]) assert.ok(!output.includes(value));
  assert.ok(result.results[0].checks.some((check) => check.error === "provider_error"));
});

test("network guards reject writes, foreign hosts, redirects and unexpected MeSomb reads", async () => {
  let reached = 0;
  const guarded = guardedFetch({ fetchImpl: async (_url, init) => { reached++; assert.equal(init.redirect, "error"); return Response.json({}); }, rules: [...FLUTTERWAVE_RULES, ...MESOMB_RULES] });
  for (const [url, method] of [
    ["https://api.flutterwave.com/v3/charges", "POST"],
    ["https://api.flutterwave.com/v3/transactions/901/verify", "POST"],
    ["https://api.flutterwave.com.attacker.invalid/v3/transactions/901/verify", "GET"],
    ["https://mesomb.hachther.com/api/v1.1/payment/balance/", "GET"],
    ["https://mesomb.hachther.com/api/v1.1/payment/transactions/check/?ids=a,b&source=EXTERNAL", "GET"],
  ]) await assert.rejects(guarded(url, { method }), { code: "blocked_by_guard" });
  assert.equal(reached, 0);
  await guarded("https://api.flutterwave.com/v3/transactions/901/verify");
  await guarded("https://mesomb.hachther.com/api/v1.1/payment/transactions/check/?ids=synthetic-ref&source=EXTERNAL");
  assert.equal(reached, 2);
});

test("bounded transport rejects a stalled provider and leaves no fetch override", async () => {
  const original = globalThis.fetch;
  const guarded = guardedFetch({ fetchImpl: () => new Promise(() => {}), rules: FLUTTERWAVE_RULES, timeoutMs: 15 });
  await assert.rejects(guarded("https://api.flutterwave.com/v3/transactions/901/verify"), { code: "timeout" });
  assert.equal(globalThis.fetch, original);
});

test("MeSomb test acknowledgement and SDK proxy allow one external lookup only", async () => {
  const env = {
    CONTRACT_MESOMB_APPLICATION_KEY: "synthetic-app", CONTRACT_MESOMB_ACCESS_KEY: "synthetic-access",
    CONTRACT_MESOMB_SECRET_KEY: "synthetic-secret", CONTRACT_MESOMB_TRANSACTION_REF: "synthetic-ref",
    CONTRACT_MESOMB_EXPECTED_AMOUNT: "500", CONTRACT_MESOMB_EXPECTED_CURRENCY: "XAF",
  };
  assert.equal(sandboxConfig("mesomb", env).ok, false);
  assert.equal(sandboxConfig("mesomb", { ...env, CONTRACT_MESOMB_TEST_ACCOUNT_ACK: MESOMB_TEST_ACK }).ok, true);
  assert.equal(sandboxConfig("mesomb", { ...env, CONTRACT_MESOMB_TEST_ACCOUNT_ACK: MESOMB_TEST_ACK, CONTRACT_MESOMB_TRANSACTION_REF: "id&source=OTHER" }).ok, false);
  let read = 0;
  const client = readOnlyMeSombClient({ checkTransactions: async () => { read++; return []; } });
  await assert.rejects(client.makeCollect({}), { code: "blocked_by_guard" });
  await assert.rejects(client.checkTransactions(["a", "b"], "EXTERNAL"), { code: "blocked_by_guard" });
  await assert.rejects(client.checkTransactions(["a"], "MESOMB"), { code: "blocked_by_guard" });
  await client.checkTransactions(["a"], "EXTERNAL");
  assert.equal(read, 1);
});

test("missing provider references are mismatches and CLI never defaults to sandbox", async () => {
  assert.ok(transactionMismatches({ reference: "r", amount: 1, currency: "XAF" },
    { status: "paid", providerReference: "undefined", transactionReference: "r", amount: 1, currency: "XAF" }).includes("provider_reference_missing"));
  const lines = [];
  const code = await main(["--sandbox"], { stdout: (line) => lines.push(line), stderr: (line) => lines.push(line) });
  assert.equal(code, 2);
  assert.match(lines.join("\n"), /explicit --provider/);
});

test("MeSomb sandbox uses the installed SDK with a single EXTERNAL read", async () => {
  const requests = [];
  const result = await runContracts({ mode: "sandbox", providers: ["mesomb"], env: {
    CONTRACT_MESOMB_TEST_ACCOUNT_ACK: MESOMB_TEST_ACK,
    CONTRACT_MESOMB_APPLICATION_KEY: "synthetic-app", CONTRACT_MESOMB_ACCESS_KEY: "synthetic-access",
    CONTRACT_MESOMB_SECRET_KEY: "synthetic-secret", CONTRACT_MESOMB_TRANSACTION_REF: "synthetic-ref",
    CONTRACT_MESOMB_EXPECTED_AMOUNT: "500", CONTRACT_MESOMB_EXPECTED_CURRENCY: "XAF",
  }, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), method: init.method });
    return Response.json([{ pk: "synthetic-pk", status: "SUCCESS", amount: 500, currency: "XAF" }]);
  } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(requests.length, 2);
  assert.ok(requests.every((request) => request.method === "GET" && request.url.endsWith("ids=synthetic-ref&source=EXTERNAL")));
});

test("Resend sandbox retrieves a test email without sending or exposing its contents", async () => {
  const requests = [];
  const result = await runContracts({ mode: "sandbox", providers: ["resend"], env: {
    CONTRACT_RESEND_API_KEY: "re_synthetic_contract_key", CONTRACT_RESEND_EMAIL_ID: "synthetic-email-id",
  }, fetchImpl: async (url, init) => {
    requests.push({ url: String(url), method: init.method || "GET" });
    return Response.json({ id: "synthetic-email-id", created_at: "2026-10-05T00:00:00Z", to: ["private@customer.invalid"], html: "private message" });
  } });
  assert.equal(result.ok, true);
  assert.deepEqual(requests, [{ url: "https://api.resend.com/emails/synthetic-email-id", method: "GET" }]);
  assert.ok(!JSON.stringify(result).includes("private"));
});

test("concurrent contract runs serialize global fetch replacement", async () => {
  const original = globalThis.fetch;
  const results = await Promise.all([
    runContracts({ providers: ["flutterwave"] }),
    runContracts({ providers: ["mesomb", "resend"] }),
  ]);
  assert.ok(results.every((result) => result.ok));
  assert.equal(globalThis.fetch, original);
});
