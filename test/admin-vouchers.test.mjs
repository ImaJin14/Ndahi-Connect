import test from "node:test";
import assert from "node:assert/strict";
import { blank } from "../server.mjs";
import { createAdminVouchersRoutes } from "../lib/api/admin-vouchers.mjs";

const at = "2030-01-01T00:00:00Z";

function adminRoutes(adminUser = { id: "staff-1", role: "operator" }) {
  const s = blank(),
    route = createAdminVouchersRoutes({
      deliverVoucherEmail: async () => false,
      clock: () => new Date(at),
    });
  s.customers.push({ id: "c1", phone: "670000001" });
  return {
    s,
    adminUser,
    async call(path, i, role = "operator") {
      const res = {
        writeHead(status) { this.status = status; },
        end(value) { this.body = JSON.parse(value); },
      };
      await route(
        { method: "POST", headers: {}, socket: {}, adminActor: role },
        res,
        new URL(`http://api.test${path}`),
        { s, i, role, adminUser, administrator: { userId: adminUser?.id }, effects: {} },
      );
      return res;
    },
  };
}

test("admin voucher generation rejects customers with an active voucher by default with 409", async () => {
  const f = adminRoutes();
  f.s.vouchers.push({
    id: "v-active",
    customerId: "c1",
    planId: "daily",
    code: "DAILY-1234",
    status: "active",
    activatedAt: at,
    expiresAt: "2030-01-02T00:00:00Z",
    quotaBytes: 1000000000,
    usedBytes: 100000,
    deviceLimit: 1,
  });

  const res = await f.call("/api/admin/vouchers/generate", {
    purpose: "assigned",
    customerId: "c1",
    planId: "weekly",
    saleType: "sold",
  });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "ACTIVE_BUNDLE_EXISTS");
  assert.match(res.body.error, /Replace customer's existing active bundle/);
  assert.equal(res.body.canReplace, true);
  assert.equal(res.body.activeBundle.id, "v-active");
  assert.equal(res.body.activeBundle.planId, "daily");
  assert.equal(res.body.activeBundle.name, "Daily");
  assert.equal(f.s.vouchers.length, 1);
  assert.equal(f.s.routerCommands.length, 0);
});

test("admin voucher generation with replaceActive: true replaces the active voucher and queues commands", async () => {
  const f = adminRoutes();
  const oldVoucher = {
    id: "v-active-2",
    customerId: "c1",
    planId: "daily",
    code: "DAILY-5678",
    status: "active",
    activatedAt: at,
    expiresAt: "2030-01-02T00:00:00Z",
    quotaBytes: 1000000000,
    usedBytes: 500000,
    deviceLimit: 1,
  };
  f.s.vouchers.push(oldVoucher);

  const res = await f.call("/api/admin/vouchers/generate", {
    purpose: "assigned",
    customerId: "c1",
    planId: "weekly",
    saleType: "gift",
    replaceActive: true,
  });

  assert.equal(res.status, 201);
  assert.ok(res.body.voucher);
  assert.equal(res.body.voucher.status, "active");
  assert.equal(res.body.voucher.saleType, "gift");
  assert.equal(res.body.voucher.saleAmount, 0);
  assert.ok(res.body.replacedVoucher);
  assert.equal(res.body.replacedVoucher.id, "v-active-2");
  assert.equal(res.body.replacedVoucher.status, "replaced");

  // Old voucher transitioned
  assert.equal(oldVoucher.status, "replaced");
  assert.equal(oldVoucher.replacedAt, new Date(at).toISOString());
  assert.equal(oldVoucher.replacedByAdminId, "staff-1");
  assert.equal(oldVoucher.replacedByVoucherId, res.body.voucher.id);

  // New voucher links back
  const newVoucher = f.s.vouchers.find((v) => v.id === res.body.voucher.id);
  assert.ok(newVoucher);
  assert.equal(newVoucher.replacesVoucherId, "v-active-2");

  // Router commands queued: disconnect old, sync new
  assert.equal(f.s.routerCommands.length, 2);
  const syncCmd = f.s.routerCommands.find((c) => c.action === "sync_voucher");
  const discCmd = f.s.routerCommands.find((c) => c.action === "disconnect_voucher");
  assert.ok(syncCmd);
  assert.equal(syncCmd.targetId, newVoucher.id);
  assert.ok(discCmd);
  assert.equal(discCmd.targetId, "v-active-2");

  // Audit logs recorded
  const replaceAudit = f.s.auditLogs.find((l) => l.action === "voucher.admin_replaced");
  assert.ok(replaceAudit);
  assert.equal(replaceAudit.meta.replacedVoucherId, "v-active-2");
  assert.equal(replaceAudit.meta.newVoucherId, newVoucher.id);
  assert.equal(replaceAudit.meta.customerId, "c1");
  assert.equal(replaceAudit.meta.saleType, "gift");

  const genAudit = f.s.auditLogs.find((l) => l.action === "voucher.generated");
  assert.ok(genAudit);
  assert.equal(genAudit.meta.replacedVoucherId, "v-active-2");
});

test("admin voucher generation accepts replaceActive: 'true' string from form submit", async () => {
  const f = adminRoutes();
  const oldVoucher = {
    id: "v-active-3",
    customerId: "c1",
    planId: "daily",
    code: "DAILY-9999",
    status: "active",
    activatedAt: at,
    expiresAt: "2030-01-02T00:00:00Z",
    quotaBytes: 1000000000,
    usedBytes: 100000,
    deviceLimit: 1,
  };
  f.s.vouchers.push(oldVoucher);

  const res = await f.call("/api/admin/vouchers/generate", {
    purpose: "assigned",
    customerId: "c1",
    planId: "weekly",
    saleType: "sold",
    replaceActive: "true",
  });

  assert.equal(res.status, 201);
  assert.equal(oldVoucher.status, "replaced");
  assert.equal(res.body.voucher.status, "active");
});
