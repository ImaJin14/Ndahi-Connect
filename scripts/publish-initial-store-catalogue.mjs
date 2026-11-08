import { publishInitialStoreCatalogue } from "../lib/initial-store-catalogue.mjs";
if (process.env.NODE_ENV === "production") {
  let store;
  try {
    if (!process.env.DATABASE_URL)
      throw Error("Database configuration required.");
    const { createPostgresStore } = await import("../lib/postgres-store.mjs"),
      { blank } = await import("../lib/api/state.mjs");
    store = createPostgresStore({
      connectionString: process.env.DATABASE_URL,
      initialState: blank,
      ssl: process.env.DATABASE_SSL !== "false",
    });
    console.log(
      JSON.stringify({
        component: "initial-store-catalogue",
        ...(await publishInitialStoreCatalogue({ store })),
      }),
    );
  } catch {
    console.error(
      "Initial store catalogue could not be confirmed; deployment stopped for review.",
    );
    process.exitCode = 1;
  } finally {
    await store?.close?.();
  }
}
