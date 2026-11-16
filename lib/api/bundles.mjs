import { secureToken } from "../security.mjs";
import { json } from "./http.mjs";
import { audit, plans } from "./state.mjs";
import { NOT_HANDLED } from "./routing.mjs";

// Omitted fields preserve the previous setting for older admin clients. An
// explicit null or empty string removes a limit. Values are Mbps; three
// decimal places permit conversion to integer kbps without rounding.
function speedLimits(input, current = {}) {
  const limits = {};
  for (const field of ["downloadMbps", "uploadMbps"]) {
    const raw = Object.hasOwn(input, field) ? input[field] : current[field];
    if (raw == null || raw === "") { limits[field] = null; continue; }
    if ((typeof raw !== "number" && typeof raw !== "string") ||
        (typeof raw === "string" && !/^\d+(?:\.\d{1,3})?$/.test(raw.trim()))) return null;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > 10000 ||
        !Number.isSafeInteger(Math.round(value * 1000)) ||
        Math.abs(value * 1000 - Math.round(value * 1000)) > 1e-8) return null;
    limits[field] = value;
  }
  return limits;
}
export function createBundlesRoutes({ clock }) {
  return async function (req, res, url, { s, i, administrator, adminUser, role, effects }) {
    if (req.method === "POST" && url.pathname === "/api/admin/bundles") {
      const limits = speedLimits(i);
      if (!limits) return json(res, 400, { error: "Enter valid bundle speed limits." });
      const bundle = {
        id: `custom-${secureToken(8)}`,
        name: String(i.name || "").slice(0, 80),
        price: Number(i.price),
        quotaGb: i.quotaGb === null ? null : Number(i.quotaGb),
        validityHours: Number(i.validityHours),
        deviceLimit: Number(i.deviceLimit),
        ...limits,
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
        limits = speedLimits(i, original),
        updated = {
          name: String(i.name || "")
            .trim()
            .slice(0, 80),
          price: Number(i.price),
          quotaGb: i.quotaGb === null || i.quotaGb === "" ? null : Number(i.quotaGb),
          validityHours: Number(i.validityHours),
          deviceLimit: Number(i.deviceLimit),
          ...limits,
        };
      if (
        !limits ||
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
      const limits = speedLimits(i, bundle);
      const updated = {
        name: String(i.name || "")
          .trim()
          .slice(0, 80),
        price: Number(i.price),
        quotaGb: i.quotaGb === null || i.quotaGb === "" ? null : Number(i.quotaGb),
        validityHours: Number(i.validityHours),
        deviceLimit: Number(i.deviceLimit),
        ...limits,
      };
      if (
        !limits ||
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
