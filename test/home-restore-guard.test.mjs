import test from "node:test";
import assert from "node:assert/strict";
import { isolatedHomeRehearsalTarget } from "../scripts/rehearse-home-postgres.mjs";

test("native Home restore rehearsal rejects production, remote and hidden database/host overrides before connecting", () => {
  const confirmation = { HOME_REHEARSAL_CONFIRM: "isolated-synthetic-home-restore" };
  assert.throws(() => isolatedHomeRehearsalTarget({}));
  for (const url of ["postgres://example.render.com/postgres", "postgres://localhost/ndahi_postgres",
    "postgres://localhost/postgres?database=production", "postgres://localhost/postgres?host=external.render.com",
    "https://localhost/postgres"]) assert.throws(() => isolatedHomeRehearsalTarget({ ...confirmation, HOME_REHEARSAL_DATABASE_URL: url }));
  assert.equal(isolatedHomeRehearsalTarget({ ...confirmation, HOME_REHEARSAL_DATABASE_URL: "postgres://localhost:55479/postgres?host=/tmp/private-postgres" }).pathname, "/postgres");
});
