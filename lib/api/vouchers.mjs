import { body, ip, json } from "./http.mjs";
import { redeemVoucher } from "../domain/vouchers.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createVoucherRoutes({ mutate, clock, generic, routerProcessor, customerScope }) {
  return async function (req, res, url) {
    if (req.method === "POST" && url.pathname === "/api/vouchers/redeem") {
      const i = await body(req);
      const result = await mutate(
        (s) => redeemVoucher(s, i, { clock, requester: { ip: ip(req) }, generic }),
        { scope: customerScope(i.phone) },
      );
      const { routerCommandId } = result;
      if (routerCommandId) await routerProcessor.process(routerCommandId).catch(() => {});
      return json(res, result.status, result.body);
    }
    return NOT_HANDLED;
  };
}
