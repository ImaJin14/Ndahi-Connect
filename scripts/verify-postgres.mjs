import assert from "node:assert/strict";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { blank } from "../server.mjs";

if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const store = createPostgresStore({
  connectionString: process.env.DATABASE_URL,
  initialState: blank,
  ssl: false,
});

try {
  await store.transaction((state) => {
    state.customers.push({ id: "postgres-proof", phone: "670000099", name: "PostgreSQL Proof" });
  });
  assert.equal((await store.snapshot()).customers.some((customer) => customer.id === "postgres-proof"), true);

  await assert.rejects(store.transaction((state) => {
    state.customers.push({ id: "must-roll-back", phone: "670000098", name: "Rollback Proof" });
    throw new Error("intentional rollback");
  }), /intentional rollback/);
  assert.equal((await store.snapshot()).customers.some((customer) => customer.id === "must-roll-back"), false);

  const concurrent = Array.from({ length: 20 }, (_, index) => store.transaction((state) => {
    state.events.push({ id: `postgres-event-${index}` });
  }));
  await Promise.all(concurrent);
  const snapshot = await store.snapshot();
  assert.equal(snapshot.events.filter((event) => event.id.startsWith("postgres-event-")).length, 20);
  console.log(JSON.stringify({ migration: "applied", commit: "passed", rollback: "passed", concurrentTransactions: 20 }));
} finally {
  await store.close();
}
