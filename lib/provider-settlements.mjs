// Cash settlement totals come only from provider settlement records, never orders or vouchers.
const minor = (value) => {
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    (typeof value === "string" && value.trim() === "") ||
    !Number.isFinite(Number(value))
  )
    throw Error("Invalid settlement amount");
  const amount = Number(value) * 100;
  if (
    !Number.isSafeInteger(Math.round(amount)) ||
    Math.abs(amount - Math.round(amount)) > 0.000001
  )
    throw Error("Invalid settlement precision");
  return Math.round(amount);
};
export async function providerSettlementTotal(
  adapter,
  {
    currency = "XAF",
    maxPages = 100,
    from = "1970-01-01",
    to = new Date().toISOString().slice(0, 10),
  } = {},
) {
  if (typeof adapter?.settlementPage !== "function")
    return {
      status: "unsupported",
      amount: null,
      currency,
      message:
        "The configured provider integration does not expose a complete net settlement history. A balance or confirmed payment total is not a settlement total.",
    };
  const ids = new Map(),
    started = Date.now();
  let pages,
    total,
    sum = 0,
    completed = 0;
  for (let page = 1; page <= maxPages; page++) {
    if (Date.now() - started > 30000)
      throw Error("Settlement report deadline exceeded");
    const response = await adapter.settlementPage(page, { from, to });
    const info = response?.meta?.page_info;
    if (
      response?.status !== "success" ||
      !Array.isArray(response?.data) ||
      !info ||
      !Number.isInteger(info.total_pages) ||
      !Number.isInteger(info.total) ||
      info.total < 0 ||
      info.total_pages < 0 ||
      info.total_pages > maxPages ||
      info.current_page !== page
    )
      throw Error("Incomplete settlement pagination");
    const advertisedPages = Math.max(1, info.total_pages);
    if (
      pages !== undefined &&
      (pages !== advertisedPages || total !== info.total)
    )
      throw Error("Settlement history changed during reading");
    pages = advertisedPages;
    total = info.total;
    for (const row of response.data) {
      if (
        row?.id === undefined ||
        row.id === null ||
        !row.currency ||
        !row.status
      )
        throw Error("Incomplete settlement record");
      const id = String(row.id),
        fingerprint = JSON.stringify([
          row.status,
          row.currency,
          row.net_amount,
        ]);
      if (ids.has(id)) {
        if (ids.get(id) !== fingerprint)
          throw Error("Conflicting settlement record");
        continue;
      }
      ids.set(id, fingerprint);
      if (
        String(row.status).toLowerCase() !== "completed" ||
        row.currency !== currency
      )
        continue;
      const value = minor(row.net_amount);
      if (!Number.isSafeInteger(sum + value))
        throw Error("Settlement total exceeds supported range");
      sum += value;
      completed++;
    }
    if (page === pages) {
      if (ids.size !== total) throw Error("Settlement history is incomplete");
      return {
        status: "available",
        amount: sum / 100,
        currency,
        settlements: completed,
        scope: "provider-account",
        message:
          "Completed provider settlements after provider-reported deductions. Includes all activity in this provider account, not just this platform. Not profit or current balance.",
      };
    }
  }
  throw Error("Settlement page limit exceeded");
}
export function createSettlementReporter({
  pays,
  paymentProviders,
  clock,
  env = {},
}) {
  let cached, pending;
  return async function report() {
    if (cached && +clock() - Date.parse(cached.observedAt) < 300000)
      return cached;
    if (pending) return pending;
    pending = (async () => {
      const from = env.SETTLEMENT_REPORT_FROM || "1970-01-01",
        to = clock().toISOString().slice(0, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
        !Number.isFinite(Date.parse(from)) ||
        new Date(from).toISOString().slice(0, 10) !== from ||
        from > to
      )
        throw Error("Invalid settlement report start date");
      const providers = paymentProviders.filter(
        (provider) => provider !== "mock",
      );
      const sources = await Promise.all(
        providers.map(async (provider) => {
          try {
            return {
              provider,
              ...(await providerSettlementTotal(pays[provider], { from, to })),
            };
          } catch {
            return {
              provider,
              status: "unavailable",
              amount: null,
              currency: "XAF",
              message:
                "The provider settlement report could not be verified. No estimated amount is shown.",
            };
          }
        }),
      );
      const complete =
        sources.length > 0 &&
        sources.every((source) => source.status === "available");
      const amount = complete
        ? sources.reduce((sum, source) => {
            const total = sum + minor(source.amount);
            if (!Number.isSafeInteger(total))
              throw Error("Settlement total exceeds supported range");
            return total;
          }, 0) / 100
        : null;
      cached = {
        status: complete ? "available" : "unavailable",
        amount,
        currency: "XAF",
        basis: "completed-provider-net-settlements",
        from,
        to,
        observedAt: clock().toISOString(),
        sources,
        message: complete
          ? "Provider-account settlement history, after reported fees and deductions. This is not business profit."
          : "A complete net settlement total is not available from every enabled provider. Vouchers, order values and account balances are not substituted.",
      };
      return cached;
    })();
    try {
      return await pending;
    } finally {
      pending = undefined;
    }
  };
}
