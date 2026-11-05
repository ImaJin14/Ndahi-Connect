import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, createStore } from "../server.mjs";
import { hashSecret } from "../lib/security.mjs";
import {
  normalizeCommissionPercent,
  computeResellerRow,
  resellerLedgerSummary,
} from "../lib/reseller-ledger.mjs";
import { renderResellerLedgerMarkup } from "../admin-app/reseller-ledger.js";

const at = "2030-01-01T12:00:00.000Z";
const origin = "http://admin.test";

test("reseller ledger domain computes inventory, commission splits, and outstanding balance accurately", () => {
  assert.equal(normalizeCommissionPercent(12.5), 12.5);
  assert.equal(normalizeCommissionPercent("15"), 15);
  assert.equal(normalizeCommissionPercent("", 10), 10);
  assert.equal(normalizeCommissionPercent(-1, null), null);
  assert.equal(normalizeCommissionPercent(120, null), null);

  const state = {
    bundles: [],
    adminUsers: [
      {
        id: "reseller-1",
        username: "kiosk-north",
        displayName: "Kiosk North",
        role: "reseller",
        active: true,
        commissionPercent: 10,
        remittances: [
          {
            id: "remit-1",
            amount: 1000,
            note: "Morning drop",
            recordedBy: "owner",
            createdAt: "2030-01-01T10:00:00.000Z",
          },
        ],
      },
      {
        id: "reseller-2",
        username: "kiosk-south",
        displayName: "Kiosk South",
        role: "reseller",
        active: true,
        commissionPercent: 20,
        remittances: [],
      },
    ],
    vouchers: [
      {
        id: "v1",
        planId: "daily",
        status: "available",
        activatedAt: null,
        saleType: "sold",
        faceValue: 500,
        saleAmount: 500,
        assignedResellerId: "reseller-1",
      },
      {
        id: "v2",
        planId: "weekly",
        status: "active",
        activatedAt: at,
        saleType: "sold",
        faceValue: 2000,
        saleAmount: 2000,
        assignedResellerId: "reseller-1",
      },
      {
        id: "v3",
        planId: "daily",
        status: "exhausted",
        activatedAt: at,
        saleType: "sold",
        faceValue: 500,
        saleAmount: 500,
        generatedByAdminId: "reseller-1",
      },
      {
        id: "v4",
        planId: "daily",
        status: "revoked",
        activatedAt: at,
        saleType: "sold",
        faceValue: 500,
        saleAmount: 500,
        assignedResellerId: "reseller-1",
      },
      {
        id: "v5",
        planId: "monthly",
        status: "active",
        activatedAt: at,
        saleType: "sold",
        faceValue: 5000,
        saleAmount: 5000,
        assignedResellerId: "reseller-2",
      },
    ],
  };

  const row1 = computeResellerRow(state, state.adminUsers[0]);
  assert.equal(row1.assignedVouchers, 4);
  assert.equal(row1.unsoldVouchers, 1);
  assert.equal(row1.unsoldFaceValue, 500);
  assert.equal(row1.redeemedVouchers, 2);
  assert.equal(row1.revokedVouchers, 1);
  assert.equal(row1.cashCollected, 2500);
  assert.equal(row1.commissionEarned, 250);
  assert.equal(row1.netPayableToOwner, 2250);
  assert.equal(row1.remittedTotal, 1000);
  assert.equal(row1.outstandingBalance, 1250);

  const ownerView = resellerLedgerSummary(state, { role: "owner", staffId: "owner-1" });
  assert.equal(ownerView.scope, "all");
  assert.equal(ownerView.resellers.length, 2);
  assert.equal(ownerView.totals.cashCollected, 7500);
  assert.equal(ownerView.totals.commissionEarned, 1250);
  assert.equal(ownerView.totals.netPayableToOwner, 6250);
  assert.equal(ownerView.totals.remittedTotal, 1000);
  assert.equal(ownerView.totals.outstandingBalance, 5250);

  const selfView = resellerLedgerSummary(state, { role: "reseller", staffId: "reseller-1" });
  assert.equal(selfView.scope, "self");
  assert.equal(selfView.resellers.length, 1);
  assert.equal(selfView.resellers[0].resellerId, "reseller-1");
  assert.equal(selfView.totals.outstandingBalance, 1250);

  const ownerHtml = renderResellerLedgerMarkup(ownerView, { role: "owner" });
  assert.match(ownerHtml, /Record cash remittance handoff/);
  assert.match(ownerHtml, /Configure reseller commission split/);
  assert.match(ownerHtml, /Kiosk North/);
  assert.match(ownerHtml, /Kiosk South/);

  const resellerHtml = renderResellerLedgerMarkup(selfView, { role: "reseller" });
  assert.match(resellerHtml, /My inventory, sales & cash remittance/);
  assert.doesNotMatch(resellerHtml, /Record cash remittance handoff/);
  assert.doesNotMatch(resellerHtml, /Kiosk South/);
});

test("owner and reseller API routes enforce RBAC, track inventory assignment, commissions, and audited cash handoffs", async (t) => {
  const store = createStore({ persistent: false });
  const secret = randomUUID();
  const roles = ["owner", "operator", "reseller", "reseller2"];
  const tokens = Object.fromEntries(roles.map((r) => [r, randomUUID()]));

  await store.transaction((s) => {
    s.adminUsers.push(
      { id: "staff-owner", username: "owner", displayName: "Main Owner", active: true, role: "owner", passkeys: [] },
      { id: "staff-operator", username: "operator", displayName: "Ops Staff", active: true, role: "operator", passkeys: [] },
      { id: "staff-reseller-1", username: "mama-grace", displayName: "Mama Grace Kiosk", active: true, role: "reseller", commissionPercent: 10, passkeys: [] },
      { id: "staff-reseller-2", username: "junction-pos", displayName: "Junction POS", active: true, role: "reseller", commissionPercent: 15, passkeys: [] },
    );
    s.adminSessions.push(
      { userId: "staff-owner", tokenHash: hashSecret(tokens.owner, secret), role: "owner", csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" },
      { userId: "staff-operator", tokenHash: hashSecret(tokens.operator, secret), role: "operator", csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" },
      { userId: "staff-reseller-1", tokenHash: hashSecret(tokens.reseller, secret), role: "reseller", csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" },
      { userId: "staff-reseller-2", tokenHash: hashSecret(tokens.reseller2, secret), role: "reseller", csrfToken: "csrf", expiresAt: "2030-01-02T00:00:00Z" },
    );
  });

  const server = createServer({
    store,
    now: () => new Date(at),
    validateConfig: false,
    env: {
      NODE_ENV: "test",
      PAYMENT_MODE: "mock",
      EMAIL_MODE: "mock",
      MIKROTIK_MODE: "mock",
      BILLING_WORKER_ENABLED: "false",
      SECURITY_ALERTS_ENABLED: "false",
      NETWORK_QUEUE_ENABLED: "false",
      PAYMENT_WEBHOOK_WORKER_ENABLED: "false",
      SESSION_COOKIE_SECURE: "false",
      ADMIN_SESSION_SECRET: secret,
      ADMIN_APP_URL: origin,
      ALLOWED_ADMIN_ORIGINS: origin,
    },
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => { server.close(r); server.closeAllConnections(); }));

  const call = async (actor, path, body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method: body ? "POST" : "GET",
      headers: {
        cookie: `admin_session=${tokens[actor]}`,
        origin,
        "content-type": "application/json",
        "x-csrf-token": "csrf",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };

  // 1. Owner generates 4 weekly resale vouchers (2,000 FCFA each) assigned to Mama Grace Kiosk
  const gen = await call("owner", "/api/admin/vouchers/generate", {
    purpose: "resale",
    planId: "weekly",
    quantity: 4,
    saleType: "sold",
    assignedResellerId: "staff-reseller-1",
  });
  assert.equal(gen.status, 201);
  assert.equal(gen.body.vouchers.length, 4);

  // Simulate 3 of the 4 vouchers being redeemed by customers
  await store.transaction((s) => {
    for (const v of s.vouchers.slice(0, 3)) {
      v.status = "active";
      v.activatedAt = at;
    }
  });

  // 2. Owner updates Mama Grace's commission to 15%
  const comm = await call("owner", "/api/admin/resellers/commission", {
    resellerId: "staff-reseller-1",
    commissionPercent: 15,
  });
  assert.equal(comm.status, 200);
  assert.equal(comm.body.reseller.commissionPercent, 15);
  // 3 redeemed * 1,000 = 3,000 FCFA gross; 15% commission = 450 FCFA; net owed = 2,550 FCFA
  assert.equal(comm.body.reseller.cashCollected, 3000);
  assert.equal(comm.body.reseller.commissionEarned, 450);
  assert.equal(comm.body.reseller.netPayableToOwner, 2550);
  assert.equal(comm.body.reseller.outstandingBalance, 2550);

  // 3. Operator and Reseller cannot mutate commission or record remittances
  for (const actor of ["operator", "reseller"]) {
    assert.equal(
      (await call(actor, "/api/admin/resellers/commission", { resellerId: "staff-reseller-1", commissionPercent: 25 })).status,
      403,
    );
    assert.equal(
      (await call(actor, "/api/admin/resellers/remittances", { resellerId: "staff-reseller-1", amount: 1000 })).status,
      403,
    );
  }

  // 4. Owner records a 1,500 FCFA cash remittance from Mama Grace
  const remit = await call("owner", "/api/admin/resellers/remittances", {
    resellerId: "staff-reseller-1",
    amount: 1500,
    note: "Cash handoff at Buea market",
  });
  assert.equal(remit.status, 201);
  assert.equal(remit.body.remittance.amount, 1500);
  assert.equal(remit.body.reseller.remittedTotal, 1500);
  assert.equal(remit.body.reseller.outstandingBalance, 1050);

  // 5. Reseller 1 sees ONLY their own stock, sales, earnings, and remittance history
  const resellerView = await call("reseller", "/api/admin/resellers/ledger");
  assert.equal(resellerView.status, 200);
  assert.equal(resellerView.body.scope, "self");
  assert.equal(resellerView.body.resellers.length, 1);
  assert.equal(resellerView.body.resellers[0].resellerId, "staff-reseller-1");
  assert.equal(resellerView.body.resellers[0].unsoldVouchers, 1);
  assert.equal(resellerView.body.resellers[0].redeemedVouchers, 3);
  assert.equal(resellerView.body.resellers[0].outstandingBalance, 1050);
  assert.equal(resellerView.body.remittances.length, 1);

  // Reseller 2 sees only their own empty ledger and never sees Mama Grace's remittances
  const reseller2View = await call("reseller2", "/api/admin/resellers/ledger");
  assert.equal(reseller2View.status, 200);
  assert.equal(reseller2View.body.resellers.length, 1);
  assert.equal(reseller2View.body.resellers[0].resellerId, "staff-reseller-2");
  assert.equal(reseller2View.body.remittances.length, 0);

  // 6. Verify audited records of commission change and cash handoff
  const snap = await store.snapshot();
  assert.ok(snap.auditLogs.some((a) => a.action === "reseller.commission_updated" && a.meta?.resellerId === "staff-reseller-1"));
  assert.ok(
    snap.auditLogs.some(
      (a) =>
        a.action === "reseller.remittance_recorded" &&
        a.meta?.resellerId === "staff-reseller-1" &&
        a.meta?.amount === 1500,
    ),
  );
});
