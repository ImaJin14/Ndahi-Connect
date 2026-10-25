import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import pg from "pg";
import { readFile, readdir } from "node:fs/promises";
import { createHandler, blank } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { hashSecret } from "../lib/security.mjs";
import { MockEmailAdapter } from "../lib/email.mjs";
const url = process.env.TEST_DATABASE_URL,
  now = () => new Date("2030-01-01T12:00:00Z");
test(
  "PostgreSQL profile edits preserve unique phone ownership, rollback all staged fields and confirm once across independent requests",
  { skip: url ? false : "TEST_DATABASE_URL is not set", timeout: 60000 },
  async () => {
    const schema = `ndahi_profile130_${process.pid}`,
      admin = new pg.Client({ connectionString: url });
    await admin.connect();
    let pool, server;
    try {
      await admin.query(`CREATE SCHEMA ${schema}`);
      pool = new pg.Pool({
        connectionString: url,
        options: `-c search_path=${schema}`,
      });
      const dir = new URL("../migrations/", import.meta.url);
      for (const file of (await readdir(dir))
        .filter((x) => /^\d+_.+\.sql$/.test(x))
        .sort())
        await pool.query(await readFile(new URL(file, dir), "utf8"));
      const store = createPostgresStore({ pool, initialState: blank }),
        f = await pairingFixture();
      try {
        await store.transaction(async (s) => {
          Object.assign(s, await f.store.snapshot());
          Object.assign(s.customers[0], {
            name: "Original",
            email: "old@example.test",
            emailVerifiedAt: now().toISOString(),
          });
        });
      } finally {
        await f.close();
      }
      const messages = [],
        email = new MockEmailAdapter();
      email.sendVerification = async (m) => {
        messages.push(m);
        return { messageId: "fixture" };
      };
      const handler = createHandler({
        store,
        email,
        now,
        validateConfig: false,
        env: {
          NODE_ENV: "production",
          CUSTOMER_SESSION_SECRET: "pairing-tests",
          SECRET_PEPPER: "pairing-tests",
          SESSION_COOKIE_SECURE: "false",
          CUSTOMER_APP_URL: "http://customer.test",
          LOG_LEVEL: "warn",
          BILLING_WORKER_ENABLED: "false",
          SECURITY_ALERTS_ENABLED: "false",
          NETWORK_QUEUE_ENABLED: "false",
        },
      });
      server = http.createServer(handler);
      await new Promise((r) => server.listen(0, "127.0.0.1", r));
      const tokens = { main: "main", other: "other" };
      async function call(
        input,
        label = "main",
        path = "/api/account/profile",
      ) {
        const token = tokens[label],
          session = (await store.snapshot()).dashboardSessions.find(
            (a) => a.tokenHash === hashSecret(token, "pairing-tests"),
          );
        const r = await fetch(
          `http://127.0.0.1:${server.address().port}` + path,
          {
            method: "POST",
            headers: {
              origin: "http://customer.test",
              "content-type": "application/json",
              "x-csrf-token": session?.csrfToken || "csrf",
              cookie: "customer_session=" + token,
            },
            body: JSON.stringify(input),
          },
        );
        const body = await r.json();
        if (r.headers.get("set-cookie"))
          tokens[label] = r.headers
            .get("set-cookie")
            .match(/customer_session=([^;]+)/)[1];
        return { status: r.status, body };
      }
      const race = await Promise.all(
        ["main", "other"].map((label) =>
          call({ phone: "+237670050099", pin: "2468" }, label),
        ),
      );
      assert.deepEqual(race.map((r) => r.status).sort(), [200, 409]);
      assert.equal(
        (await store.snapshot()).customers.filter(
          (c) => c.phone === "670050099",
        ).length,
        1,
      );
      const before = await store.snapshot(),
        input = {
          name: "All Fields",
          phone: "670050088",
          email: "new@example.test",
          pin: "2468",
          operationId: "a".repeat(32),
        },
        original = store.transaction.bind(store);
      store.transaction = (fn, options) =>
        original(async (s) => {
          const r = await fn(s);
          if (s.customers[0].pendingEmail)
            throw Error("Synthetic stage rollback");
          return r;
        }, options);
      assert.notEqual((await call(input)).status, 202);
      store.transaction = original;
      assert.equal((await store.snapshot()).customers[0].name, "Original");
      assert.equal(messages.length, 0);
      assert.equal((await call(input)).status, 202);
      await handler.transactionalEmails.run();
      const code = messages[0].code;
      store.transaction = (fn, options) =>
        original(async (s) => {
          const r = await fn(s);
          if (s.customers[0].email === "new@example.test")
            throw Error("Synthetic confirm rollback");
          return r;
        }, options);
      assert.notEqual(
        (await call({ code }, "main", "/api/account/profile/email/confirm"))
          .status,
        200,
      );
      store.transaction = original;
      let c = (await store.snapshot()).customers[0];
      assert.equal(c.email, "old@example.test");
      assert.equal(c.name, "Original");
      assert.equal(c.phone, before.customers[0].phone);
      const confirmations = await Promise.all(
        [1, 2].map(() =>
          call({ code }, "main", "/api/account/profile/email/confirm"),
        ),
      );
      assert.equal(confirmations.filter((r) => r.status === 200).length, 1);
      const reopened = createPostgresStore({ pool, initialState: blank }),
        s = await reopened.snapshot();
      c = s.customers[0];
      assert.equal(c.id, "c1");
      assert.equal(c.name, "All Fields");
      assert.equal(c.phone, "670050088");
      assert.equal(c.email, "new@example.test");
      assert.equal(c.phoneVerified, false);
      assert.equal(c.profileOperations.length, 1);
      assert.equal(c.profileOperations[0].status, "applied");
      for (const key of ["payments", "vouchers", "routerCommands"])
        assert.deepEqual(s[key], before[key]);
      assert.equal(
        s.dashboardSessions.filter((a) => a.customerId === "c1").length,
        1,
      );
      assert.equal((await call(input)).status, 200);
      assert.equal(messages.length, 1);
    } finally {
      if (server)
        await new Promise((r) => {
          server.close(r);
          server.closeAllConnections();
        });
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
