import { secureToken } from "../security.mjs";
import { json } from "./http.mjs";
import { audit, plans } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";
export function createBundlesRoutes({ clock }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    if (req.method === "POST" && url.pathname === "/api/admin/bundles") {
      const bundle = {
        id: `custom-${secureToken(8)}`,
        name: String(i.name || "").slice(0, 80),
        price: Number(i.price),
        quotaGb: i.quotaGb === null ? null : Number(i.quotaGb),
        validityHours: Number(i.validityHours),
        deviceLimit: Number(i.deviceLimit),
        custom: true,
        createdAt: clock().toISOString(),
      };
      if (!bundle.name || bundle.price < 0 || bundle.validityHours <= 0 || bundle.deviceLimit < 1)
        return json(res, 400, { error: "Invalid bundle." });
      s.bundles.push(bundle);
      audit(s, "bundle.created", req, { bundleId: bundle.id });
      return json(res, 201, { bundle });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/api/admin/bundles/update" &&
      plans.some((x) => x.id === i.bundleId)
    ) {
      const original = plans.find((x) => x.id === i.bundleId),
        updated = {
          name: String(i.name || "")
            .trim()
            .slice(0, 80),
          price: Number(i.price),
          quotaGb: i.quotaGb === null || i.quotaGb === "" ? null : Number(i.quotaGb),
          validityHours: Number(i.validityHours),
          deviceLimit: Number(i.deviceLimit),
        };
      if (
        !updated.name ||
        !Number.isFinite(updated.price) ||
        updated.price < 0 ||
        (updated.quotaGb !== null && (!Number.isFinite(updated.quotaGb) || updated.quotaGb <= 0)) ||
        !Number.isFinite(updated.validityHours) ||
        updated.validityHours <= 0 ||
        !Number.isInteger(updated.deviceLimit) ||
        updated.deviceLimit < 1
      )
        return json(res, 400, { error: "Enter valid bundle details." });
      Object.assign(original, updated, {
        updatedAt: clock().toISOString(),
      });
      s.bundleOverrides[original.id] = {
        ...updated,
        updatedAt: original.updatedAt,
      };
      audit(s, "bundle.updated", req, { bundleId: original.id });
      return json(res, 200, { bundle: original });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/bundles/update") {
      const bundle = s.bundles.find((x) => x.id === i.bundleId);
      if (!bundle) {
        return json(res, 404, {
          error: "Custom bundle not found. System bundles are read-only.",
        });
      }
      const updated = {
        name: String(i.name || "")
          .trim()
          .slice(0, 80),
        price: Number(i.price),
        quotaGb: i.quotaGb === null || i.quotaGb === "" ? null : Number(i.quotaGb),
        validityHours: Number(i.validityHours),
        deviceLimit: Number(i.deviceLimit),
      };
      if (
        !updated.name ||
        !Number.isFinite(updated.price) ||
        updated.price < 0 ||
        (updated.quotaGb !== null && (!Number.isFinite(updated.quotaGb) || updated.quotaGb <= 0)) ||
        !Number.isFinite(updated.validityHours) ||
        updated.validityHours <= 0 ||
        !Number.isInteger(updated.deviceLimit) ||
        updated.deviceLimit < 1
      )
        return json(res, 400, { error: "Enter valid bundle details." });
      Object.assign(bundle, updated, { updatedAt: clock().toISOString() });
      audit(s, "bundle.updated", req, { bundleId: bundle.id });
      return json(res, 200, { bundle });
    }
    if (req.method === "POST" && url.pathname === "/api/admin/bundles/delete") {
      const index = s.bundles.findIndex((x) => x.id === i.bundleId);
      if (index < 0) {
        return json(res, 404, {
          error: "Custom bundle not found. System bundles are read-only.",
        });
      }
      const bundle = s.bundles[index],
        inUse =
          s.vouchers.some((x) => x.planId === bundle.id) ||
          s.payments.some((x) => x.planId === bundle.id);
      if (inUse) {
        return json(res, 409, {
          error: "This bundle has payment or voucher history and cannot be deleted.",
        });
      }
      s.bundles.splice(index, 1);
      audit(s, "bundle.deleted", req, {
        bundleId: bundle.id,
        name: bundle.name,
      });
      return json(res, 200, { deleted: true, bundleId: bundle.id });
    }
    return NOT_HANDLED;
  };
}
