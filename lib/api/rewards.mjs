// The customer's Rewards (#526; canvas PhoneRewards, #528): the balance, the
// bundles to redeem, the saved bundles and the history. The server decides
// every figure; the browser never sends a points amount.
import { json, body } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { log, uniqueActivationCode, view } from "./state.mjs";
import { accountRewardsView, expirePoints, redeemPoints, startRedeemedBundle, RewardsError, bundleSummary } from "../rewards.mjs";

export function createRewardsRoutes({ mutate, auth, clock }) {
  return async function (req, res, url) {
    if (url.pathname !== "/api/account/rewards" && !url.pathname.startsWith("/api/account/rewards/")) return NOT_HANDLED;
    const i = req.method === "POST" ? await body(req) : {};
    return mutate((s) => {
      const a = auth(req, s, "dashboardSessions"), c = a && s.customers.find((x) => x.id === a.customerId);
      if (!c) return json(res, 401, { error: "Dashboard session expired. Please sign in again." });
      const now = clock();
      try {
        if (req.method === "GET" && url.pathname === "/api/account/rewards") {
          expirePoints(s, now, c.id);
          return json(res, 200, accountRewardsView(s, c, now));
        }
        // Redeem: { offerId, idempotencyKey }. A double tap spends the points once.
        if (req.method === "POST" && url.pathname === "/api/account/rewards/redeem") {
          const done = redeemPoints(s, c, i, now, uniqueActivationCode);
          if (!done.replayed) log(s, "rewards.redeemed", { customerId: c.id, voucherId: done.voucher.id, ledgerId: done.row.id, points: -done.row.points, bundleId: done.voucher.planId });
          return json(res, 200, { replayed: done.replayed,
            saved: { voucherId: done.voucher.id, bundle: bundleSummary(done.voucher.customTerms), startBy: done.voucher.reward.startBy, points: done.voucher.reward.points, status: done.voucher.status },
            rewards: accountRewardsView(s, c, now) });
        }
        // Start now: never while another bundle is active (checked here, not in the browser).
        if (req.method === "POST" && url.pathname === "/api/account/rewards/start") {
          const done = startRedeemedBundle(s, c, String(i.voucherId || ""), now);
          if (!done.replayed) log(s, "rewards.bundle_started", { customerId: c.id, voucherId: done.voucher.id, expiresAt: done.voucher.expiresAt });
          return json(res, 200, { replayed: done.replayed, voucher: view(done.voucher, s), rewards: accountRewardsView(s, c, now) });
        }
      } catch (error) {
        if (error instanceof RewardsError) return json(res, error.status, { ...(error.code ? { code: error.code } : {}), error: error.message });
        throw error;
      }
      return json(res, 404, { error: "Not found." });
    });
  };
}
