// Outage routes (#259, server task 4). Staff: read, post a notice, post an
// update, close with time given back (fresh PIN or passkey proof when time is
// added). Public: the current notice for the hotspot page and the portal.
import { json } from "./http.mjs";
import { audit, sec } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { enqueueRouterCommand } from "../router-queue.mjs";
import { verifyAdminAction } from "../admin-sensitive-actions.mjs";
import { COMPENSATIONS, activeBundleCount, giveTimeBack, hoursFor, liveOutage, noticeView, staffView, validOutage } from "../outages.mjs";

const managers = new Set(["owner", "operator"]);
// The router stopped answering: "Detected automatically — post a notice".
function detected(s) {
  const open = (s.operationalIncidents || []).filter((n) => n.status !== "resolved" && (n.global || ["unavailable", "timeout"].includes(n.problem)));
  if (!open.length) return null;
  return { since: open.map((n) => n.firstAt).sort()[0], problem: open.some((n) => n.problem === "unavailable") ? "unavailable" : open[0].problem };
}

export function createAdminOutageRoutes({ clock, rpID, adminOrigin, adminSecret }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role }) {
    if (!url.pathname.startsWith("/api/admin/outages")) return NOT_HANDLED;
    s.outages ||= [];
    const now = clock();
    if (req.method === "GET" && url.pathname === "/api/admin/outages") {
      if (role === "reseller") return json(res, 403, { error: "Your role cannot view outages." });
      const live = liveOutage(s);
      return json(res, 200, { current: live ? staffView(s, live, now) : null, detected: live ? null : detected(s), activeBundles: activeBundleCount(s, now),
        past: s.outages.filter((o) => o.status === "fixed").sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)).slice(0, 20).map((o) => staffView(s, o, now)),
        canManage: managers.has(role) });
    }
    if (req.method !== "POST") return NOT_HANDLED;
    if (!managers.has(role)) return json(res, 403, { error: "Only owners and operators can manage outages." });
    const by = adminUser?.displayName || adminUser?.name || adminUser?.username || "NDAHI";
    if (url.pathname === "/api/admin/outages") {
      if (liveOutage(s)) return json(res, 409, { error: "An outage is already in progress. Post an update to it instead." });
      const made = validOutage(i, now);
      if (made.error) return json(res, 400, { error: made.error });
      made.outage.postedBy = by;
      s.outages.unshift(made.outage);
      audit(s, "outage.posted", req, { outageId: made.outage.id, area: made.outage.area, startedAt: made.outage.startedAt, notify: made.outage.notify, shown: made.outage.showToCustomers });
      return json(res, 201, { outage: staffView(s, made.outage, now) });
    }
    const o = s.outages.find((x) => x.id === i.outageId);
    if (!o) return json(res, 404, { error: "Outage not found." });
    if (url.pathname === "/api/admin/outages/update") {
      if (o.status !== "live") return json(res, 409, { error: "This outage is closed." });
      const text = String(i.text || "").trim().slice(0, 500), next = i.nextUpdateBy ? Date.parse(i.nextUpdateBy) : null;
      if (!text) return json(res, 400, { error: "Write the update." });
      if (next !== null && !(next > +now)) return json(res, 400, { error: "The next update must be later than now." });
      o.updates.push({ at: now.toISOString(), by, text });
      if (next) o.nextUpdateBy = new Date(next).toISOString();
      audit(s, "outage.updated", req, { outageId: o.id });
      return json(res, 200, { outage: staffView(s, o, now) });
    }
    // Close: back online, and the time given back (one audited action, once).
    if (url.pathname === "/api/admin/outages/close") {
      if (!COMPENSATIONS.includes(i.compensation)) return json(res, 400, { error: "Choose the time to give back." });
      if (o.status === "fixed") return json(res, 200, { outage: staffView(s, o, now), idempotent: true });
      const closing = { ...o, fixedAt: now.toISOString() }, hours = hoursFor(i.compensation, closing, now);
      if (hours > 0) {
        const failures = s.securityEvents.filter((e) => e.type === "admin.outage_verification.failed" && Date.parse(e.meta?.attemptedAt || e.at) > +now - 900000 && e.meta?.userId === adminUser?.id);
        if (failures.length >= 5) return json(res, 429, { error: "Too many verification attempts. Try again in 15 minutes." });
        const proof = await verifyAdminAction({ s, user: adminUser, session: administrator, input: i, purpose: "outage_compensation", clock, rpID, origin: adminOrigin, secret: adminSecret });
        if (proof.throttle) return json(res, 429, { error: "Administrator verification is temporarily locked.", ...proof.throttle }, { "retry-after": String(proof.throttle.retryAfterSeconds) });
        if (!proof.verified) {
          sec(s, "admin.outage_verification.failed", req, { userId: adminUser?.id, attemptedAt: now.toISOString() });
          return json(res, 400, { code: "VERIFICATION_FAILED", error: "Verify your current administrator PIN or passkey." });
        }
      }
      Object.assign(o, { status: "fixed", fixedAt: now.toISOString(), closedBy: by, ...(i.cause ? { cause: String(i.cause).trim().slice(0, 80) } : {}) });
      const given = giveTimeBack(s, o, hours, now, (state, command) => enqueueRouterCommand(state, command, clock));
      audit(s, "outage.closed", req, { outageId: o.id, lengthMs: Date.parse(o.fixedAt) - Date.parse(o.startedAt), compensation: i.compensation, hours,
        vouchers: given.voucherIds.length, customers: given.customerIds.length });
      return json(res, 200, { outage: staffView(s, o, now) });
    }
    return NOT_HANDLED;
  };
}

// The current notice, cached briefly: hotspot page and portal before sign-in.
export function createPublicOutageRoutes({ store }) {
  return async function (req, res, url) {
    if (req.method !== "GET" || url.pathname !== "/api/outage") return NOT_HANDLED;
    const live = liveOutage(await store.snapshot());
    return json(res, 200, { outage: live && live.showToCustomers ? noticeView(live) : null }, { "cache-control": "public, max-age=30" });
  };
}
