// Rewards admin (#526; canvas AdminRewards, #530). Owners only, reads included:
// settings, the redeemable bundles, the ledger and corrections. Every change is
// audited; settings change new points only and never rewrite the ledger.
import { json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { audit } from "./state.mjs";
import { maskPhone } from "../reservations.mjs";
import { adjustPoints, bundleSummary, redeemOpen, rewardMetrics, rewardOffers, rewardSettings, updateRewardSettings, RewardsError } from "../rewards.mjs";

const DAY = 864e5;
// Newest first; rows written at the same moment keep the order they were written in, reversed.
const newestFirst = (rows) => rows.map((r, i) => [r, i]).sort(([a, i], [b, j]) => (a.at < b.at ? 1 : a.at > b.at ? -1 : j - i)).map(([r]) => r);
const person = (s, id) => {
  const c = (s.customers || []).find((x) => x.id === id);
  return c ? { id: c.id, name: c.name || "", phone: maskPhone(c.phone) } : { id, name: "", phone: "" };
};
// A ledger row as staff see it. One expiry sweep shows as one System row.
export function ledgerRowView(s, r) {
  return { id: r.id, kind: r.kind, points: r.points, at: r.at, actor: r.actor, customer: person(s, r.customerId),
    ...(r.bundle ? { bundle: r.bundle } : {}), ...(r.reason ? { reason: r.reason } : {}), ...(r.offset ? { offset: true } : {}),
    ...(r.shortfall ? { shortfall: r.shortfall } : {}), ...(r.friend ? { friend: r.friend } : {}), ...(r.invitedBy ? { invitedBy: r.invitedBy } : {}),
    ...(r.paymentId ? { paymentId: r.paymentId } : {}), ...(r.voucherId ? { voucherId: r.voucherId } : {}) };
}
function recentActivity(s, limit) {
  const rows = newestFirst((s.pointsLedger || []).filter((r) => r.points !== 0)), out = [], sweeps = new Map();
  for (const r of rows) {
    if (out.length >= limit) break;
    if (r.kind === "expired" && r.sweep) {
      const seen = sweeps.get(r.sweep);
      if (seen) { seen.points += r.points; seen.customers++; continue; }
      const row = { id: r.sweep, kind: "expired", system: true, points: r.points, at: r.at, customers: 1 };
      sweeps.set(r.sweep, row); out.push(row); continue;
    }
    out.push(ledgerRowView(s, r));
  }
  return out;
}

export function adminRewardsView(s, now) {
  const { points, referrals } = rewardSettings(s), since = +now - 30 * DAY;
  const redeemed = (s.pointsLedger || []).filter((r) => r.kind === "redeemed" && Date.parse(r.at) > since);
  return {
    settings: { points, referrals },
    catalogueUnlimited: redeemOpen(s),
    metrics: rewardMetrics(s, now),
    offers: rewardOffers(s).map((o) => ({ ...bundleSummary(o.bundle), price: o.bundle.price, points: o.points, suggested: o.suggested, redeemable: o.redeemable,
      redeemed30d: redeemed.filter((r) => r.bundle?.id === o.bundle.id).length })),
    activity: recentActivity(s, 6),
  };
}

export function createAdminRewardsRoutes({ clock }) {
  return async function (req, res, url, { s, i, role }) {
    if (url.pathname !== "/api/admin/rewards" && !url.pathname.startsWith("/api/admin/rewards/")) return NOT_HANDLED;
    if (role !== "owner") {
      audit(s, "admin.authorization.denied", req, { role, path: url.pathname });
      return json(res, 403, { error: "Only the owner can see and change rewards." });
    }
    const now = clock();
    try {
      if (req.method === "GET" && url.pathname === "/api/admin/rewards") return json(res, 200, adminRewardsView(s, now));
      // The full ledger, newest first; ?customerId= for one account, ?before=<ISO time> to page.
      if (req.method === "GET" && url.pathname === "/api/admin/rewards/ledger") {
        const customerId = url.searchParams.get("customerId"), before = url.searchParams.get("before");
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit")) || 50));
        const rows = newestFirst((s.pointsLedger || []).filter((r) => (!customerId || r.customerId === customerId) && (!before || r.at < before)));
        return json(res, 200, { rows: rows.slice(0, limit).map((r) => ledgerRowView(s, r)), more: rows.length > limit });
      }
      if (req.method === "POST" && (url.pathname === "/api/admin/rewards/settings" || url.pathname === "/api/admin/rewards/offers")) {
        const input = url.pathname.endsWith("/offers") ? { offers: i.offers } : i;
        const { previous, next } = updateRewardSettings(s, input, now, req.adminActor);
        audit(s, url.pathname.endsWith("/offers") ? "rewards.offers_updated" : "rewards.settings_updated", req, { previous, next });
        return json(res, 200, adminRewardsView(s, now));
      }
      // A correction, with its reason: { customerId, points, reason }.
      if (req.method === "POST" && url.pathname === "/api/admin/rewards/adjust") {
        const customer = (s.customers || []).find((c) => c.id === i.customerId);
        if (!customer) return json(res, 404, { error: "Customer not found." });
        const row = adjustPoints(s, customer, i, now, req.adminActor);
        audit(s, "rewards.points_adjusted", req, { customerId: customer.id, points: row.points, reason: row.reason, ledgerId: row.id });
        return json(res, 200, { row: ledgerRowView(s, row), rewards: adminRewardsView(s, now) });
      }
    } catch (error) {
      if (error instanceof RewardsError) return json(res, error.status, { ...(error.code ? { code: error.code } : {}), error: error.message });
      throw error;
    }
    return json(res, 404, { error: "Not found." });
  };
}
