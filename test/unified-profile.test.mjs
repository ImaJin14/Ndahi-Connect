import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createHandler } from "../server.mjs";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import {
  securityKey,
  securityAssertion,
} from "./helpers/customer-security-key.mjs";
import { hashSecret } from "../lib/security.mjs";
import { MockEmailAdapter } from "../lib/email.mjs";
const root = "/api/account/profile",
  secret = "pairing-tests",
  origin = "http://customer.test";
async function fixture(t) {
  const f = await pairingFixture();
  await f.close();
  const messages = [],
    email = new MockEmailAdapter();
  email.sendVerification = async (message) => {
    messages.push(message);
    return { messageId: "fixture" };
  };
  await f.store.transaction((s) => {
    Object.assign(s.customers[0], {
      name: "Original",
      email: "owner@example.test",
      emailVerifiedAt: f.now().toISOString(),
    });
  });
  const handler = createHandler({
    store: f.store,
    email,
    now: f.now,
    validateConfig: false,
    env: {
      NODE_ENV: "production",
      CUSTOMER_SESSION_SECRET: secret,
      SECRET_PEPPER: secret,
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
  let cookie = "main",
    csrf = "csrf";
  async function call(path, input, options = {}) {
    const res = await fetch(
      `http://127.0.0.1:${server.address().port}` + path,
      {
        method: input === undefined ? "GET" : "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-csrf-token": options.csrf || csrf,
          cookie:
            "customer_session=" +
            (options.session === undefined ? cookie : options.session),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      },
    );
    const body = await res.json();
    if (options.session === undefined && res.headers.get("set-cookie")) {
      cookie =
        res.headers.get("set-cookie").match(/customer_session=([^;]+)/)?.[1] ||
        cookie;
      csrf =
        (await f.store.snapshot()).dashboardSessions.find(
          (a) => a.tokenHash === hashSecret(cookie, secret),
        )?.csrfToken || csrf;
    }
    if (body.csrfToken) csrf = body.csrfToken;
    return { status: res.status, body, headers: res.headers };
  }
  async function code() {
    await handler.transactionalEmails.run();
    return messages.at(-1).code;
  }
  return { ...f, handler, call, code, messages };
}
const op = (n) => String(n).padStart(32, "a");

test("name-only partial edits preserve the optional email, canonical account number and financial/device history", async (t) => {
  const f = await fixture(t),
    before = await f.store.snapshot(),
    d = (await f.call("/api/account/dashboard")).body.customer;
  assert.equal(d.phoneE164, "+237670050001");
  assert.equal(d.phoneChangeAvailable, true);
  assert.equal(
    (
      await f.call(root, {
        name: "  New   Name ",
        expectedVersion: d.profileVersion,
        operationId: op(1),
      })
    ).status,
    200,
  );
  const s = await f.store.snapshot();
  assert.equal(s.customers[0].name, "New Name");
  assert.equal(s.customers[0].email, "owner@example.test");
  assert.equal(s.customers[0].phone, "670050001");
  for (const key of ["vouchers", "payments", "routerCommands"])
    assert.deepEqual(s[key], before[key]);
  assert.equal(
    (await f.call("/api/account/dashboard")).body.customer.profileOperations,
    undefined,
  );
});
for (const change of [
  { email: "new@example.test" },
  { name: "Combined", email: "new@example.test" },
])
  test(
    "email change stages the entire submitted profile until mailbox confirmation: " +
      Object.keys(change).join("+"),
    async (t) => {
      const f = await fixture(t),
        before = await f.store.snapshot(),
        input = { ...change, pin: "2468", operationId: op(2) };
      const pending = await f.call(root, input);
      assert.equal(pending.status, 202);
      assert.equal(f.messages.length, 0);
      assert.equal((await f.store.snapshot()).customers[0].name, "Original");
      assert.equal(
        (await f.store.snapshot()).customers[0].email,
        "owner@example.test",
      );
      const code = await f.code();
      assert.equal(
        (
          await f.call(
            root + "/email/confirm",
            { code },
            { session: "secondary" },
          )
        ).status,
        400,
      );
      assert.equal(
        (await f.call(root + "/email/confirm", { code }, { session: "other" }))
          .status,
        400,
      );
      assert.equal(
        (await f.call(root + "/email/confirm", { code })).status,
        200,
      );
      const s = await f.store.snapshot();
      assert.equal(s.customers[0].name, change.name || "Original");
      assert.equal(s.customers[0].email, change.email);
      assert.equal(s.customers[0].id, before.customers[0].id);
      for (const key of ["vouchers", "payments", "routerCommands"])
        assert.deepEqual(s[key], before[key]);
      assert.equal(
        (
          await f.call("/api/account/dashboard", undefined, {
            session: "secondary",
          })
        ).status,
        401,
      );
      assert.equal(
        (await f.call(root + "/email/confirm", { code })).status,
        400,
      );
      assert.equal(
        (await f.call(root, input)).status,
        200,
        "lost success retry cannot queue another code",
      );
      assert.equal(f.messages.length, 1);
    },
  );

for (const change of [
  { phone: "+237 670 050 099" },
  { phone: "670050099", name: "Changed" },
])
  test(
    "account changes identify a number without SIM assertions and retain history: " +
      Object.keys(change).join("+"),
    async (t) => {
      const f = await fixture(t),
        before = await f.store.snapshot();
      assert.equal(
        (await f.call(root, { ...change, pin: "2468" })).status,
        200,
      );
      const s = await f.store.snapshot();
      assert.equal(s.customers[0].phone, "670050099");
      assert.equal(s.customers[0].phoneVerified, false);
      assert.equal(s.customers[0].name, change.name || "Original");
      for (const key of ["vouchers", "payments", "routerCommands"])
        assert.deepEqual(s[key], before[key]);
      assert.equal(
        s.dashboardSessions.filter((a) => a.customerId === "c1").length,
        1,
      );
    },
  );
for (const change of [
  { phone: "670050099", email: "new@example.test" },
  { name: "All Fields", phone: "670050099", email: "new@example.test" },
])
  test(
    "phone-containing email edits commit together after mailbox proof: " +
      Object.keys(change).join("+"),
    async (t) => {
      const f = await fixture(t);
      assert.equal(
        (await f.call(root, { ...change, pin: "2468" })).status,
        202,
      );
      let c = (await f.store.snapshot()).customers[0];
      assert.equal(c.phone, "670050001");
      assert.equal(c.name, "Original");
      assert.equal(c.email, "owner@example.test");
      const code = await f.code();
      assert.equal(
        (await f.call(root + "/email/confirm", { code })).status,
        200,
      );
      c = (await f.store.snapshot()).customers[0];
      assert.equal(c.phone, change.phone);
      assert.equal(c.email, change.email);
      assert.equal(c.name, change.name || "Original");
    },
  );
test("phone collisions and forged client verification cannot transfer another account or race a staged change", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (await f.call(root, { phone: "670050002", pin: "2468" })).status,
    409,
  );
  assert.equal(
    (await f.call(root, { phone: "670050099", verified: true, pin: "2468" }))
      .status,
    400,
  );
  await f.call(root, {
    name: "Pending",
    phone: "670050099",
    email: "new@example.test",
    pin: "2468",
  });
  const code = await f.code();
  await f.store.transaction((s) => {
    s.customers[1].phone = "670050099";
  });
  assert.equal((await f.call(root + "/email/confirm", { code })).status, 409);
  assert.equal((await f.store.snapshot()).customers[0].phone, "670050001");
  assert.equal((await f.store.snapshot()).customers[0].name, "Original");
});

test("equivalent Cameroon phone formats are unchanged and absent email remains optional", async (t) => {
  const f = await fixture(t);
  await f.store.transaction((s) => {
    s.customers[0].email = "";
    delete s.customers[0].emailVerifiedAt;
  });
  for (const phone of ["670 050 001", "+237670050001", "00237670050001"])
    assert.equal(
      (await f.call(root, { name: "Owner", phone, email: "" })).status,
      200,
    );
  assert.equal((await f.store.snapshot()).customers[0].phone, "670050001");
  assert.equal(f.messages.length, 0);
});

test("validation, authentication, CSRF and suspension reject updates before any partial save", async (t) => {
  const f = await fixture(t),
    before = (await f.store.snapshot()).customers;
  for (const input of [
    { name: "" },
    { name: "a".repeat(101) },
    { name: "bad\u0000name" },
    { name: {} },
    { phone: "invalid" },
    { email: "invalid" },
    { email: null },
    { unknown: "x" },
    { email: "", name: "Changed" },
    { name: "Changed", operationId: "bad" },
  ])
    assert.equal((await f.call(root, input)).status, 400);
  assert.equal(
    (await f.call(root, { name: "Changed" }, { csrf: "bad" })).status,
    403,
  );
  assert.equal(
    (await f.call(root, { name: "Changed" }, { session: "" })).status,
    401,
  );
  assert.deepEqual((await f.store.snapshot()).customers, before);
  await f.store.transaction((s) => {
    s.customers[0].suspended = true;
  });
  assert.equal((await f.call(root, { name: "Changed" })).status, 403);
});

test("concurrent profile versions cannot overwrite another browser save, and retries keep one staged request", async (t) => {
  const f = await fixture(t),
    version = (await f.call("/api/account/dashboard")).body.customer
      .profileVersion;
  const rs = await Promise.all(
    ["First", "Second"].map((name, index) =>
      f.call(root, {
        name,
        expectedVersion: version,
        operationId: op(index + 10),
      }),
    ),
  );
  assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
  const input = {
    name: "Pending",
    email: "new@example.test",
    pin: "2468",
    operationId: op(3),
  };
  assert.equal((await f.call(root, input)).status, 202);
  const pending = (await f.store.snapshot()).customers[0].pendingEmail.id;
  assert.equal((await f.call(root, input)).status, 202);
  assert.equal(
    (await f.store.snapshot()).customers[0].pendingEmail.id,
    pending,
  );
  assert.equal((await f.call(root, { ...input, name: "Other" })).status, 409);
  assert.equal((await f.call(root, { action: "cancel" })).status, 200);
  assert.equal((await f.call(root, input)).status, 409);
});

test("incorrect, expired and stale confirmation cannot apply a staged name or trust its email", async (t) => {
  const f = await fixture(t);
  await f.call(root, {
    name: "Pending",
    email: "new@example.test",
    pin: "2468",
  });
  const code = await f.code();
  for (let i = 0; i < 5; i++)
    assert.equal(
      (await f.call(root + "/email/confirm", { code: "invalid" })).status,
      400,
    );
  assert.equal((await f.call(root + "/email/confirm", { code })).status, 400);
  assert.equal((await f.store.snapshot()).customers[0].name, "Original");
  const g = await fixture(t);
  await g.call(root, {
    name: "Pending",
    email: "new@example.test",
    pin: "2468",
  });
  const old = await g.code();
  g.advance(601);
  assert.equal(
    (await g.call(root + "/email/confirm", { code: old })).status,
    400,
  );
  const h = await fixture(t);
  await h.call(root, {
    name: "Pending",
    email: "new@example.test",
    pin: "2468",
  });
  const stale = await h.code();
  await h.store.transaction((s) => {
    s.customers[0].name = "Another session";
  });
  assert.equal(
    (await h.call(root + "/email/confirm", { code: stale })).status,
    409,
  );
  assert.equal(
    (await h.store.snapshot()).customers[0].email,
    "owner@example.test",
  );
});

test("staging and confirmation roll back together with no provider call inside a transaction", async (t) => {
  const f = await fixture(t),
    original = f.store.transaction.bind(f.store);
  f.store.transaction = (fn, options) =>
    original(async (s) => {
      const r = await fn(s);
      if (s.customers[0].pendingEmail) throw Error("Synthetic stage rollback");
      return r;
    }, options);
  const failed = await f.call(root, {
    name: "Pending",
    email: "new@example.test",
    pin: "2468",
  });
  assert.notEqual(failed.status, 202);
  assert.match(failed.body.error, /Synthetic stage rollback/);
  f.store.transaction = original;
  assert.equal(f.messages.length, 0);
  assert.equal((await f.store.snapshot()).customers[0].pendingEmail, undefined);
  await f.call(root, {
    name: "Pending",
    email: "new@example.test",
    pin: "2468",
  });
  const code = await f.code();
  f.store.transaction = (fn, options) =>
    original(async (s) => {
      const r = await fn(s);
      if (s.customers[0].email === "new@example.test")
        throw Error("Synthetic confirm rollback");
      return r;
    }, options);
  const failedConfirm = await f.call(root + "/email/confirm", { code });
  assert.notEqual(failedConfirm.status, 200);
  assert.match(failedConfirm.body.error, /Synthetic confirm rollback/);
  f.store.transaction = original;
  const c = (await f.store.snapshot()).customers[0];
  assert.equal(c.name, "Original");
  assert.equal(c.email, "owner@example.test");
  assert.equal((await f.call(root + "/email/confirm", { code })).status, 200);
});

test("removing a linked email requires explicit acknowledgement and fresh proof, preserves credentials and warns the old mailbox", async (t) => {
  const f = await fixture(t),
    before = await f.store.snapshot();
  assert.equal(
    (await f.call(root, { email: "", removeEmail: true, pin: "0000" })).status,
    401,
  );
  f.advance(2);
  assert.equal(
    (
      await f.call(root, {
        name: "Changed",
        email: "",
        removeEmail: true,
        pin: "2468",
      })
    ).status,
    200,
  );
  const s = await f.store.snapshot();
  assert.equal(s.customers[0].email, "");
  assert.equal(s.customers[0].name, "Changed");
  assert.equal(s.customers[0].pinHash, before.customers[0].pinHash);
  assert.equal(
    s.securityAlerts.find((a) => a.kind === "email_removed").recipient,
    "owner@example.test",
  );
  assert.equal(
    (await f.call("/api/account/dashboard")).body.customer.emailLinked,
    false,
  );
});

test("signed profile passkey proofs bind every field, session and one-use challenge", async (t) => {
  const f = await fixture(t),
    key = securityKey();
  await f.store.transaction((s) => {
    s.customers[0].passkeys = [key.record];
  });
  const input = {
    name: "Proposed",
    email: "new@example.test",
    operationId: op(4),
  };
  const option = (await f.call(root + "/options", input)).body,
    assertion = securityAssertion(key, option.options);
  assert.equal(
    (
      await f.call(root, {
        ...input,
        name: "Tampered",
        challengeId: option.challengeId,
        response: assertion,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call(root, {
        ...input,
        challengeId: option.challengeId,
        response: assertion,
      })
    ).status,
    401,
  );
  const next = (await f.call(root + "/options", input)).body;
  assert.equal(
    (
      await f.call(root, {
        ...input,
        challengeId: next.challengeId,
        response: securityAssertion(key, next.options),
      })
    ).status,
    202,
  );
  assert.equal((await f.store.snapshot()).customers[0].name, "Original");
});

test("rollback to a legacy API cannot turn a combined confirmation into an email-only edit", async (t) => {
  const f = await fixture(t);
  assert.equal(
    (
      await f.call(root, {
        name: "Combined",
        phone: "690050099",
        email: "new@example.test",
        pin: "2468",
      })
    ).status,
    202,
  );
  const code = await f.code(),
    pending = (await f.store.snapshot()).customers[0].pendingEmail;
  // The legacy endpoint checks exactly this keyed hash, so it cannot accept the
  // new purpose even though it preserves the unknown pending-profile metadata.
  assert.notEqual(pending.codeHash, hashSecret(code, secret));
  assert.equal((await f.call(root + "/email/confirm", { code })).status, 200);
  const c = (await f.store.snapshot()).customers[0];
  assert.equal(c.name, "Combined");
  assert.equal(c.phone, "690050099");
  assert.equal(c.email, "new@example.test");
});

test("legacy cached-client profile routes enforce the same canonical suspension state",async t=>{
  const f=await fixture(t);
  await f.store.transaction(s=>{s.customers[0].suspended=true;});
  const before=await f.store.snapshot();
  for(const path of [root,root+"/name",root+"/phone",root+"/phone/options",root+"/email"]){
    assert.equal((await f.call(path,{name:"Changed",phone:"690050099",email:"new@example.test",pin:"2468"})).status,403,path);
  }
  const after=await f.store.snapshot();assert.deepEqual(after.customers,before.customers);assert.equal(f.messages.length,0);
});
