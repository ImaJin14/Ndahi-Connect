import test from "node:test";
import assert from "node:assert/strict";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";

// Profile and security (AdminProfile, #389): each administrator sets the name
// staff see (no fresh verification; audited), and the profile lists when each
// passkey was last used.
const secret = "admin-profile-name";
async function fixture(t) {
  const store = createStore({ persistent: false });
  await store.transaction((s) => {
    s.adminUsers.push({ id: "u-owner", username: "owner", displayName: "Owner", role: "owner", active: true,
      passkeys: [{ id: "k1", publicKey: "pk", counter: 0, label: "Office laptop", createdAt: "2026-08-19T09:00:00.000Z", lastUsedAt: "2026-11-26T08:00:00.000Z" },
        { id: "k2", publicKey: "pk2", counter: 0, createdAt: "2026-08-20T09:00:00.000Z" }] },
    { id: "u-op", username: "operator", displayName: "Oscar", role: "operator", active: true, passkeys: [] },
    { id: "u-audit", username: "auditor", displayName: "Ada", role: "auditor", active: true, passkeys: [] });
    for (const [user, role] of [["u-owner", "owner"], ["u-op", "operator"], ["u-audit", "auditor"]])
      s.adminSessions.push({ userId: user, role, tokenHash: hashSecret(role, secret), csrfToken: "csrf-" + role, expiresAt: "2099-01-01T00:00:00.000Z" });
  });
  const server = createServer({ store, validateConfig: false, env: { NODE_ENV: "test", ADMIN_SESSION_SECRET: secret, SECRET_PEPPER: secret, PAYMENT_MODE: "mock",
    NETWORK_QUEUE_ENABLED: "false", BILLING_WORKER_ENABLED: "false", BOOTSTRAP_MODE: "false", LOG_LEVEL: "silent" } });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.closeAllConnections(); server.close(r); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (path, role, input) => {
    const r = await fetch(base + path, { method: input ? "POST" : "GET", headers: { cookie: `admin_session=${role}`, "x-csrf-token": `csrf-${role}`, ...(input ? { "content-type": "application/json" } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}) });
    return { status: r.status, body: await r.json() };
  };
  return { store, call };
}

test("an administrator sets their own name without fresh verification, and it is audited", async (t) => {
  const f = await fixture(t);
  const saved = await f.call("/api/admin/profile/name", "operator", { displayName: "  Oscar N.  " });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body, { updated: true, displayName: "Oscar N." });
  const s = await f.store.snapshot();
  assert.equal(s.adminUsers.find((u) => u.id === "u-op").displayName, "Oscar N.");
  assert.equal(s.adminUsers.find((u) => u.id === "u-owner").displayName, "Owner", "only their own");
  assert.ok(s.auditLogs.some((entry) => entry.action === "admin.name_changed" && entry.meta?.userId === "u-op"));
  assert.equal((await f.call("/api/admin/profile/name", "operator", { displayName: "   " })).status, 400);
  assert.equal((await f.call("/api/admin/profile/name", "operator", { displayName: "x".repeat(81) })).status, 400);
  assert.equal((await f.call("/api/admin/profile/name", "operator", { displayName: 42 })).status, 400);
  // Like their own email and PIN, any role sets its own name.
  assert.equal((await f.call("/api/admin/profile/name", "auditor", { displayName: "Ada L." })).status, 200);
});

test("the profile lists each passkey with when it was last used", async (t) => {
  const f = await fixture(t);
  const dashboard = await f.call("/api/admin/dashboard", "owner");
  assert.equal(dashboard.status, 200);
  assert.deepEqual(dashboard.body.profile.passkeyList, [
    { id: "k1", label: "Office laptop", createdAt: "2026-08-19T09:00:00.000Z", lastUsedAt: "2026-11-26T08:00:00.000Z" },
    { id: "k2", createdAt: "2026-08-20T09:00:00.000Z" },
  ]);
});
