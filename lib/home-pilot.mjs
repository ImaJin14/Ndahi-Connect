export const homePilotChecks = Object.freeze([
  "local_https", "link_security_negatives", "aggregate_two_clients", "quota_cutoff", "expiry_cutoff",
  "ipv6_no_bypass", "fasttrack_no_bypass", "backend_outage", "router_restart", "signal_loss",
  "offsite_renewal", "payment_router_outage", "replacement", "rollback", "old_device_accessibility",
]);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const hash = value => typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
const label = value => typeof value === "string" && value.trim().length > 0 && value.length <= 100;
const trialId = value => typeof value === "string" && /^[a-z0-9_-]{1,80}$/i.test(value);
const p95 = values => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * .95) - 1] : null;

export function homePilotTemplate() {
  return { version: 1, evidenceKind: "physical", device: { model: "", hardwareRevision: "", firmware: "" },
    gatewayVersion: "", startedAt: "", completedAt: "", configurationHash: "",
    capabilities: { mode: "wisp-nat", privateLan: false, stableUpstreamMac: false, privateLanType: "integrated-wifi" },
    bytesPerGB: 1e9, usage: "upload+download", meter: "independent-capture",
    checks: homePilotChecks.map(id => ({ id, result: "not_run", evidenceHash: "" })),
    quotaTrials: [], activationTrials: [] };
}

// Evaluates supplied evidence; it cannot certify how a measurement was made.
// No result from this module changes the production feature flag.
export function evaluateHomePilot(input, { now = new Date() } = {}) {
  const report = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  const reasons = [];
  if (report.version !== 1) reasons.push("report_version_required");
  if (!["physical", "synthetic"].includes(report.evidenceKind)) reasons.push("evidence_kind_required");
  if (![report.device?.model, report.device?.hardwareRevision, report.device?.firmware, report.gatewayVersion].every(label))
    reasons.push("device_and_gateway_record_required");
  const started = typeof report.startedAt === "string" ? Date.parse(report.startedAt) : NaN;
  const completed = typeof report.completedAt === "string" ? Date.parse(report.completedAt) : NaN;
  if (!Number.isFinite(started) || !Number.isFinite(completed) || completed < started || completed > +now)
    reasons.push("measurement_timestamps_required");
  const capabilities = report.capabilities || {};
  if (capabilities.mode !== "wisp-nat" || capabilities.privateLan !== true || capabilities.stableUpstreamMac !== true ||
      !["integrated-wifi", "ethernet-clients", "external-lan-access-point"].includes(capabilities.privateLanType))
    reasons.push("wisp_nat_capabilities_required");
  if (report.bytesPerGB !== 1e9 || report.usage !== "upload+download" || report.meter !== "independent-capture")
    reasons.push("independent_duplex_decimal_accounting_required");
  if (!hash(report.configurationHash)) reasons.push("configuration_evidence_required");
  const checks = Array.isArray(report.checks) ? report.checks : [];
  for (const id of homePilotChecks) {
    const matches = checks.filter(check => check?.id === id);
    if (matches.length !== 1 || matches[0].result !== "passed" || !hash(matches[0].evidenceHash)) reasons.push(`check_required:${id}`);
  }
  const quotaCount = Array.isArray(report.quotaTrials) ? report.quotaTrials.length : 0;
  const activationCount = Array.isArray(report.activationTrials) ? report.activationTrials.length : 0;
  const quota = Array.isArray(report.quotaTrials) ? report.quotaTrials.slice(0, 10000) : [];
  const activation = Array.isArray(report.activationTrials) ? report.activationTrials.slice(0, 10000) : [];
  if (quotaCount < 100 || quotaCount > 10000) reasons.push("quota_trial_count");
  if (activationCount < 100 || activationCount > 10000) reasons.push("activation_trial_count");
  const validQuota = quota.filter(trial => trial && trialId(trial.trialId) && integer(trial.remainingBytes) && trial.remainingBytes > 0 &&
    integer(trial.measuredBytes) && trial.measuredBytes >= trial.remainingBytes && integer(trial.newInternetConnections) && trial.newInternetConnections <= 1000000 && hash(trial.evidenceHash));
  if (validQuota.length !== quota.length) reasons.push("invalid_quota_measurements");
  if (new Set(validQuota.map(trial => trial.trialId)).size !== quota.length) reasons.push("duplicate_or_invalid_quota_trials");
  const overshoot = validQuota.map(trial => trial.measuredBytes - trial.remainingBytes);
  const maxOvershootBytes = overshoot.length ? Math.max(...overshoot) : null;
  if (maxOvershootBytes !== null && maxOvershootBytes > 1048576) reasons.push("quota_overshoot_target_failed");
  const cutoffProbeFailures = validQuota.reduce((total, trial) => total + trial.newInternetConnections, 0);
  if (cutoffProbeFailures) reasons.push("internet_cutoff_failed");
  const validActivation = activation.filter(trial => trial && trialId(trial.trialId) && integer(trial.latencyMs) && hash(trial.evidenceHash));
  if (validActivation.length !== activation.length) reasons.push("invalid_activation_measurements");
  if (new Set(validActivation.map(trial => trial.trialId)).size !== activation.length) reasons.push("duplicate_or_invalid_activation_trials");
  const activationP95Ms = p95(validActivation.map(trial => trial.latencyMs));
  if (activationP95Ms !== null && activationP95Ms > 30000) reasons.push("activation_target_failed");
  const valid = reasons.length === 0;
  return { status: !valid ? "incomplete_or_failed" : report.evidenceKind === "synthetic" ? "simulation_only" : "reported_pass",
    evidenceKind: ["physical", "synthetic"].includes(report.evidenceKind) ? report.evidenceKind : "unknown",
    quotaSamples: quotaCount, activationSamples: activationCount, maxOvershootBytes,
    overshootP95Bytes: p95(overshoot), activationP95Ms, cutoffProbeFailures, reasons,
    requiresIndependentReview: true, canEnableAutomatically: false };
}
