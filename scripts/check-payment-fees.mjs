// Compares the Mobile Money fee rules (PAYMENT_FEE_MTN, PAYMENT_FEE_ORANGE) with
// the fees MeSomb actually charged on recent paid payments (#297). Read-only: it
// reads payments from the database and asks MeSomb about them; it writes nothing.
// Prints no phone numbers, names or keys.
//
// Run in the API service's shell (it needs DATABASE_URL and the MESOMB_* keys):
//   node scripts/check-payment-fees.mjs [--limit 30]
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { feeNetworks, parseFeeRule, quotePayment } from "../lib/payment-fees.mjs";

const percent = (part, whole) => whole > 0 ? Math.round(part / whole * 1e6) / 1e4 : null;

// One row per paid payment MeSomb answered for: the price we sent, the fee it
// added, and how that compares with the rule for its network.
export function feeObservations(rows, rules = {}) {
  return rows.filter((row) => Number.isFinite(row.amount) && Number.isFinite(row.fee)).map((row) => {
    const quoted = quotePayment(row.amount, row.network, rules).fee;
    return { ...row, total: row.amount + row.fee, onPrice: percent(row.fee, row.amount), onTotal: percent(row.fee, row.amount + row.fee),
      quoted, matches: quoted === null ? null : quoted === row.fee };
  });
}

// Per network: the range of the fee as a share of the price and of the total,
// and whether the configured rule reproduced every fee.
export function feeSummary(observations, rules = {}) {
  return Object.fromEntries(feeNetworks.map((network) => {
    const rows = observations.filter((row) => row.network === network);
    const range = (key) => rows.length ? [Math.min(...rows.map((row) => row[key])), Math.max(...rows.map((row) => row[key]))] : null;
    return [network, { payments: rows.length, rule: rules[network] ? "set" : "not set",
      feePercentOfPrice: range("onPrice"), feePercentOfTotal: range("onTotal"),
      ruleMatches: rules[network] && rows.length ? rows.every((row) => row.matches) : null,
      mismatches: rows.filter((row) => row.matches === false).map(({ amount, fee, quoted }) => ({ amount, fee, quoted })) }];
  }));
}

// MeSomb's service name, or our own record of the network.
const networkOf = (raw, payment) => ({ MTN: "mtn", ORANGE: "orange" })[String(raw.service || "").toUpperCase()] || payment.network || null;

async function main() {
  const args = process.argv.slice(2), limit = Math.min(200, Math.max(1, Number(args[args.indexOf("--limit") + 1]) || 30));
  const env = process.env, rules = Object.fromEntries(feeNetworks.map((network) => [network, parseFeeRule(env[`PAYMENT_FEE_${network.toUpperCase()}`])]));
  for (const network of feeNetworks) {
    const text = env[`PAYMENT_FEE_${network.toUpperCase()}`];
    console.log(`PAYMENT_FEE_${network.toUpperCase()}: ${!text ? "not set" : rules[network] ? text : `invalid (${text})`}`);
  }
  if (!env.DATABASE_URL || !env.MESOMB_APPLICATION_KEY || !env.MESOMB_ACCESS_KEY || !env.MESOMB_SECRET_KEY)
    throw Error("Run this in the API service's shell: it needs DATABASE_URL and the MESOMB_* keys.");
  const { PaymentOperation } = await import("@hachther/mesomb");
  const mesomb = new PaymentOperation({ applicationKey: env.MESOMB_APPLICATION_KEY, accessKey: env.MESOMB_ACCESS_KEY, secretKey: env.MESOMB_SECRET_KEY });
  try {
    const pricing = (await mesomb.getPricing()).getData();
    delete pricing.key;
    console.log("\nMeSomb pricing (application key removed):\n" + JSON.stringify(pricing, null, 2));
  } catch (error) { console.log(`\nMeSomb pricing: unavailable (${error.message})`); }

  const { createPostgresStore } = await import("../lib/postgres-store.mjs");
  const { blank } = await import("../lib/api/state.mjs");
  const store = createPostgresStore({ connectionString: env.DATABASE_URL, initialState: blank, ssl: env.DATABASE_SSL !== "false" });
  try {
    const s = await store.read([{ rows: { payments: { provider: ["mesomb"] }, storeOrders: true } }]);
    const paid = (p) => p.provider === "mesomb" && p.confirmedAt;
    const payments = [...s.payments.filter(paid), ...s.storeOrders.map((o) => o.payment).filter(paid)]
      .sort((a, b) => Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt)).slice(0, limit);
    const rows = [];
    for (const payment of payments) {
      try {
        const [transaction] = await mesomb.checkTransactions([payment.id], "EXTERNAL");
        const raw = transaction?.getData?.() || transaction || {};
        rows.push({ payment: String(payment.id).slice(0, 8), network: networkOf(raw, payment), amount: Number(raw.amount), fee: Number(raw.fees), reportedTotal: Number(raw.trxamount) });
      } catch (error) { console.log(`${String(payment.id).slice(0, 8)}: MeSomb did not answer (${error.message})`); }
    }
    const observations = feeObservations(rows, rules);
    console.log(`\n${observations.length} paid MeSomb payments:`);
    console.table(observations.map(({ payment, network, amount, fee, reportedTotal, onPrice, onTotal, quoted, matches }) =>
      ({ payment, network, price: amount, fee, total: reportedTotal, "% of price": onPrice, "% of total": onTotal, "rule gives": quoted, matches })));
    console.log(JSON.stringify(feeSummary(observations, rules), null, 2));
  } finally { await store.close(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
