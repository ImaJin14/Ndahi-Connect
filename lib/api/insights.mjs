import { recordedCollectionsByDay, insightsDataAvailability } from "../insights.mjs";
import { json } from "./http.mjs";
import { NOT_HANDLED } from "./routing.mjs";

// The administrative router must authenticate the session before invoking this
// handler. Explicit dates avoid implying that incomplete historical data is a
// complete financial report.
export function createInsightsRoutes() {
  return async function (req, res, url, { s, role }) {
    if (req.method !== "GET" || url.pathname !== "/api/admin/insights") return NOT_HANDLED;
    res.setHeader("cache-control", "no-store");
    // Owner-only, as issue #262 sets out unless the owner decides otherwise.
    if (role !== "owner")
      return json(res, 403, { error: "Your role does not permit financial reports." });
    const from = url.searchParams.get("from"), to = url.searchParams.get("to");
    if (!from || !to || url.searchParams.getAll("from").length !== 1 || url.searchParams.getAll("to").length !== 1)
      return json(res, 400, { error: "Choose a valid reporting period." });
    try {
      return json(res, 200, { collections: recordedCollectionsByDay(s, { from, to }), availability: insightsDataAvailability() });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return json(res, 400, { error: "Choose a valid period of at most 92 days." });
    }
  };
}
