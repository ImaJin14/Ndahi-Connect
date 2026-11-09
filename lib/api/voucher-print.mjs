import { body, json } from "./http.mjs";
import { purchasedPlan } from "./state.mjs";
import { prepareVoucherSlip, voucherBatchPdf } from "../voucher-pdf.mjs";
import { renderVoucherSlip } from "../../admin-app/voucher-slip.js";
import { NOT_HANDLED } from "./routing.mjs";

export function printSelection(input) {
  if (
    !Array.isArray(input.voucherIds) ||
    input.voucherIds.length < 1 ||
    input.voucherIds.length > 100 ||
    input.voucherIds.some(
      (id) => typeof id !== "string" || !id || id.length > 100,
    ) ||
    new Set(input.voucherIds).size !== input.voucherIds.length
  )
    return null;
  if (![58, 80].includes(input.widthMm)) return null;
  return input.voucherIds;
}
export async function sendVoucherPrint(
  res,
  input,
  entries,
  portalUrl,
  pdf = false,
) {
  const prepared = await Promise.all(
    entries.map(async (entry) => ({
      ...entry,
      slip: await prepareVoucherSlip({ ...entry, portalUrl }),
    })),
  );
  if (pdf) {
    const data = await voucherBatchPdf({
      entries: prepared,
      widthMm: input.widthMm,
      portalUrl,
    });
    res.writeHead(200, {
      "content-type": "application/pdf",
      "cache-control": "no-store",
      "content-disposition": 'attachment; filename="ndahi-voucher-slips.pdf"',
      "content-length": data.length,
    });
    return res.end(data);
  }
  // Page uses a same-origin stylesheet under CSP; email-only inline styles are stripped.
  const html = prepared
    .map(({ slip }, index) =>
      renderVoucherSlip(slip, { widthMm: input.widthMm, index }),
    )
    .join("")
    .replace(/ style="[^"]*"/g, "");
  return json(res, 200, {
    html,
    count: entries.length,
    widthMm: input.widthMm,
  });
}
export function createVoucherPrintRoutes({ mutate, auth, customerOrigin }) {
  return async (req, res, url) => {
    if (
      req.method !== "POST" ||
      ![
        "/api/account/vouchers/print-preview",
        "/api/account/vouchers/print-pdf",
      ].includes(url.pathname)
    )
      return NOT_HANDLED;
    const input = await body(req),
      ids = printSelection(input);
    if (!ids)
      return json(res, 400, {
        error: "Choose 1–100 vouchers and a 58mm or 80mm print width.",
      });
    const entries = await mutate(
      (s) => {
        const session = auth(req, s, "dashboardSessions"),
          customer =
            session && s.customers.find((c) => c.id === session.customerId);
        if (
          !customer ||
          customer.status === "suspended" ||
          customer.suspended
        ) {
          json(res, 401, { error: "Sign in again to print your vouchers." });
          return null;
        }
        const vouchers = ids.map((id) =>
          s.vouchers.find(
            (v) => v.id === id && v.customerId === customer.id && v.code,
          ),
        );
        if (vouchers.some((v) => !v)) {
          json(res, 404, { error: "Voucher not found." });
          return null;
        }
        return structuredClone(
          vouchers.map((voucher) => ({
            voucher,
            plan: purchasedPlan(s, voucher),
          })),
        );
      },
      { res },
    );
    if (!entries) return;
    return sendVoucherPrint(
      res,
      input,
      entries,
      customerOrigin,
      url.pathname.endsWith("print-pdf"),
    );
  };
}
