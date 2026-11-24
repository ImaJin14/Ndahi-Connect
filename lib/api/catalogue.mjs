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

// The catalogue sold before (fixed-data plans, and the old Unlimited Home) as
// the admin sees it beside the Unlimited catalogue: on sale while the switch
// is "legacy", archived (off sale, still honoured) once it is "unlimited".
function legacyPlans(s, mode) {
  const rows = [...plans, ...s.bundles.filter((b) => !isUnlimitedBundle(b))];
  return rows.map((p) => ({ id: p.id, name: p.name, price: p.price, currency: "XAF", quotaGb: p.quotaGb ?? null, validityHours: p.validityHours,
    deviceLimit: p.deviceLimit, kind: "legacy", status: mode === "unlimited" || p.discontinued ? "archived" : "published" }));
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
      // Personal Unlimited slots bind to the MAC the router sees, which needs
      // device approval live on the router (#334): shown so the owner checks it
      // before switching (rollout, #337).
      return { mode: catalogueMode(s), switchedAt: catalogueSettings(s).switchedAt || null, deviceApproval: approvalAvailable(s),
        bundles: bundles.map(bundleView), legacy: legacyPlans(s, catalogueMode(s)) };
    };
    if (req.method === "GET" && url.pathname === PATH) {
      const status = url.searchParams.get("status");
      if (status && status !== "all" && !STATUSES.includes(status)) return json(res, 400, { error: "Unknown status filter." });
      return json(res, 200, list());
    }
    if (req.method !== "POST") return json(res, 404, { error: "Not found." });
    const action = url.pathname.slice(PATH.length + 1);
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
        const b = newBundle({ ...fields, ...limits, displayOrder: fields.displayOrder ?? Math.max(0, ...s.bundles.filter(isUnlimitedBundle).map((x) => x.displayOrder ?? 0)) + 10 }, clock());
        s.bundles.push(b);
        audit(s, "catalogue.bundle_created", req, { bundleId: b.id, name: b.name, price: b.price, accessType: b.accessType, deviceSlots: b.deviceSlots });
        return json(res, 201, { bundle: bundleView(b), ...list() });
      }
      if (action === "update") {
        const b = find();
        if (b.status === "archived") return json(res, 409, { error: "Archived bundles stay as they were sold. Create a new bundle instead." });
        const fields = bundleInput(i, b), limits = speeds(i, b);
        if (!limits) return json(res, 400, { error: "Enter valid speed limits." });
        const before = bundleView(b);
        // New checkouts use the edit; orders already placed keep their snapshot.
        applyBundleInput(b, { ...fields, ...limits }, clock());
        audit(s, "catalogue.bundle_updated", req, { bundleId: b.id, before: { name: before.name, price: before.price, validityHours: before.validityHours, deviceSlots: before.deviceSlots },
          after: { name: b.name, price: b.price, validityHours: b.validityHours, deviceSlots: b.deviceSlots } });
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
        const ids = Array.isArray(i.ids) ? i.ids : [];
        const rows = ids.map((id) => s.bundles.find((x) => x.id === id && isUnlimitedBundle(x)));
        if (!ids.length || rows.some((x) => !x) || new Set(ids).size !== ids.length) return json(res, 400, { error: "Send the bundles in their new order." });
        rows.forEach((b, index) => { b.displayOrder = (index + 1) * 10; b.updatedAt = clock().toISOString(); });
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
