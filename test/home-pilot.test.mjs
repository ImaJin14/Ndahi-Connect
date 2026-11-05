import test from "node:test";
import assert from "node:assert/strict";
import { evaluateHomePilot, homePilotChecks } from "../lib/home-pilot.mjs";

const now = new Date("2030-01-01T12:00:00Z");
const fingerprint = "a".repeat(64);
export function pilotReport() {
  return { version: 1, evidenceKind: "physical", device: { model: "Any vendor", hardwareRevision: "v1", firmware: "1.0" },
    gatewayVersion: "7.x", startedAt: "2030-01-01T10:00:00Z", completedAt: "2030-01-01T11:00:00Z",
    capabilities: { mode: "wisp-nat", privateLan: true, stableUpstreamMac: true, privateLanType: "external-lan-access-point" },
    bytesPerGB: 1e9, usage: "upload+download", meter: "independent-capture", configurationHash: fingerprint,
    checks: homePilotChecks.map(id => ({ id, result: "passed", evidenceHash: fingerprint })),
    quotaTrials: Array.from({ length: 100 }, (_, i) => ({ trialId: `quota-${i}`, remainingBytes: 1e6,
      measuredBytes: 1e6 + i, newInternetConnections: 0, evidenceHash: fingerprint })),
    activationTrials: Array.from({ length: 100 }, (_, i) => ({ trialId: `activation-${i}`, latencyMs: 1000 + i, evidenceHash: fingerprint })),
  };
}

test("pilot evaluation is vendor-neutral, labels reported evidence and never enables Home", () => {
  for (const model of ["Brand A", "Unregistered brand", "Customer-built NAT router"]) {
    const report = pilotReport(); report.device.model = model;
    const result = evaluateHomePilot(report, { now });
    assert.equal(result.status, "reported_pass");
    assert.equal(result.maxOvershootBytes, 99);
    assert.equal(result.activationP95Ms, 1094);
    assert.equal(result.canEnableAutomatically, false);
    assert.equal(result.requiresIndependentReview, true);
  }
  const simulated = pilotReport(); simulated.evidenceKind = "synthetic";
  assert.equal(evaluateHomePilot(simulated, { now }).status, "simulation_only");
});

test("pilot evaluation rejects missing, duplicated, failed, future and out-of-tolerance measurements", () => {
  for (const alter of [r => { r.capabilities.mode = "bridge"; }, r => { delete r.device.firmware; },
    r => { r.checks.pop(); }, r => { r.quotaTrials.pop(); },
    r => { r.quotaTrials[1].trialId = r.quotaTrials[0].trialId; },
    r => { r.activationTrials[1].trialId = r.activationTrials[0].trialId; },
    r => { r.quotaTrials[0].measuredBytes = 1e6 + 1048577; },
    r => { r.quotaTrials[0].newInternetConnections = 1; },
    r => { r.activationTrials.slice(0, 6).forEach(trial => { trial.latencyMs = 31000; }); },
    r => { r.completedAt = "2031-01-01T00:00:00Z"; },
    r => { r.startedAt = { toString: null }; },
    r => { r.usage = "download-only"; }]) {
    const report = pilotReport(); alter(report);
    const result = evaluateHomePilot(report, { now });
    assert.equal(result.status, "incomplete_or_failed");
    assert.ok(result.reasons.length);
    assert.equal(result.canEnableAutomatically, false);
  }
  assert.equal(evaluateHomePilot(null).status, "incomplete_or_failed");
});
