import test from "node:test";
import assert from "node:assert/strict";
import { pairingFixture } from "./helpers/wifi-pairing-fixture.mjs";
import { printSelection } from "../lib/api/voucher-print.mjs";
import { openVoucherPrintPreview } from "../shared-app/voucher-print-preview.js";
import { createAdminVouchersRoutes } from "../lib/api/admin-vouchers.mjs";
import { blank } from "../server.mjs";

test("preview opens synchronously and only offers thermal widths without exposing voucher codes", () => {
  let opened;
  const result = openVoucherPrintPreview({
    voucherIds: ["v1"],
    widthMm: 80,
    target: {
      open: (...args) => {
        opened = args;
        return null;
      },
    },
  });
  assert.equal(opened[0], result.url);
  assert.equal(opened[2], "noopener");
  const fragment = new URLSearchParams(result.url.split("#")[1]);
  assert.equal(fragment.get("width"), "80");
  assert.deepEqual(JSON.parse(fragment.get("ids")), ["v1"]);
  assert.equal(printSelection({ voucherIds: ["v1"], widthMm: 210 }), null);
  assert.equal(printSelection({ voucherIds: ["v1", "v1"], widthMm: 58 }), null);
});

test("customer preview and bulk PDF enforce ownership CSRF and privacy without activating old access", async (t) => {
  const f = await pairingFixture();
  t.after(f.close);
  await f.store.transaction((s) =>
    s.vouchers.push({ ...s.vouchers[0], id: "old", status: "expired" }),
  );
  const input = { voucherIds: ["v1", "old"], widthMm: 80 };
  const preview = await f.call("/api/account/vouchers/print-preview", input);
  assert.equal(preview.status, 200);
  assert.equal(preview.body.count, 2);
  assert.match(preview.body.html, /WI-FI VOUCHER SLIP/);
  assert.doesNotMatch(preview.body.html, /style=|670050001|Imajin/);
  assert.equal(
    (
      await f.call("/api/account/vouchers/print-preview", input, {
        session: "other",
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await f.call("/api/account/vouchers/print-preview", input, {
        session: "",
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.call("/api/account/vouchers/print-preview", input, {
        csrf: "wrong",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await f.call("/api/account/vouchers/print-preview", {
        ...input,
        widthMm: 210,
      })
    ).status,
    400,
  );
  const response = await fetch(f.api + "/api/account/vouchers/print-pdf", {
    method: "POST",
    headers: {
      origin: "http://customer.test",
      cookie: "customer_session=main",
      "content-type": "application/json",
      "x-csrf-token": "csrf",
    },
    body: JSON.stringify(input),
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const pdf = Buffer.from(await response.arrayBuffer()).toString("latin1");
  assert.equal((pdf.match(/\/Type\s*\/Page\b/g) || []).length, 2);
  assert.equal(
    (await f.store.snapshot()).vouchers.find((v) => v.id === "old").status,
    "expired",
  );
});

test("reseller print preview cannot read another seller's voucher and auditors cannot print codes", async () => {
  const s = blank();
  s.vouchers.push(
    {
      id: "own",
      code: "NC-AAAA-1111",
      planId: "weekly",
      status: "available",
      assignedResellerId: "seller",
    },
    {
      id: "foreign",
      code: "NC-BBBB-2222",
      status: "available",
      assignedResellerId: "other",
    },
  );
  const route = createAdminVouchersRoutes({
    clock: () => new Date("2030-01-01"),
    customerOrigin: "https://portal.ndahiconnect.net",
  });
  const call = async (role, ids) => {
    let status, value;
    const res = {
      writeHead(code) {
        status = code;
      },
      end(data) {
        value = JSON.parse(data);
      },
    };
    await route(
      { method: "POST", headers: {}, socket: {} },
      res,
      new URL("https://api.test/api/admin/vouchers/print-preview"),
      {
        s,
        i: { voucherIds: ids, widthMm: 58 },
        role,
        adminUser: { id: "seller" },
        administrator: {},
      },
    );
    return { status, value };
  };
  assert.equal((await call("reseller", ["own"])).status, 200);
  assert.equal((await call("reseller", ["foreign"])).status, 404);
  assert.equal((await call("auditor", ["own"])).status, 403);
});
