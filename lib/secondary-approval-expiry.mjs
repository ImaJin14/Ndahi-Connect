import { createHash } from "node:crypto";
import { approvalAvailable } from "./wifi-approval.mjs";
import { routerRevision, isMainDevice } from "./device-identities.mjs";
import { invalidateAppDevice } from "./wifi-app-associations.mjs";
import { enqueueRouterCommand } from "./router-queue.mjs";

export const secondaryApprovalGraceMs = 30 * 60 * 1000;
export const secondaryObservationMaxGapMs = 120000;
export const approvalGeneration = (grant) => grant.generation || grant.approvedAt || grant.id;
const isSecondary = (s, grant) => grant.status === "approved" && grant.routerRevision === routerRevision(s) &&
  s.customers.some((c) => c.id === grant.customerId && !isMainDevice(s, c, grant.mac));

export const hasSecondaryApprovals = (s) => approvalAvailable(s) && (s.wifiDeviceGrants || []).some((g) => isSecondary(s, g));

export function pauseSecondaryObservations(s) {
  for (const grant of s.wifiDeviceGrants || []) if (grant.secondaryOffline) grant.secondaryOffline.observedAt = null;
}

export function confirmSecondaryDisconnect(s, customerId, mac, now) {
  if (!approvalAvailable(s)) return;
  const grant = (s.wifiDeviceGrants || []).find((g) => g.customerId === customerId && g.mac === mac && isSecondary(s, g));
  if (grant) grant.secondaryOffline = { generation: approvalGeneration(grant), durationMs: 0, observedAt: now.toISOString() };
}

// Called only for complete, non-superseded router reads. No UI activity, failed
// read or wall-clock timer can advance this policy. A new process establishes a
// baseline before it counts an interval that predates its own start.
export function observeSecondaryApprovals(s, readings, now, { processStartedAt = now, readStartedAt = now, expectedGrants } = {}) {
  if (!approvalAvailable(s)) return 0;
  const complete = new Map(), duplicates = new Set(), seen = new Set();
  for (const reading of readings) {
    if (seen.has(reading.voucherId)) duplicates.add(reading.voucherId);
    seen.add(reading.voucherId);
    if (Array.isArray(reading.devices) && reading.devices.length <= 100 && reading.devices.every((d) => /^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(d?.mac || ""))) complete.set(reading.voucherId, reading);
  }
  for (const id of duplicates) complete.delete(id);
  const expected = expectedGrants && new Map(expectedGrants.map((g) => [g.id, g]));
  let expired = 0;
  for (const grant of s.wifiDeviceGrants || []) {
    if (!isSecondary(s, grant)) { delete grant.secondaryOffline; continue; }
    const generation = approvalGeneration(grant), prior = grant.secondaryOffline;
    // Fence reads started before a concurrent approval/reconnect, even within
    // one clock tick. A late present/missing response cannot rewrite new evidence.
    if (expected && (!expected.has(grant.id) || expected.get(grant.id).generation !== generation ||
      expected.get(grant.id).revision !== (grant.observationRevision || 0))) continue;
    if (Date.parse(grant.secondaryObservationAt) > +readStartedAt || Date.parse(grant.approvedAt) > +readStartedAt) continue;
    const owned = s.vouchers.filter((v) => v.customerId === grant.customerId);
    const required = new Set(owned.filter((v) => v.status === "active" || v.id === grant.voucherId).map((v) => v.id));
    if (!required.size && owned.length === 1) required.add(owned[0].id);
    if (!required.size || [...required].some((id) => !complete.has(id))) {
      if (grant.secondaryOffline) grant.secondaryOffline.observedAt = null;
      continue;
    }
    const evidence = [...required].map((id) => complete.get(id).observation);
    const trusted = evidence.every((e) => e && Number.isFinite(Date.parse(e.bootAt)) &&
      Date.parse(e.startedAt) >= +readStartedAt && Date.parse(e.completedAt) >= Date.parse(e.startedAt) &&
      +now >= Date.parse(e.completedAt) && +now - Date.parse(e.startedAt) <= secondaryObservationMaxGapMs &&
      Date.parse(e.bootAt) <= Date.parse(e.completedAt));
    if (!trusted || evidence.some((e) => Math.abs(Date.parse(e.bootAt) - Date.parse(evidence[0].bootAt)) > 5000)) {
      if (prior) prior.observedAt = null;
      continue;
    }
    grant.secondaryObservationAt = now.toISOString();
    const bootAt = evidence[0].bootAt;
    if ([...complete.values()].some((r) => owned.some((v) => v.id === r.voucherId) && r.devices.some((d) => d.mac === grant.mac))) {
      delete grant.secondaryOffline; continue;
    }
    const gap = prior ? +now - Date.parse(prior.observedAt) : Infinity;
    const supported = prior?.generation === generation && gap >= 0 && gap <= secondaryObservationMaxGapMs &&
      Date.parse(prior.observedAt) >= +processStartedAt && Math.abs(Date.parse(prior.bootAt) - Date.parse(bootAt)) <= 5000;
    const retained = prior?.generation === generation && Number.isFinite(prior.durationMs) && prior.durationMs >= 0 ? Math.min(secondaryApprovalGraceMs, prior.durationMs) : 0;
    const offline = { generation, bootAt, observedAt: now.toISOString(), durationMs: retained + (supported ? gap : 0) };
    grant.secondaryOffline = offline;
    if (offline.durationMs < secondaryApprovalGraceMs) continue;
    const connecting = (s.wifiPairingRequests || []).some((p) => p.customerId === grant.customerId && p.mac === grant.mac && p.status === "connecting");
    const changing = (s.routerCommands || []).some((c) => ["connect_wifi_device", "disconnect_wifi_device", "revoke_wifi_device"].includes(c.action) &&
      ["queued", "retry", "processing", "dead_letter"].includes(c.status) &&
      ((c.customerId === grant.customerId || owned.some((v) => v.id === c.device?.voucherId)) && (c.grantId === grant.id || c.device?.mac === grant.mac)));
    if (connecting || changing) continue;
    const targetId = createHash("sha256").update(JSON.stringify([grant.id, generation])).digest("hex").slice(0, 32);
    const command = enqueueRouterCommand(s, { action: "revoke_wifi_device", targetId }, () => now);
    // Old workers must not consume this new policy during a rolling release.
    Object.assign(command, { kind: "wifi_approval_expiry", customerId: grant.customerId, grantId: grant.id,
      grantGeneration: generation, routerRevision: grant.routerRevision,
      expiryTargets: owned.filter((v) => required.has(v.id)).map((v) => ({ voucherId: v.id, username: v.code })) });
    grant.status = "revoked"; grant.revokedAt = now.toISOString(); grant.revocationCommandId = command.id;
    grant.expiries ??= [];
    if (!grant.expiries.some((e) => e.generation === generation)) grant.expiries.push({ generation, at: now.toISOString(), commandId: command.id, name: grant.name || null, mac: grant.mac });
    invalidateAppDevice(s, grant.customerId, grant.mac, now);
    for (const request of s.wifiPairingRequests || []) if (request.customerId === grant.customerId && request.mac === grant.mac && ["pending", "awaiting_code"].includes(request.status)) {
      request.status = "cancelled"; request.updatedAt = now.toISOString(); request.message = "Saved approval expired. Request fresh main-device approval.";
      delete request.codeHash; delete request.codeNonce;
    }
    expired++;
  }
  return expired;
}
