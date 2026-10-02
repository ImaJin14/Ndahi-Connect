import { pathToFileURL } from "node:url";

// Prints the 30-day service-level report for the monthly review (OBS-005) as a
// Markdown table, from the recording rules in monitoring/prometheus/slo.yml.
const queries = {
  objective: "ndahi:slo_objective:ratio",
  errorRatio: "ndahi:slo_error_ratio:rate30d",
  budget: "ndahi:slo_error_budget_remaining:ratio30d",
  events: "ndahi:slo_events:increase30d",
};
const percent = (value, digits = 2) => `${(value * 100).toFixed(digits)}%`;

export function sloStatus({ errorRatio, budget, events }) {
  if (!Number.isFinite(errorRatio) || !Number.isFinite(budget) || !Number.isFinite(events) || events <= 0) return "no data";
  if (budget < 0) return "missed";
  if (budget < 0.25) return "at risk";
  return "met";
}

export async function sloReport({ prometheusUrl, token, request = fetch, now = new Date() }) {
  const base = new URL(prometheusUrl);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1"].includes(base.hostname)) {
    throw new Error("PROMETHEUS_URL must use HTTPS outside localhost");
  }
  const rows = new Map();
  for (const [field, query] of Object.entries(queries)) {
    const url = new URL("api/v1/query", base.href.endsWith("/") ? base : `${base.href}/`);
    url.searchParams.set("query", query);
    url.searchParams.set("time", String(now.getTime() / 1000));
    const response = await request(url, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status !== "success") throw new Error(`Prometheus query failed (${response.status})`);
    for (const { metric, value } of body.data.result) {
      const key = `${metric.slo}|${metric.instance || ""}`;
      if (!rows.has(key)) rows.set(key, { slo: metric.slo, instance: metric.instance, responder: metric.responder });
      const row = rows.get(key);
      row[field] = Number(value[1]);
      row.responder ||= metric.responder;
    }
  }
  // Per-endpoint availability rows take their objective from the SLO-wide series.
  for (const row of rows.values()) {
    const shared = rows.get(`${row.slo}|`);
    if (row.instance && shared) { row.objective ??= shared.objective; row.responder ||= shared.responder; }
  }
  const lines = [
    `30-day service levels ending ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    "",
    "| Objective | Target | Achieved | Budget left | Events | Status | Owner |",
    "| --- | --- | --- | --- | --- | --- | --- |",
  ];
  const perEndpoint = new Set([...rows.values()].filter((row) => row.instance).map((row) => row.slo));
  const ordered = [...rows.values()]
    .filter((row) => row.instance || !perEndpoint.has(row.slo))
    .sort((a, b) => `${a.slo}${a.instance || ""}`.localeCompare(`${b.slo}${b.instance || ""}`));
  for (const row of ordered) {
    const status = sloStatus(row), measured = status !== "no data";
    lines.push(`| ${row.slo}${row.instance ? ` (${row.instance})` : ""} | ${Number.isFinite(row.objective) ? percent(row.objective, 1) : "—"} | ` +
      `${measured ? percent(1 - row.errorRatio) : "—"} | ${measured ? percent(row.budget, 0) : "—"} | ` +
      `${Number.isFinite(row.events) ? Math.round(row.events) : 0} | ${status} | ${row.responder || "—"} |`);
  }
  return lines.join("\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.env.PROMETHEUS_BEARER_TOKEN_FILE) {
      throw new Error("PROMETHEUS_BEARER_TOKEN_FILE is no longer supported; use PROMETHEUS_BEARER_TOKEN");
    }
    console.log(await sloReport({
      prometheusUrl: process.env.PROMETHEUS_URL || "http://localhost:9090",
      token: process.env.PROMETHEUS_BEARER_TOKEN,
    }));
  } catch (error) {
    // Never echo the token or response bodies.
    console.error(`SLO report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
