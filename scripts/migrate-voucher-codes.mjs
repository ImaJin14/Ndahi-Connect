import { blank, createStore } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { migrateVoucherCodes } from "../lib/voucher-migration.mjs";
import { routerAdapter } from "../lib/routeros.mjs";

const store = process.env.DATABASE_URL
  ? createPostgresStore({
    connectionString: process.env.DATABASE_URL,
    initialState: blank,
    ssl: process.env.DATABASE_SSL !== "false",
  })
  : createStore();

try {
  const result = await store.transaction((state) => migrateVoucherCodes(state));
  const state = await store.snapshot(), router = routerAdapter(process.env);
  const failures = [];
  for (const voucher of state.vouchers) {
    try {
      await router.syncVoucher(voucher);
    } catch (error) {
      failures.push({ voucherId: voucher.id, error: error.message });
    }
  }
  if (failures.length) {
    throw new Error(`Voucher database migration committed, but ${failures.length} router sync(s) failed. Re-run after fixing the router connection.`);
  }
  console.log(JSON.stringify({ examined: result.examined, migrated: result.migrated, routerSynchronized: state.vouchers.length }));
} finally {
  await store.close?.();
}
