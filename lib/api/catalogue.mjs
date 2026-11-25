// Admin API for the Unlimited catalogue (#332; canvas: AdminBundles,
// AdminBundleEdit). Owners and operators list, create, edit, publish,
// unpublish, reorder and delete bundles; a bundle with any sale behind it is
// archived instead of deleted, and nothing ever cascades into orders,
// vouchers or payments. Only the owner flips the catalogue switch. Every
// write is audited.
import { json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";
import { audit, plans } from "./state.mjs";
import {
  seedCatalogue, catalogueMode, catalogueSettings, isUnlimitedBundle, bundleInput, newBundle, applyBundleInput,
  bundleInUse, bundleView, STATUSES,
} from "../catalogue.mjs";
import { snapshotBundleSpeeds } from "../bundle-speed-policy.mjs";
import { approvalAvailable } from "../wifi-approval.mjs";

const PATH = "/api/admin/catalogue";

// Optional speed limits (decisions.md: "Speed limits stay optional"), with the
// rules of lib/bundle-speed-policy.mjs. Omitted keeps the current values.
function speeds(input, current = {}) {
  const limits = {};
  for (const field of ["downloadMbps", "uploadMbps"]) {
    const raw = Object.hasOwn(input, field) ? input[field] : current[field];
    if (raw == null || raw === "") { limits[field] = null; continue; }
    if ((typeof raw !== "number" && typeof raw !== "string") || (typeof raw === "string" && !/^\d+(?:\.\d{1,3})?$/.test(raw.trim()))) return null;
    limits[field] = Number(raw);
  }
  try { return snapshotBundleSpeeds(limits); } catch { return null; }
}

// How each bundle is used (canvas AdminBundles, "Used by"; #338). Orders are
// every checkout placed for it plus every voucher issued without one (gifts,
// admin and store vouchers). Active counts bundles running now or bought and
// waiting for their first connection (#334).
function usage(s) {
  const rows = new Map(), row = (id) => rows.get(id) || rows.set(id, { orders: 0, active: 0, pending: 0, pendingPrices: new Set() }).get(id);
  for (const p of s.payments) {
    if (!p.planId) continue;
    row(p.planId).orders++;
    // Checkouts not settled yet keep the price they were placed at (AdminBundleEdit, "Who a change affects").
    if (p.status === "pending") { row(p.planId).pending++; row(p.planId).pendingPrices.add(p.planSnapshot?.price ?? p.amount); }
  }
  for (const v of s.vouchers) {
    if (!v.planId) continue;
    if (!v.paymentId) row(v.planId).orders++;
    if (v.status === "active" || (v.status === "available" && v.startsOnFirstConnection === true)) row(v.planId).active++;
  }
  return rows;
}
const used = (rows, id) => {
  const { orders = 0, active = 0, pending = 0, pendingPrices = new Set() } = rows.get(id) || {};
  return { orders, active, pending, pendingPrice: pendingPrices.size === 1 ? [...pendingPrices][0] : null };
};

// The catalogue sold before (fixed-data plans, and the old Unlimited Home) as
// the admin sees it beside the Unlimited catalogue: on sale while the switch
// is "legacy", archived (off sale, still honoured) once it is "unlimited".
// Read-only here: until the switch, they are edited in the earlier admin
// (owner, https://github.com/ImaJin14/Ndahi-Connect/issues/338#issuecomment-7144376762).
const legacyRows = (s) => [...plans, ...s.bundles.filter((b) => !isUnlimitedBundle(b))];
function legacyPlans(s, mode, rows = usage(s)) {
  const order = catalogueSettings(s).legacyOrder || {};
  return legacyRows(s).map((p, index) => ({ id: p.id, name: p.name, price: p.price, currency: "XAF", quotaGb: p.quotaGb ?? null, validityHours: p.validityHours,
    deviceLimit: p.deviceLimit, kind: "legacy", status: mode === "unlimited" || p.discontinued ? "archived" : "published",
    // After every Unlimited bundle until moved.
    displayOrder: Number.isSafeInteger(order[p.id]) ? order[p.id] : 1e6 + index * 10, ...used(rows, p.id), inUse: bundleInUse(s, p.id) }));
}

export function createCatalogueRoutes({ clock }) {
  return async function (req, res, url, { s, i, role }) {
    if (url.pathname !== PATH && !url.pathname.startsWith(PATH + "/")) return NOT_HANDLED;
    if (!["owner", "operator"].includes(role)) return json(res, 403, { error: "Your role does not permit catalogue management." });
    // The starting catalogue, inserted once (idempotent) the first time the
    // catalogue is managed, and always before the owner can switch it on. No
    // write at server start; a deleted or archived bundle is never recreated.
    seedCatalogue(s, clock());
    const mode = catalogueMode(s);
    const list = () => {
      const status = url.searchParams.get("status") || "all";
      const bundles = s.bundles.filter((b) => isUnlimitedBundle(b) && (status === "all" || b.status === status))
        .sort((a, b) => (a.displayOrder ?? 0) - (b.displayOrder ?? 0) || a.price - b.price);
      const rows = usage(s);
      // "Most bought" in the price grid: the published Personal Unlimited bundle with the most orders.
      const best = bundles.filter((b) => b.accessType === "personal_unlimited" && b.status === "published" && used(rows, b.id).orders > 0)
        .reduce((top, b) => (!top || used(rows, b.id).orders > used(rows, top.id).orders ? b : top), null);
      // Personal Unlimited slots bind to the MAC the router sees, which needs
      // device approval live on the router (#334): shown so the owner checks it
      // before switching (rollout, #337).
      return { mode: catalogueMode(s), switchedAt: catalogueSettings(s).switchedAt || null, deviceApproval: approvalAvailable(s),
        bundles: bundles.map((b) => ({ ...bundleView(b), ...used(rows, b.id), inUse: bundleInUse(s, b.id), mostBought: b === best })),
        legacy: legacyPlans(s, catalogueMode(s), rows) };
    };
    if (req.method === "GET" && url.pathname === PATH) {
      const status = url.searchParams.get("status");
      if (status && status !== "all" && !STATUSES.includes(status)) return json(res, 400, { error: "Unknown status filter." });
      return json(res, 200, list());
    }
    if (req.method !== "POST") return json(res, 404, { error: "Not found." });
    const action = url.pathname.slice(PATH.length + 1);
    // Every bundle in the order customers see, earlier plans included.
    const ordered = () => [...s.bundles.filter(isUnlimitedBundle).map((b) => ({ id: b.id, displayOrder: b.displayOrder ?? 0 })), ...legacyPlans(s, mode, new Map())]
      .sort((a, b) => a.displayOrder - b.displayOrder).map((b) => b.id);
    // Puts the bundle at a 1-based place in that order (the edit screen's display order).
    const place = (b, position) => {
      if (position === undefined || position === null || position === "") return;
      const at = Number(position), ids = ordered().filter((id) => id !== b.id);
      if (!Number.isSafeInteger(at) || at < 1) throw Object.assign(new Error("Enter a display order of 1 or more."), { status: 400 });
      ids.splice(Math.min(at, ids.length + 1) - 1, 0, b.id);
      setOrder(ids);
    };
    // Saves an order of bundle ids; false when it names an unknown or repeated bundle.
    function setOrder(ids) {
      const legacy = legacyRows(s);
      const rows = ids.map((id) => s.bundles.find((x) => x.id === id && isUnlimitedBundle(x)) || legacy.find((x) => x.id === id));
      if (!ids.length || rows.some((x) => !x) || new Set(ids).size !== ids.length) return false;
      const legacyOrder = { ...(catalogueSettings(s).legacyOrder || {}) };
      rows.forEach((b, index) => {
        if (isUnlimitedBundle(b)) { b.displayOrder = (index + 1) * 10; b.updatedAt = clock().toISOString(); } else legacyOrder[b.id] = (index + 1) * 10;
      });
      if (rows.some((b) => !isUnlimitedBundle(b))) s.catalogue = { ...catalogueSettings(s), legacyOrder };
      return true;
    }
    const find = () => {
      const b = s.bundles.find((x) => x.id === i.id && isUnlimitedBundle(x));
      if (!b) throw Object.assign(new Error("Bundle not found."), { status: 404 });
      if (i.version !== undefined && i.version !== b.version) throw Object.assign(new Error("This bundle changed. Reload before saving."), { status: 409 });
      return b;
    };
    try {
      if (action === "create") {
        const fields = bundleInput(i), limits = speeds(i);
        if (!limits) return json(res, 400, { error: "Enter valid speed limits." });
        if (i.status !== undefined && !["published", "unpublished"].includes(i.status)) return json(res, 400, { error: "Choose Published or Unpublished." });
        const b = newBundle({ ...fields, ...limits, status: i.status || "unpublished",
          displayOrder: fields.displayOrder ?? Math.max(0, ...s.bundles.filter(isUnlimitedBundle).map((x) => x.displayOrder ?? 0)) + 10 }, clock());
        s.bundles.push(b);
        place(b, i.position);
        audit(s, "catalogue.bundle_created", req, { bundleId: b.id, name: b.name, price: b.price, accessType: b.accessType, deviceSlots: b.deviceSlots, status: b.status });
        return json(res, 201, { bundle: bundleView(b), ...list() });
      }
      if (action === "update") {
        const b = find();
        if (b.status === "archived") return json(res, 409, { error: "Archived bundles stay as they were sold. Create a new bundle instead." });
        const fields = bundleInput(i, b), limits = speeds(i, b);
        if (!limits) return json(res, 400, { error: "Enter valid speed limits." });
        if (i.status !== undefined && !["published", "unpublished"].includes(i.status)) return json(res, 400, { error: "Choose Published or Unpublished." });
        const before = bundleView(b);
        // New checkouts use the edit; orders already placed keep their snapshot.
        applyBundleInput(b, { ...fields, ...limits, ...(i.status ? { status: i.status } : {}) }, clock());
        place(b, i.position);
        audit(s, "catalogue.bundle_updated", req, { bundleId: b.id,
          before: { name: before.name, price: before.price, accessType: before.accessType, validityHours: before.validityHours, deviceSlots: before.deviceSlots, status: before.status },
          after: { name: b.name, price: b.price, accessType: b.accessType, validityHours: b.validityHours, deviceSlots: b.deviceSlots, status: b.status } });
        return json(res, 200, { bundle: bundleView(b), ...list() });
      }
      if (action === "publish" || action === "unpublish") {
        const b = find();
        if (b.status === "archived") return json(res, 409, { error: "Archived bundles stay off sale. Create a new bundle instead." });
        const status = action === "publish" ? "published" : "unpublished";
        if (b.status !== status) {
          // Unpublishing blocks new checkout at once: the catalogue is read on every checkout.
          applyBundleInput(b, { status }, clock());
          audit(s, `catalogue.bundle_${action}ed`, req, { bundleId: b.id });
        }
        return json(res, 200, { bundle: bundleView(b), ...list() });
      }
      if (action === "reorder") {
        // The whole list in its new order. Earlier plans may sit anywhere in it;
        // their place is kept with the catalogue settings and never changes
        // what they sell or how they behave.
        const ids = Array.isArray(i.ids) ? i.ids : [];
        if (!setOrder(ids)) return json(res, 400, { error: "Send the bundles in their new order." });
        audit(s, "catalogue.bundles_reordered", req, { ids });
        return json(res, 200, list());
      }
      if (action === "delete") {
        const b = find();
        if (bundleInUse(s, b.id)) {
          // Never removed once sold: archived, off sale, and every order,
          // voucher and payment keeps pointing at it.
          if (b.status !== "archived") {
            applyBundleInput(b, { status: "archived", archivedAt: clock().toISOString() }, clock());
            audit(s, "catalogue.bundle_archived", req, { bundleId: b.id });
          }
          return json(res, 200, { archived: true, bundle: bundleView(b), ...list() });
        }
        s.bundles.splice(s.bundles.indexOf(b), 1);
        audit(s, "catalogue.bundle_deleted", req, { bundleId: b.id, name: b.name, price: b.price });
        return json(res, 200, { deleted: true, bundleId: b.id, ...list() });
      }
      if (action === "mode") {
        if (role !== "owner") return json(res, 403, { error: "Only the owner can switch the catalogue." });
        if (!["legacy", "unlimited"].includes(i.mode)) return json(res, 400, { error: "Choose legacy or unlimited." });
        if (i.mode !== mode) {
          s.catalogue = { ...catalogueSettings(s), mode: i.mode, switchedAt: clock().toISOString() };
          audit(s, "catalogue.mode_changed", req, { from: mode, to: i.mode });
        }
        return json(res, 200, list());
      }
      return json(res, 404, { error: "Not found." });
    } catch (error) {
      if (!error.status) throw error;
      return json(res, error.status, { error: error.message });
    }
  };
}
