import { createHmac, randomUUID } from "node:crypto";

export const homeEnabled = env => env.NDAHI_HOME_ENABLED === "true";
export const homeCollections = ["homeConnections", "homeChallenges", "homeOperations", "homeUsageObservations"];
export function ensureHome(s) { for (const key of homeCollections) s[key] ??= []; return s; }
export function homeError(code, message, status = 409) { return Object.assign(Error(message), { code, status }); }
export function homeSecret(id, key) {
  if (!key || key.length < 16) throw homeError("HOME_UNAVAILABLE", "Home access credentials are not configured.", 503);
  return createHmac("sha256", key).update(`ndahi-home-v1:${id}`).digest("hex");
}
export const currentHome = (s, customerId) => {
  const c = s.customers.find(c => c.id === customerId);
  return (s.homeConnections || []).find(h => h.id === c?.homeConnectionId && h.customerId === customerId && h.status === "linked");
};
export const usable = (v, now) => v && v.status === "active" && Date.parse(v.expiresAt) > +now &&
  (v.quotaBytes === null || Number.isSafeInteger(v.quotaBytes) && v.quotaBytes > (v.usedBytes || 0));
export function homeAudit(s, type, customerId, now, meta = {}) {
  ensureHome(s).homeUsageObservations.push({ id: randomUUID(), type, customerId, at: now.toISOString(), ...meta });
}
export function homePaymentFields(s, customer, requested, enabled) {
  const mode = requested ?? customer.accessModeIntent ?? "direct";
  if (!["home", "direct"].includes(mode)) throw homeError("HOME_INVALID_MODE", "Choose direct-device or Home router access.", 400);
  if (mode === "direct") return { accessMode: "direct" };
  const link = currentHome(s, customer.id);
  if (!enabled || !link) throw homeError("HOME_LINK_REQUIRED", "Link your Home router before purchasing Home access.");
  return { accessMode: "home", homeConnectionId: link.id, homeGeneration: link.generation };
}
export function queueHome(s, kind, customerId, now, fields = {}) {
  ensureHome(s);
  const existing = s.homeOperations.find(o => o.kind === kind && o.customerId === customerId && o.voucherId === fields.voucherId &&
    ["queued", "processing", "retry"].includes(o.status));
  if (existing) return existing;
  if(kind === "refresh"){
    const prior=s.homeOperations.find(o=>o.kind===kind && o.customerId===customerId && o.voucherId===fields.voucherId);
    if(prior){Object.assign(prior,{status:"queued",attempts:0,nextAttemptAt:now.toISOString()});return prior;}
  }
  const operation = { id: randomUUID(), kind, customerId, status: "queued", phase: "revoke", attempts: 0,
    createdAt: now.toISOString(), nextAttemptAt: now.toISOString(), ...fields };
  s.homeOperations.push(operation);
  return operation;
}
export function reserveHomeLink(s, customerId, proof, challengeId, name, now) {
  ensureHome(s);
  const c = s.customers.find(c => c.id === customerId), challenge = s.homeChallenges.find(ch => ch.id === challengeId && ch.customerId === customerId);
  if (!c || c.suspended || c.status === "suspended") throw homeError("HOME_FORBIDDEN", "Account is unavailable.", 403);
  if (!challenge || challenge.status !== "ready" || !(Date.parse(challenge.expiresAt) > +now) || proof.challengeId !== challengeId ||
      !/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/.test(proof.mac || "") || !proof.sessionId || !proof.hostId || !proof.address)
    throw homeError("HOME_PROOF_REQUIRED", "Complete this router's local sign-in challenge again.");
  if (s.homeConnections.some(h => h.mac === proof.mac && ["linked", "reserved", "retiring"].includes(h.status) && h.customerId !== customerId))
    throw homeError("HOME_ALREADY_LINKED", "This upstream connection is already linked to an account.");
  if (s.homeOperations.some(o => o.customerId === customerId && ["queued", "processing", "retry", "needs_review"].includes(o.status)))
    throw homeError("HOME_OPERATION_PENDING", "Finish or resolve the current router operation before linking again.");
  const old = currentHome(s, customerId);
  const link = { id: randomUUID(), customerId, mac: proof.mac, address: proof.address, hostId: proof.hostId,
    name: String(name || "Home router").replace(/[\u0000-\u001f]/g, "").slice(0, 80),
    routerRevision: challenge.routerRevision, generation: randomUUID(), verifiedAt: now.toISOString(), status: old ? "reserved" : "linked" };
  challenge.status = "consumed"; challenge.usedAt = now.toISOString(); challenge.mac = proof.mac;
  if (old && old.mac === proof.mac) {
    old.address = proof.address; old.verifiedAt = now.toISOString(); old.name = link.name;
    return old;
  }
  s.homeConnections.push(link);
  if (old) {
    old.status = "retiring";
    queueHome(s, "replace", customerId, now, { oldConnectionId: old.id, connectionId: link.id });
  } else { c.homeConnectionId = link.id; c.accessModeIntent = "home"; }
  homeAudit(s, old ? "router.replacement_requested" : "router.linked", customerId, now, { connectionId: link.id });
  return link;
}
export function requestHomeMode(s, customerId, voucherId, mode, now) {
  ensureHome(s);
  const c = s.customers.find(c => c.id === customerId), v = s.vouchers.find(v => v.id === voucherId && v.customerId === customerId);
  if (!c || c.suspended || c.status === "suspended") throw homeError("HOME_FORBIDDEN", "Account is unavailable.", 403);
  if (!["home", "direct"].includes(mode) || !usable(v, now)) throw homeError("HOME_BUNDLE_UNAVAILABLE", "Choose a bundle with data and validity remaining.");
  if (v.accessTransitionId) return s.homeOperations.find(o => o.id === v.accessTransitionId);
  if(s.homeOperations.some(o=>o.customerId===customerId && ["queued","processing","retry"].includes(o.status)))
    throw homeError("HOME_OPERATION_PENDING","Wait for the current router operation to finish.");
  const link = currentHome(s, customerId);
  if (mode === "home" && !link) throw homeError("HOME_LINK_REQUIRED", "Link your Home router first.");
  if ((v.accessMode || "direct") === mode && (mode === "direct" ||
    v.homeConnectionId===link.id && v.homeGeneration===link.generation && v.homeStatus!=="revoked")) return null;
  const operation = queueHome(s, "mode", customerId, now, { voucherId, mode, connectionId: link?.id, generation: link?.generation });
  v.accessTransitionId = operation.id; v.routerSyncStatus = "pending";
  for (const p of s.wifiPairingRequests || []) if (p.customerId === customerId && ["connecting", "pending", "awaiting_code", "awaiting_confirmation"].includes(p.status)) {
    p.status = "cancelled"; p.updatedAt = now.toISOString(); p.message = "Access mode is changing.";
  }
  homeAudit(s, "mode.requested", customerId, now, { voucherId, mode });
  return operation;
}
export function applyHomeUsage(s, v, reading, now) {
  const ledger = v.homeAccounting;
  if (!ledger || !reading || !Number.isSafeInteger(reading.bytes) || reading.bytes < 0 || reading.epoch !== ledger.epoch ||
      reading.bytes < ledger.raw || reading.generation !== v.homeGeneration)
    throw homeError("HOME_ACCOUNTING_REVIEW", "Home usage continuity needs review. Your payment and remaining recorded allowance are retained.");
  const delta = reading.bytes - ledger.raw;
  v.usedBytes = Math.max(v.usedBytes || 0, ledger.base + reading.bytes);
  ledger.raw = reading.bytes; v.lastUsageSyncAt = now.toISOString();
  if (delta) {
    ensureHome(s);
    const id=`usage:${v.id}:${v.homeGeneration}:${ledger.epoch}`;
    let observation=s.homeUsageObservations.find(o=>o.id===id);
    if(!observation){observation={id,type:"usage.high_water",customerId:v.customerId,voucherId:v.id,generation:v.homeGeneration,epoch:ledger.epoch};s.homeUsageObservations.push(observation);}
    Object.assign(observation,{raw:reading.bytes,usedBytes:v.usedBytes,at:now.toISOString()});
  }
  if (v.quotaBytes !== null && v.usedBytes >= v.quotaBytes) v.status = "exhausted";
  return delta;
}
export function homeView(s, customerId, now, enabled) {
  ensureHome(s);
  const c = s.customers.find(c => c.id === customerId), link = currentHome(s, customerId);
  const v = s.vouchers.filter(v => v.customerId === customerId).sort((a,b) => Date.parse(b.activatedAt || 0) - Date.parse(a.activatedAt || 0))[0];
  const pending = s.homeOperations.filter(o => o.customerId === customerId && o.status !== "processed").slice(-10);
  const age = v?.lastUsageSyncAt ? +now - Date.parse(v.lastUsageSyncAt) : Infinity;
  return { enabled, observedAt: now.toISOString(), byteUnit: "GB", bytesPerGB: 1e9, usageIncludes: ["upload", "download"],
    accessMode: v?.accessMode || "direct", selectedMode: c?.accessModeIntent || "direct",
    link: link ? { id: link.id, name: link.name, identifierSuffix: link.mac.slice(-5), verifiedAt: link.verifiedAt } : null,
    bundle: v ? { id: v.id, planId: v.planId, status: Date.parse(v.expiresAt) <= +now ? "expired" : v.status,
      quotaBytes: v.quotaBytes, usedBytes: v.usedBytes, remainingBytes: v.quotaBytes === null ? null : Math.max(0, v.quotaBytes - (v.usedBytes || 0)),
      expiresAt: v.expiresAt, lastUpdatedAt: v.lastUsageSyncAt || null, usageState: age >= 0 && age <= 60000 ? "fresh" : "stale",
      assignmentRequired: Boolean(link && (v.homeConnectionId!==link.id || v.homeGeneration!==link.generation || v.homeStatus==="revoked")),
      authorization: v.homeStatus || v.routerSyncStatus || "pending", eligible: usable(v, now), transition: Boolean(v.accessTransitionId) } : null,
    operations: pending.map(o => ({ id: o.id, kind: o.kind, status: o.status, attempts: o.attempts, code: o.errorCode || null,
      message: o.errorCode === "HOME_ACCOUNTING_REVIEW" ? "Accounting review required; do not pay again." : o.status === "retry" ? "Waiting for router synchronization. Do not pay again." : "Waiting for router confirmation." })) };
}
