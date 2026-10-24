import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import pg from "pg";
import { blank, plans } from "../server.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import {
  createTransactionalEmailService,
  queueVoucherEmail,
  emailConfirmationCode,
} from "../lib/transactional-email.mjs";
import { hashSecret } from "../lib/security.mjs";
const url = process.env.TEST_DATABASE_URL;
test(
  "PostgreSQL durable email rows roll back with business changes, lease across processes and reopen after failure without duplicate sends",
  { skip: url ? false : "TEST_DATABASE_URL is not set" },
  async () => {
    const schema = `ndahi_email141_${process.pid}`,
      admin = new pg.Client({ connectionString: url });
    await admin.connect();
    let pool;
    let clock = new Date("2030-01-01T12:00:00Z");
    const now = () => clock;
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
      const store = createPostgresStore({ pool, initialState: blank });
      await store.transaction((s) => {
        s.customers.push({
          id: "c",
          phone: "670000001",
          name: "Owner",
          email: "owner@example.test",
          emailVerificationRequired: true,
          emailVerifiedAt: now().toISOString(),
        });
      });
      const seed = (s) => {
        s.payments.push({
          id: "p",
          customerId: "c",
          planId: "weekly",
          planSnapshot: plans.find((p) => p.id === "weekly"),
          amount: 500,
          currency: "XAF",
          status: "paid",
          confirmedAt: now().toISOString(),
        });
        s.vouchers.push({
          id: "v",
          paymentId: "p",
          customerId: "c",
          code: "NC-AAAA-2222",
          planId: "weekly",
          status: "active",
          activatedAt: now().toISOString(),
          expiresAt: "2030-01-08T12:00:00Z",
          deviceLimit: 1,
        });
        queueVoucherEmail(s, s.vouchers[0]);
      };
      await assert.rejects(
        store.transaction((s) => {
          seed(s);
          throw Error("Synthetic paid/voucher rollback");
        }),
      );
      assert.equal((await store.snapshot()).vouchers.length, 0);
      assert.equal((await store.snapshot()).payments.length, 0);
      await store.transaction(seed);
      const reopened = createPostgresStore({ pool, initialState: blank }),
        deliveries = [];
      let entered, release;
      const started = new Promise((r) => {
          entered = r;
        }),
        held = new Promise((r) => {
          release = r;
        });
      const email = {
        configured: () => true,
        sendVoucher: async (message) => {
          deliveries.push(message);
          entered();
          await held;
          return { messageId: "accepted" };
        },
      };
      const service = (source) =>
        createTransactionalEmailService({
          store: source,
          email,
          now,
          pepper: "fixture-pepper",
          planFor: (s, id) => plans.find((p) => p.id === id),
        });
      const first = service(store).voucher("v");
      await started;
      await service(reopened).voucher("v");
      assert.equal(deliveries.length, 1);
      await reopened.transaction((s) => {
        s.customers[0].name =
          "Independent transaction commits during provider I/O";
      });
      release();
      await first;
      const final = createPostgresStore({ pool, initialState: blank });
      assert.equal((await final.snapshot()).vouchers[0].emailStatus, "sent");
      await service(final).voucher("v");
      assert.equal(deliveries.length, 1);
      // A pending verification contains only a keyed code hash and retry metadata.
      await store.transaction((s) => {
        s.dashboardSessions.push({
          id: "session",
          customerId: "c",
          expiresAt: "2030-01-02T12:00:00Z",
        });
        const p = {
          id: "pending",
          email: "new@example.test",
          originalEmail: "owner@example.test",
          sessionId: "session",
          attempts: 0,
          expiresAt: "2030-01-01T12:10:00Z",
          delivery: { status: "pending", attempts: 0 },
        };
        p.codeHash = hashSecret(
          emailConfirmationCode("c", p, "fixture-pepper"),
          "fixture-pepper",
        );
        s.customers[0].pendingEmail = p;
      });
      let attempts = 0;
      const messages = [];
      email.sendVerification = async (m) => {
        messages.push(m);
        if (++attempts === 1) throw Error("private-provider-secret");
        return { messageId: "accepted-code" };
      };
      await service(final).verification("pending");
      let saved = await reopened.snapshot();
      assert.equal(saved.customers[0].pendingEmail.delivery.status, "failed");
      assert.doesNotMatch(JSON.stringify(saved), /private-provider-secret/);
      clock = new Date(+clock + 121000);
      await service(
        createPostgresStore({ pool, initialState: blank }),
      ).verification("pending");
      assert.deepEqual(messages[0], messages[1]);
      assert.equal(
        (await store.snapshot()).customers[0].pendingEmail.delivery.status,
        "sent",
      );
    } finally {
      await pool?.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
    }
  },
);
