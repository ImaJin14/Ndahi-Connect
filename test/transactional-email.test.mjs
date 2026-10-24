import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHandler, plans } from "../server.mjs";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import {
  createTransactionalEmailService,
  emailConfirmationCode,
  queueVoucherEmail,
} from "../lib/transactional-email.mjs";
import { createBillingService, ensureReceipt } from "../lib/billing.mjs";
import {
  queueSecurityAlert,
  createSecurityAlertService,
} from "../lib/security-alerts.mjs";
import { ResendEmailAdapter } from "../lib/email.mjs";
import { hashSecret } from "../lib/security.mjs";
const origin = "http://customer.test",
  pepper = "pairing-tests";
async function fixture(t) {
  const f = await pairingFixture();
  await f.close();
  const deliveries = [];
  const email = { configured: () => true };
  for (const kind of [
    "Verification",
    "Welcome",
    "Activation",
    "Voucher",
    "Receipt",
    "SecurityAlert",
  ])
    email["send" + kind] = async (message) => {
      deliveries.push({ kind, ...message });
      return { messageId: "fixture-" + deliveries.length };
    };
  const handler = createHandler({
    store: f.store,
    email,
    now: f.now,
    validateConfig: false,
    env: {
      NODE_ENV: "test",
      PAYMENT_MODE: "mock",
      CUSTOMER_SESSION_SECRET: pepper,
      SECRET_PEPPER: pepper,
      SESSION_COOKIE_SECURE: "false",
      CUSTOMER_APP_URL: origin,
      LOG_LEVEL: "warn",
      BILLING_WORKER_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
    },
  });
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise((r) => {
        server.close(r);
        server.closeAllConnections();
      }),
  );
  let session = "main",
    csrf = "csrf";
  async function call(path, input, options = {}) {
    const r = await fetch(`http://127.0.0.1:${server.address().port}` + path, {
      method: input ? "POST" : "GET",
      headers: {
        origin,
        "content-type": "application/json",
        "x-csrf-token": options.csrf || csrf,
        cookie: "customer_session=" + (options.session || session),
      },
      ...(input ? { body: JSON.stringify(input) } : {}),
    });
    const body = await r.json();
    if (!options.session && r.headers.get("set-cookie"))
      session =
        r.headers.get("set-cookie").match(/customer_session=([^;]+)/)?.[1] ||
        session;
    if (body.csrfToken) csrf = body.csrfToken;
    return { status: r.status, body };
  }
  const service = (options) =>
    createTransactionalEmailService({
      store: f.store,
      email,
      now: f.now,
      pepper,
      planFor: (s, id) =>
        s.bundles.find((p) => p.id === id) || plans.find((p) => p.id === id),
      ...options,
    });
  async function seed() {
    await f.store.transaction((s) => {
      const c = s.customers[0];
      Object.assign(c, {
        email: "owner@example.test",
        emailVerificationRequired: true,
        emailVerifiedAt: f.now().toISOString(),
        welcomeEmail: { status: "pending", attempts: 0, name: "Owner" },
      });
      const v = s.vouchers[0];
      v.planId = "weekly";
      v.paymentId = "p1";
      v.activationEmail = { status: "pending", attempts: 0 };
      s.payments.push({
        id: "p1",
        customerId: "c1",
        planId: "weekly",
        planSnapshot: structuredClone(plans.find((p) => p.id === "weekly")),
        amount: 500,
        currency: "XAF",
        status: "paid",
        confirmedAt: f.now().toISOString(),
        email: "payer-contact@example.test",
      });
      ensureReceipt(s.payments[0], s.payments[0].planSnapshot);
      queueVoucherEmail(s, v);
    });
  }
  return { ...f, handler, email, deliveries, call, service, seed };
}
const root = "/api/account/profile/email";

test("verification is committed before I/O, retries without persisting the raw code, and binds mailbox to one account/session", async (t) => {
  const f = await fixture(t);
  let calls = 0;
  const messages = [];
  f.email.sendVerification = async (message) => {
    calls++;
    messages.push(message);
    if (calls === 1) throw Error("credential-like-provider-secret");
    return { messageId: "accepted" };
  };
  const queued = await f.call(root, {
    email: " NEW@example.test ",
    pin: "2468",
  });
  assert.equal(queued.status, 202);
  assert.equal(queued.body.delivery, "pending");
  assert.equal(calls, 0);
  const pending = (await f.store.snapshot()).customers[0].pendingEmail;
  assert.equal(pending.email, "new@example.test");
  assert.equal(pending.code, undefined);
  await f.handler.transactionalEmails.run();
  assert.equal(calls, 1);
  let s = await f.store.snapshot();
  assert.equal(s.customers[0].pendingEmail.status, "unconfirmed");
  assert.equal(s.customers[0].email, undefined);
  assert.doesNotMatch(JSON.stringify(s), /credential-like-provider-secret/);
  assert.equal(
    s.customers[0].pendingEmail.codeHash,
    hashSecret(messages[0].code, pepper),
  );
  assert.equal(
    JSON.stringify((await f.call("/api/account/dashboard")).body).includes(
      messages[0].code,
    ),
    false,
  );
  await f.handler.transactionalEmails.run();
  assert.equal(calls, 1);
  f.advance(121);
  await f.handler.transactionalEmails.run();
  assert.equal(calls, 2);
  assert.deepEqual(messages[0], messages[1]);
  assert.equal(
    (
      await f.call(
        root + "/confirm",
        { code: messages[1].code },
        { session: "other" },
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await f.call(
        root + "/confirm",
        { code: messages[1].code },
        { session: "secondary" },
      )
    ).status,
    400,
  );
  assert.equal(
    (await f.call(root + "/confirm", { code: messages[1].code })).status,
    200,
  );
  const dashboard = await f.call("/api/account/dashboard");
  assert.equal(dashboard.body.customer.emailLinked, true);
  assert.equal(dashboard.body.customer.email, "new@example.test");
  assert.equal(dashboard.body.customer.welcomeEmail, undefined);
  assert.equal(
    (await f.call(root + "/confirm", { code: messages[1].code })).status,
    400,
  );
  assert.equal(
    (
      await f.call("/api/account/dashboard", undefined, {
        session: "secondary",
      })
    ).status,
    401,
  );
  await f.handler.transactionalEmails.run();
  assert.equal(f.deliveries.filter((m) => m.kind === "Welcome").length, 1);
});

test("failed verification commit sends nothing and leaves no pending association", async (t) => {
  const f = await fixture(t),
    original = f.store.transaction.bind(f.store);
  f.store.transaction = (fn, options) =>
    original(async (s) => {
      const r = await fn(s);
      if (s.customers[0].pendingEmail) throw Error("Synthetic rollback");
      return r;
    }, options);
  assert.notEqual(
    (await f.call(root, { email: "new@example.test", pin: "2468" })).status,
    202,
  );
  f.store.transaction = original;
  await f.handler.transactionalEmails.run();
  assert.equal(f.deliveries.length, 0);
  assert.equal((await f.store.snapshot()).customers[0].pendingEmail, undefined);
});

test("two workers lease one voucher outside transactions; replay cannot duplicate any transactional message", async (t) => {
  const f = await fixture(t);
  await f.seed();
  let enter, release;
  const entered = new Promise((r) => {
      enter = r;
    }),
    held = new Promise((r) => {
      release = r;
    });
  let sends = 0;
  f.email.sendVoucher = async (message) => {
    sends++;
    enter();
    await held;
    f.deliveries.push({ kind: "Voucher", ...message });
    return { messageId: "accepted" };
  };
  const first = f.service().voucher("v1");
  await entered;
  const second = await f.service().voucher("v1");
  assert.equal(second.delivered, false);
  await f.store.transaction((s) => {
    s.customers[1].name = "Unrelated request remains writable";
  });
  release();
  await first;
  await f.handler.transactionalEmails.run();
  await f.handler.billing.run();
  await f.handler.transactionalEmails.run();
  await f.handler.billing.run();
  assert.equal(sends, 1);
  for (const kind of ["Welcome", "Activation", "Voucher", "Receipt"])
    assert.equal(f.deliveries.filter((m) => m.kind === kind).length, 1, kind);
  assert.ok(
    f.deliveries.every(
      (m) => (m.to || m.customer?.email) === "owner@example.test",
    ),
  );
  const dashboard = (await f.call("/api/account/dashboard")).body;
  assert.equal(dashboard.activeBundle.emailDelivery, undefined);
  assert.equal(dashboard.activeBundle.activationEmail, undefined);
  assert.equal(JSON.stringify(dashboard).includes("token"), false);
});

test("unverified checkout address and transactional opt-out never receive sensitive documents; explicit verification remains available", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.store.transaction((s) => {
    delete s.customers[0].emailVerifiedAt;
  });
  await f.handler.transactionalEmails.run();
  await f.handler.billing.sendReceipt("p1");
  assert.equal(f.deliveries.length, 0);
  assert.equal(
    (await f.store.snapshot()).payments[0].receiptEmail.status,
    "needs_email",
  );
  await f.store.transaction((s) => {
    s.customers[0].emailVerifiedAt = f.now().toISOString();
    s.notificationStates.push({
      id: "preferences:customer:c1",
      actor: "customer:c1",
      emailTransactions: false,
      emailSecurity: false,
    });
  });
  await f.handler.transactionalEmails.run();
  await f.handler.billing.sendReceipt("p1");
  assert.equal(f.deliveries.length, 0);
  await f.call(root, { email: "change@example.test", pin: "2468" });
  await f.handler.transactionalEmails.run();
  assert.equal(f.deliveries.length, 1);
  assert.equal(f.deliveries[0].kind, "Verification");
  await f.store.transaction((s) => {
    s.notificationStates[0].emailTransactions = true;
  });
  await f.handler.transactionalEmails.run();
  await f.handler.billing.sendReceipt("p1");
  assert.equal(f.deliveries.filter((m) => m.kind === "Receipt").length, 1);
});

test("fresh consent or recipient changes cancel a claimed voucher before provider I/O", async (t) => {
  for (const change of [
    (s) => {
      s.notificationStates.push({
        id: "preferences:customer:c1",
        emailTransactions: false,
      });
    },
    (s) => {
      s.customers[0].email = "replacement@example.test";
    },
  ]) {
    const f = await fixture(t);
    await f.seed();
    const original = f.store.transaction.bind(f.store);
    let count = 0;
    const store = {
      snapshot: () => f.store.snapshot(),
      transaction: (fn, options) =>
        original(async (s) => {
          if (++count === 2) change(s);
          return fn(s);
        }, options),
    };
    await f.service({ store }).voucher("v1");
    assert.equal(f.deliveries.length, 0);
  }
});

test("timeouts recover using a stable key; backoff, attempt cap and provider idempotency window bound retries", async (t) => {
  const f = await fixture(t);
  await f.seed();
  let calls = 0;
  const keys = [];
  f.email.sendVoucher = async (m) => {
    calls++;
    keys.push(m.deliveryKey);
    if (calls === 1) return new Promise(() => {});
    throw Error("secret");
  };
  const worker = f.service({ timeoutMs: 5 });
  await worker.voucher("v1");
  assert.equal(calls, 1);
  await worker.voucher("v1");
  assert.equal(calls, 1);
  for (let i = 0; i < 7; i++) {
    f.advance(1801);
    await worker.voucher("v1");
  }
  assert.equal(calls, 5);
  assert.equal(new Set(keys).size, 1);
  assert.equal((await f.store.snapshot()).vouchers[0].emailAttempts, 5);
  const g = await fixture(t);
  await g.seed();
  g.email.sendVoucher = async () => {
    throw Error("private");
  };
  await g.service().voucher("v1");
  g.advance(24 * 3600);
  await g.service().voucher("v1");
  assert.equal((await g.store.snapshot()).vouchers[0].emailAttempts, 1);
});

test("a stale sending lease recovers after restart and changed recipient after an uncertain attempt requires review", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.store.transaction((s) => {
    s.vouchers[0].emailDelivery = {
      status: "sending",
      attempts: 1,
      token: "crashed",
      leaseUntil: new Date(+f.now() - 1).toISOString(),
    };
  });
  await f.service().voucher("v1");
  assert.equal(f.deliveries.length, 1);
  const g = await fixture(t);
  await g.seed();
  g.email.sendVoucher = async () => {
    throw Error("unknown");
  };
  await g.service().voucher("v1");
  g.advance(121);
  await g.store.transaction((s) => {
    s.customers[0].email = "new-owner@example.test";
  });
  await g.service().voucher("v1");
  assert.equal((await g.store.snapshot()).vouchers[0].emailStatus, "cancelled");
});

test("mailbox code retry supports pepper rotation and stops after expiry or session revocation", async (t) => {
  const f = await fixture(t);
  await f.call(root, { email: "new@example.test", pin: "2468" });
  const pending = (await f.store.snapshot()).customers[0].pendingEmail;
  assert.equal(emailConfirmationCode("c1", pending, pepper).length, 6);
  await f
    .service({ pepper: "rotated-pepper", previousPepper: pepper })
    .verification(pending.id);
  assert.equal(
    f.deliveries[0].code,
    emailConfirmationCode("c1", pending, pepper),
  );
  f.advance(601);
  await f.service().verification(pending.id);
  assert.equal(f.deliveries.length, 1);
  const g = await fixture(t);
  await g.call(root, { email: "new@example.test", pin: "2468" });
  await g.store.transaction((s) => {
    s.dashboardSessions = [];
  });
  await g.handler.transactionalEmails.run();
  assert.equal(g.deliveries.length, 0);
});

test("security delivery leases preserve the old verified replacement warning but cancel stale ordinary recipients", async (t) => {
  const f = await fixture(t);
  await f.seed();
  await f.store.transaction((s) => {
    queueSecurityAlert(
      s,
      {
        customerId: "c1",
        kind: "email_replaced",
        recipient: "old@example.test",
        subject: "Email changed",
        lines: ["Review your account."],
      },
      f.now(),
    );
    queueSecurityAlert(
      s,
      {
        customerId: "c1",
        kind: "pin_changed",
        recipient: "old@example.test",
        subject: "PIN changed",
        lines: ["Review your account."],
      },
      f.now(),
    );
  });
  await Promise.all(
    [1, 2].map(() =>
      createSecurityAlertService({
        store: f.store,
        email: f.email,
        now: f.now,
      }).run(),
    ),
  );
  const sent = f.deliveries.filter((m) => m.kind === "SecurityAlert");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "old@example.test");
});

test("all email templates are branded, escaped, scoped to portal authentication and stable across retries; PDFs contain no bearer URLs", async () => {
  const requests = [],
    adapter = new ResendEmailAdapter({
      apiKey: "synthetic",
      from: "NDAHI <test@example.test>",
      portalUrl: "https://portal.example.test",
      fetcher: async (url, options) => {
        requests.push({
          headers: options.headers,
          body: JSON.parse(options.body),
        });
        return Response.json({ id: "fixture" });
      },
    });
  const voucher = {
      id: "v",
      code: "NC-ABCD-2345",
      status: "active",
      planId: "weekly",
      deviceLimit: 1,
      activatedAt: "2030-01-01T12:00:00Z",
      expiresAt: "2030-01-08T12:00:00Z",
    },
    plan = { name: "Weekly <private>", quotaGb: 5 },
    customer = {
      name: "<script>bad</script>",
      email: "verified@example.test",
      phone: "670050001",
    };
  const receipt = ensureReceipt(
    {
      id: "p",
      status: "paid",
      amount: 500,
      currency: "XAF",
      customerId: "c",
      confirmedAt: "2030-01-01T12:00:00Z",
    },
    plan,
  );
  const sends = [
    () =>
      adapter.sendWelcome({
        to: customer.email,
        name: customer.name,
        customerId: "c",
      }),
    () =>
      adapter.sendVerification({
        to: customer.email,
        code: "012345",
        requestId: "request",
      }),
    () =>
      adapter.sendVoucher({
        customer,
        payment: { amount: 500, currency: "XAF" },
        plan,
        voucher,
      }),
    () => adapter.sendReceipt({ to: customer.email, receipt }),
    () =>
      adapter.sendActivation({
        to: customer.email,
        voucherId: "v",
        planName: plan.name,
        expiresAt: voucher.expiresAt,
      }),
    () =>
      adapter.sendSecurityAlert({
        to: customer.email,
        alert: {
          id: "a",
          subject: "Security notice",
          lines: ["Review <script>bad</script>"],
        },
      }),
  ];
  for (const send of sends) {
    await send();
    await send();
    const [a, b] = requests.slice(-2);
    assert.deepEqual(a, b);
    assert.match(a.body.html, /NDAHI CONNECT|NDAHI/);
    assert.doesNotMatch(a.body.html, /<script>/);
    assert.deepEqual(a.body.to, [customer.email]);
    assert.doesNotMatch(a.body.subject, /NC-ABCD/);
    assert.doesNotMatch(a.body.html, /token=|code=|customerId=/);
    if (a.body.attachments)
      assert.equal(
        Buffer.from(a.body.attachments[0].content, "base64")
          .subarray(0, 5)
          .toString(),
        "%PDF-",
      );
  }
});
