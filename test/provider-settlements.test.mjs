import test from "node:test";
import assert from "node:assert/strict";
import {
  providerSettlementTotal,
  createSettlementReporter,
} from "../lib/provider-settlements.mjs";
const page = (rows, current = 1, pages = 1, total = rows.length) => ({
  status: "success",
  meta: { page_info: { current_page: current, total_pages: pages, total } },
  data: rows,
});
const row = (id, amount, extra = {}) => ({
  id,
  net_amount: amount,
  currency: "XAF",
  status: "completed",
  gross_amount: 999999,
  ...extra,
});
test("settlement total uses all pages of provider net values and excludes pending and other currencies", async () => {
  const report = await providerSettlementTotal({
    settlementPage: async (n) =>
      n === 1
        ? page([row(1, "900.25"), row(2, 400, { status: "pending" })], 1, 2, 4)
        : page([row(3, 100, { currency: "EUR" }), row(4, "99.75")], 2, 2, 4),
  });
  assert.equal(report.amount, 1000);
  assert.equal(report.settlements, 2);
});
test("duplicate settlement IDs are not counted twice and conflicting duplicates fail closed", async () => {
  assert.equal(
    (
      await providerSettlementTotal({
        settlementPage: async () => page([row(1, 900), row(1, 900)], 1, 1, 1),
      })
    ).amount,
    900,
  );
  await assert.rejects(
    providerSettlementTotal({
      settlementPage: async () => page([row(1, 900), row(1, 800)], 1, 1, 1),
    }),
    /Conflicting/,
  );
});
for (const value of [null, "", "bad", Infinity, true, 1.234])
  test(`invalid net amount ${String(value)} is never replaced by gross or zero`, async () => {
    await assert.rejects(
      providerSettlementTotal({
        settlementPage: async () => page([row(1, value)]),
      }),
    );
  });
test("missing pagination and incomplete history cannot produce a total", async () => {
  await assert.rejects(
    providerSettlementTotal({
      settlementPage: async () => ({ status: "success", data: [row(1, 10)] }),
    }),
    /pagination/,
  );
  await assert.rejects(
    providerSettlementTotal({
      settlementPage: async () => page([row(1, 10)], 1, 1, 2),
    }),
    /incomplete/,
  );
});
test("unsupported provider and incomplete multi-provider coverage remain unavailable; mock revenue is never real", async () => {
  const clock = () => new Date("2030-01-01T00:00:00Z");
  const report = await createSettlementReporter({
    clock,
    paymentProviders: ["flutterwave", "mesomb"],
    pays: {
      flutterwave: { settlementPage: async () => page([row(1, 25)]) },
      mesomb: {},
    },
  })();
  assert.equal(report.amount, null);
  assert.equal(report.status, "unavailable");
  assert.equal(report.sources[0].amount, 25);
  const mock = await createSettlementReporter({
    clock,
    paymentProviders: ["mock"],
    pays: {},
  })();
  assert.equal(mock.amount, null);
  assert.deepEqual(mock.sources, []);
});
test("empty complete history is a verified zero and concurrent reads share a short-lived cache", async () => {
  let calls = 0;
  const report = createSettlementReporter({
    clock: () => new Date(),
    paymentProviders: ["flutterwave"],
    pays: {
      flutterwave: {
        settlementPage: async () => {
          calls++;
          return page([], 1, 0, 0);
        },
      },
    },
  });
  const [a, b] = await Promise.all([report(), report()]);
  assert.equal(a.amount, 0);
  assert.deepEqual(a, b);
  await report();
  assert.equal(calls, 1);
});
