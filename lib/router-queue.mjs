import { speedQueueTarget } from "./bundle-speed-policy.mjs";
import { recordDeviceSample } from "./insights-recording.mjs";
import { randomUUID } from "node:crypto";
import { correlation, withCorrelation } from "./correlation.mjs";
import { silentLogger, errorFields } from "./logger.mjs";
import { recordUsageAlerts } from "./usage-alerts.mjs";
import { deviceName, routerRevision, isRegisteredMainDevice } from "./device-identities.mjs";
import { connectAuthorization, singleSwitchDisconnectAuthorized } from "./wifi-pairing.mjs";
import { approvalPolicy, approveDevice } from "./wifi-approval.mjs";
import { recordOperationalFailure, updateOperationalIncident } from "./operational-incidents.mjs";
import { rememberAppDevice, invalidateAppDevice } from "./wifi-app-associations.mjs";
import { observeSecondaryApprovals, confirmSecondaryDisconnect, pauseSecondaryObservations, approvalGeneration } from "./secondary-approval-expiry.mjs";

// The latest operation that queued a command; its worker run logs under this ID.
const traceTo = (command) => {
  const { correlationId } = correlation();
  if (correlationId) command.correlationId = correlationId;
  else delete command.correlationId;
};

const ACTIONS = new Set([
  "sync_voucher",
  "disconnect_voucher",
  "disconnect_device",
  "disconnect_wifi_device",
  "connect_wifi_device",
  "revoke_wifi_device",
  "mark_inactive",
  "sync_usage",
  // A bundle's shared speed limit (#263), when ROUTER_SPEED_LIMITS=on.
  "sync_speed",
]);
const successStatus = {
  sync_voucher: "synchronized",
  disconnect_voucher: "disconnected",
};
const isJob = (command) => ["router_command", "wifi_disconnect", "wifi_session_disconnect", "wifi_connect", "wifi_revoke", "wifi_approval_expiry", "wifi_single_connect", "wifi_single_disconnect"].includes(command?.kind);
const timestamp = (now) => now().toISOString();
const MAC = /^(?:[0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const result = (status, body) => ({ status, body });

async function sendDeadLetterAlert(webhookUrl, command) {
  if (!webhookUrl) return;
  try {
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: `NDAHI network command permanently failed: ${command.action} ${command.targetId} ` +
          `after ${command.totalAttempts} attempts. Reason: ${command.lastError}. ` +
          "Review in the admin dashboard under Connections → Network commands.",
      }),
      signal: AbortSignal.timeout(10000),
    });
  } catch { /* alert delivery failure must never affect command processing */ }
}

// Call from inside an existing store transaction, right after the state
// change the router needs to learn about. Idempotent: an unresolved command
// for the same action/target is left alone; a resolved one is requeued for a
// fresh attempt cycle. No network I/O happens here or in the transaction
// that calls this — the worker performs it afterwards, outside any lock.
export function enqueueRouterCommand(s, { action, targetId = "global" }, now = () => new Date()) {
  if (!ACTIONS.has(action)) throw new Error(`Unknown router command action: ${action}`);
  s.routerCommands ??= [];
  const id = `router:${action}:${targetId}`,
    existing = s.routerCommands.find((c) => c?.id === id);
  if (existing) {
    if (["queued", "processing", "retry"].includes(existing.status)) return existing;
    existing.status = "queued";
    existing.attempts = 0;
    existing.queuedAt = timestamp(now);
    existing.nextAttemptAt = timestamp(now);
    traceTo(existing);
    delete existing.leaseToken;
    delete existing.leaseUntil;
    delete existing.lastError;
    delete existing.processedAt;
    delete existing.result;
    return existing;
  }
  const command = {
    // Older workers recognize only router_command. Keep scoped jobs invisible
    // to them during a rolling deployment: their fallback dispatch is a read.
    id, kind: action === "disconnect_wifi_device" ? "wifi_disconnect" : action === "connect_wifi_device" ? "wifi_connect" : action === "revoke_wifi_device" ? "wifi_revoke" : "router_command", action, targetId, status: "queued",
    attempts: 0, totalAttempts: 0, at: timestamp(now), nextAttemptAt: timestamp(now),
  };
  traceTo(command);
  s.routerCommands.push(command);
  return command;
}

// The router stops each session at the quota it had remaining at login, but
// concurrent devices share one allowance. Cut the voucher off once its synced
// total reaches the quota.
export function enforceVoucherQuota(s, v, now = () => new Date()) {
  if (v.status !== "active" || v.quotaBytes === null || !(v.usedBytes >= v.quotaBytes)) return false;
  v.status = "exhausted";
  v.exhaustedAt ??= timestamp(now);
  enqueueRouterCommand(s, { action: "disconnect_voucher", targetId: v.id }, now);
  v.routerSyncStatus = "pending";
  return true;
}

// Operator action: an owner/operator can requeue a stuck or dead-lettered
// command after resolving the underlying router/network problem.
export function routerCommandRecovery(s, command, { requireScopedDisconnect = false } = {}) {
  const obsolete = command.action === "disconnect_device" && (requireScopedDisconnect || s.networkSetup?.runtimeRouterEnabled === true ||
    command.recoveryAction === "refresh_devices" || /legacy device disconnection|not scoped to a router session/i.test(command.lastError || ""));
  const failed = ["retry", "dead_letter"].includes(command.status);
  return { canReplay: failed && !obsolete && command.action !== "connect_wifi_device", canResolve: failed && obsolete,
    recoveryAction: obsolete ? "refresh_devices" : null };
}
export function resolveObsoleteRouterCommand(s, id, now = () => new Date(), options = {}) {
  const command = (s.routerCommands || []).find((c) => isJob(c) && c.id === id);
  if (!command) return result(404, { error: "Network command not found." });
  if (command.status === "resolved" && command.resolution === "obsolete_legacy_disconnect") return result(200, { resolved: true, commandId: id });
  if (!routerCommandRecovery(s, command, options).canResolve) return result(409, { error: "Only obsolete failed device disconnects can be resolved this way." });
  command.status = "resolved";
  command.resolution = "obsolete_legacy_disconnect";
  command.resolvedAt = timestamp(now);
  command.nextAttemptAt = null;
  updateOperationalIncident(s, command, now);
  delete command.leaseToken;
  delete command.leaseUntil;
  return result(200, { resolved: true, commandId: id });
}
export function scheduleRouterCommandReplay(s, id, now = () => new Date(), options = {}) {
  const command = (s.routerCommands || []).find((c) => isJob(c) && c.id === id);
  if (!command) return result(404, { error: "Network command not found." });
  if (!["retry", "dead_letter"].includes(command.status)) {
    return result(409, { error: "Only failed network commands can be replayed." });
  }
  if (!routerCommandRecovery(s, command, options).canReplay) return result(409, { code: "DEVICE_REFRESH_REQUIRED",
    error: "This legacy disconnect cannot be replayed. Refresh Wi-Fi devices and request a new disconnect for the current router session." });
  if (!command.operationalIncidentId) recordOperationalFailure(s, command, now);
  command.status = "queued";
  command.attempts = 0;
  command.replays = (command.replays || 0) + 1;
  command.replayedAt = timestamp(now);
  command.nextAttemptAt = timestamp(now);
  traceTo(command);
  delete command.leaseToken;
  delete command.leaseUntil;
  delete command.deadLetteredAt;
  updateOperationalIncident(s, command, now);
  return result(202, { accepted: true, commandId: command.id });
}

export function routerQueueSummary(s, options = {}) {
  const commands = (s.routerCommands || []).filter(isJob);
  return {
    pending: commands.filter((c) => ["queued", "retry", "processing"].includes(c.status)).length,
    deadLetters: commands.filter((c) => c.status === "dead_letter").length,
    commands: commands.filter((c) => !["processed", "resolved"].includes(c.status)).map((c) => ({
      id: c.id, action: c.action, targetId: c.targetId, status: c.status,
      attempts: c.attempts, totalAttempts: c.totalAttempts, lastError: c.lastError,
      nextAttemptAt: c.nextAttemptAt, at: c.at,
      ...routerCommandRecovery(s, c, options),
    })),
  };
}

export function createRouterCommandProcessor({ store, router, now = () => new Date(),
  timeoutMs = 15000, batchSize = 25, maxAttempts = 8, alertWebhookUrl, logger = silentLogger, metrics, requireScopedDisconnect = false,
  pairingSecret = "", previousPairingSecret = "", secondaryApprovalExpiry = false, speedLimits = false }) {
  const processStartedAt = now();
  const fail = (command, reason, permanent = false) => {
    command.lastError = reason;
    command.status = permanent || command.attempts >= maxAttempts ? "dead_letter" : "retry";
    // Usage reads are what keeps data counting and quotas enforced, so they wait at
    // most five minutes between attempts instead of up to an hour.
    const longestWait = command.action === "sync_usage" ? 300000 : 3600000;
    command.nextAttemptAt = command.status === "retry"
      ? new Date(+now() + Math.min(longestWait, 30000 * 2 ** (command.attempts - 1))).toISOString() : null;
    if (command.status === "dead_letter") command.deadLetteredAt = timestamp(now);
    delete command.leaseToken;
    delete command.leaseUntil;
  };
  async function process(id) {
    const claim = await store.transaction((s) => {
      s.routerCommands ??= [];
      const connecting = s.routerCommands.some((c) => c.action === "connect_wifi_device" && c.status === "processing" && Date.parse(c.leaseUntil) > +now());
      const command = s.routerCommands.find((c) => isJob(c) && (!id || c.id === id) &&
        !(c.action === "connect_wifi_device" && connecting) &&
        (["queued", "retry"].includes(c.status) && Date.parse(c.nextAttemptAt) <= +now() ||
          c.status === "processing" && Date.parse(c.leaseUntil) <= +now()));
      if (!command) return null;
      const homeTarget = command.action === "sync_voucher" && s.vouchers.find(v => v.id === command.targetId && (v.accessMode === "home" || v.accessTransitionId));
      if (homeTarget) { command.status = "processed"; command.result = "home_managed"; command.processedAt = timestamp(now); command.nextAttemptAt = null; return null; }
      if (command.singleSwitchId && !singleSwitchDisconnectAuthorized(s, command, now(), pairingSecret, previousPairingSecret)) {
        command.status = "processed"; command.result = "superseded"; command.processedAt = timestamp(now); command.nextAttemptAt = null;
        delete command.leaseToken; delete command.leaseUntil;
        const p = s.wifiPairingRequests.find(p => p.id === command.singleSwitchId);
        if (p?.status === "connecting") { p.status = "failed"; p.updatedAt = timestamp(now); p.message = "Device or bundle authorization changed. Check the current connection before switching again."; }
        return { skipped: true };
      }
      if (command.action === "connect_wifi_device") {
        const authorization = connectAuthorization(s, command, now(), pairingSecret, previousPairingSecret);
        if (authorization.waiting) { command.nextAttemptAt = new Date(+now() + 1000).toISOString(); return { deferred: true }; }
      }
      if (command.action === "revoke_wifi_device") {
        const grant = (s.wifiDeviceGrants || []).find((g) => g.id === command.grantId && g.customerId === command.customerId);
        if (!grant || grant.status !== "revoked" || grant.revocationCommandId !== command.id || command.routerRevision !== routerRevision(s) ||
          command.grantGeneration && (command.grantGeneration !== approvalGeneration(grant) ||
            isRegisteredMainDevice(s, s.customers.find((c) => c.id === grant.customerId), grant.mac))) {
          command.status = "processed"; command.result = "superseded"; command.processedAt = timestamp(now); command.nextAttemptAt = null;
          updateOperationalIncident(s, command, now);
          delete command.leaseToken; delete command.leaseUntil;
          return { skipped: true };
        }
        command.device = { mac: grant.mac, targets: command.expiryTargets || s.vouchers.filter((v) => v.customerId === grant.customerId && (v.status === "active" || v.id === grant.voucherId))
          .map((v) => ({ voucherId: v.id, username: v.code })), deadline: new Date(+now() + timeoutMs - 1000).toISOString() };
      }
      // The queue the bundle needs now: its limit and the addresses of its devices online.
      if (command.action === "sync_speed") {
        const v = s.vouchers.find((v) => v.id === command.targetId);
        command.speed = v ? speedQueueTarget(v) : { voucherId: command.targetId, uploadBps: 0, downloadBps: 0, addresses: [], key: "removed" };
      }
      if (command.action === "sync_usage") command.approvalObservationTargets = (s.wifiDeviceGrants || []).map((g) =>
        ({ id: g.id, generation: approvalGeneration(g), revision: g.observationRevision || 0 }));
      command.status = "processing";
      command.attempts++;
      command.totalAttempts++;
      command.lastAttemptAt = timestamp(now);
      command.leaseToken = randomUUID();
      command.leaseUntil = new Date(+now() + timeoutMs + 15000).toISOString();
      const approval = command.action === "connect_wifi_device" ? connectAuthorization(s, command, now(), pairingSecret, previousPairingSecret) : null;
      const voucher = approval?.voucher || (command.action === "sync_voucher" ? s.vouchers.find((v) => v.id === command.targetId) : null);
      if (voucher && approvalPolicy(s)) voucher.approvalRequired = true;
      if (approval?.pairing && voucher) command.device = { ...approval.pairing.target, voucherId: voucher.id, username: voucher.code,
        quotaBytes: voucher.quotaBytes, deviceLimit: voucher.deviceLimit, expiresAt: voucher.expiresAt, approvalRequired: approvalPolicy(s),
        ...(voucher.accessType === "personal_unlimited" ? { personalUnlimited: true } : {}),
        deadline: new Date(Math.min(Date.parse(approval.pairing.expiresAt), +now() + timeoutMs - 1000)).toISOString() };
      return { command: structuredClone(command), voucher: voucher && structuredClone(voucher), approvalError: approval?.error ? approval : null,
        scoped: requireScopedDisconnect || s.networkSetup?.runtimeRouterEnabled === true };
    });
    if (!claim) return { idle: true };
    if (claim.skipped) return { skipped: true };
    if (claim.deferred) return { deferred: true };
    return withCorrelation({ correlationId: claim.command.correlationId }, () => runCommand(claim));
  }
  async function runCommand({ command, voucher, scoped, approvalError }) {
    let error, callResult, timer, permanent = false;
    if (approvalError) {
      error = Object.assign(Error(approvalError.error), { code: approvalError.code }); permanent = true;
    } else if (command.action === "disconnect_device" && scoped) {
      error = new Error("Legacy device disconnection needs a fresh router session mapping. Refresh the device list and request a new disconnect.");
      permanent = true;
    } else if (command.action === "sync_voucher" && !voucher) {
      error = new Error("voucher_not_found");
      permanent = true;
    } else {
      try {
        callResult = await Promise.race([
          command.action === "sync_voucher" ? router.syncVoucher(voucher)
            : command.action === "sync_speed" ? (typeof router.syncSpeedQueue === "function"
              ? router.syncSpeedQueue({ voucherId: command.speed.voucherId, uploadBps: command.speed.uploadBps, downloadBps: command.speed.downloadBps, addresses: command.speed.addresses })
              : Promise.reject(Object.assign(Error("Update the router adapter before applying bundle speed limits."), { permanent: true })))
            : command.action === "revoke_wifi_device" ? (async () => {
              if (typeof router.revokeWifiDevice !== "function") throw Error("Update the router adapter before removing saved device access.");
              const value = await router.revokeWifiDevice(command.device);
              if (value?.confirmed !== true || value.outcome !== "revoked") throw Error("The router has not confirmed saved-device removal.");
              return value;
            })()
            : command.action === "connect_wifi_device" ? (async () => {
              if (typeof router.connectWifiDevice !== "function") throw Object.assign(Error("Update the management bridge before using assisted connection."), { permanent: true });
              const value = await router.connectWifiDevice(command.device), device = value?.device;
              if (!value?.confirmed || device?.mac !== command.device.mac || device?.address !== command.device.loginAddress ||
                  !device.sessionId || !Number.isFinite(Date.parse(device.startedAt))) throw Error("The router has not confirmed the connection yet.");
              return value;
            })()
            : command.action === "disconnect_voucher" ? router.disconnectVoucher(command.targetId)
            : command.action === "disconnect_wifi_device" ? (async () => {
              if (typeof router.disconnectWifiDevice !== "function") throw Error("Update the management bridge to support confirmed device disconnection.");
              const result = await router.disconnectWifiDevice(command.device);
              if (!result?.confirmed || !["disconnected", "absent", "superseded"].includes(result.outcome)) {
                throw Error("The router did not confirm the device disconnection. Update the management bridge.");
              }
              return result;
            })()
            : command.action === "disconnect_device" ? router.disconnectDevice(command.targetId)
            : command.action === "mark_inactive" ? router.markInactive()
            : router.readUsage(secondaryApprovalExpiry ? { secondaryApprovalExpiry: true } : undefined),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
        ]);
      } catch (e) { error = e; permanent = e.permanent === true || e.code === "UNSCOPED_DISCONNECT"; }
      finally { clearTimeout(timer); }
    }
    // The command's completion and any voucher status it carries commit
    // atomically. On storage failure the processing lease expires and the
    // command is safely eligible for retry.
    const completion = await store.transaction((s) => {
      s.routerCommands ??= [];
      const current = s.routerCommands.find((c) => c?.id === command.id);
      if (!current || current.leaseToken !== command.leaseToken) return { skipped: true };
      const target = ["sync_voucher", "disconnect_voucher"].includes(command.action)
        ? s.vouchers.find((v) => v.id === command.targetId) : null;
      if (error) {
        if (command.action === "sync_usage") pauseSecondaryObservations(s);
        if (command.action === "connect_wifi_device") {
          const p = (s.wifiPairingRequests || []).find((p) => p.id === command.targetId);
          const expired = !p || !(Date.parse(p.expiresAt) > +now()) || error.code === "PAIRING_EXPIRED";
          if (expired || permanent || current.attempts >= maxAttempts) {
            current.status = "processed"; current.result = expired ? "expired" : "failed";
            current.processedAt = timestamp(now); current.nextAttemptAt = null;
            current.lastError = String(error.message).slice(0, 240);
            delete current.leaseToken; delete current.leaseUntil;
            if (p) { p.status = current.result; p.updatedAt = timestamp(now); p.message = expired
              ? "Connection request expired. Check connected devices before requesting a new code."
              : "Connection could not be confirmed. Check device slots and request a new code, or contact support."; }
            enqueueRouterCommand(s, { action: "sync_usage" }, now);
            return { processed: true, failed: true };
          }
          fail(current, String(error.message).slice(0, 240));
          current.nextAttemptAt = new Date(Math.min(Date.parse(current.nextAttemptAt), Date.parse(p.expiresAt))).toISOString();
          p.message = "Router unavailable—retrying until this request expires. Connection is not confirmed.";
          p.updatedAt = timestamp(now);
          return { retried: true };
        }
        fail(current, String(error.message || error).slice(0, 240), permanent);
        recordOperationalFailure(s, current, now);
        if (command.action === "disconnect_device" && (scoped || error.code === "UNSCOPED_DISCONNECT")) current.recoveryAction = "refresh_devices";
        const deadLettered = current.status === "dead_letter";
        if (target) {
          target.routerSyncStatus = deadLettered ? "dead_letter" : "pending";
          target.routerError = current.lastError;
        }
        return { retried: !deadLettered, deadLettered, error: current.lastError, totalAttempts: current.totalAttempts };
      }
      if (command.grantGeneration) {
        const grant = (s.wifiDeviceGrants || []).find((g) => g.id === command.grantId && g.customerId === command.customerId);
        if (!grant || grant.status !== "revoked" || grant.revocationCommandId !== command.id ||
          approvalGeneration(grant) !== command.grantGeneration || routerRevision(s) !== command.routerRevision ||
          isRegisteredMainDevice(s, s.customers.find((c) => c.id === grant.customerId), grant.mac)) {
          current.status = "processed"; current.result = "superseded"; current.processedAt = timestamp(now); current.nextAttemptAt = null;
          delete current.leaseToken; delete current.leaseUntil;
          return { skipped: true };
        }
      }
      current.status = "processed";
      current.processedAt = timestamp(now);
      current.nextAttemptAt = null;
      delete current.lastError;
      delete current.leaseToken;
      delete current.leaseUntil;
      // Persist the exact-session outcome before projecting incident recovery.
      // A replaced session closes obsolete work; it does not confirm a disconnect.
      if (command.action === "disconnect_wifi_device") current.result = callResult.outcome;
      updateOperationalIncident(s, current, now);
      if (target) { target.routerSyncStatus = successStatus[command.action]; delete target.routerError; }
      if (command.action === "sync_speed") {
        const v = s.vouchers.find((v) => v.id === command.targetId);
        if (v) v.speedQueue = { key: command.speed.key, devices: command.speed.addresses.length, syncedAt: timestamp(now) };
      }
      if (command.action === "revoke_wifi_device") {
        const grant = (s.wifiDeviceGrants || []).find((g) => g.id === command.grantId);
        if (grant?.revocationCommandId === command.id) {
          grant.revocationConfirmedAt = timestamp(now);
          const expiry = grant.expiries?.find((e) => e.commandId === command.id);
          if (expiry) expiry.routerConfirmedAt = timestamp(now);
        }
        current.result = "revoked";
        for (const { voucherId } of command.device.targets) {
          const v = s.vouchers.find((v) => v.id === voucherId);
          if (v) { v.wifiDevices = (v.wifiDevices || []).filter((d) => d.mac !== command.device.mac); v.wifiDevicesChangedAt = timestamp(now); }
        }
        enqueueRouterCommand(s, { action: "sync_usage" }, now);
      }
      if (command.action === "connect_wifi_device") {
        const p = (s.wifiPairingRequests || []).find((p) => p.id === command.targetId);
        if (p) { p.status = "connected"; p.message = "Internet connection confirmed by the router."; p.updatedAt = timestamp(now); }
        const browser = p?.browserSessionId && s.dashboardSessions.find((a) => a.id === p.browserSessionId && a.customerId === p.customerId && Date.parse(a.expiresAt) > +now());
        if (browser) browser.currentWifi = { mac: p.mac, address: p.target.address, loginAddress: p.target.loginAddress,
          sessionId: browser.id, routerRevision: p.routerRevision, verifiedAt: timestamp(now) };
        current.result = "connected";
        const v = s.vouchers.find((v) => v.id === command.device.voucherId);
        if (v) {
          approveDevice(s, v.customerId, { ...callResult.device, voucherId: v.id }, now(), p?.kind || "main_approval");
          v.wifiDevices = [...(v.wifiDevices || []).filter((d) => d.mac !== command.device.mac), callResult.device];
          // A targeted confirmation does not refresh the other sessions. Only
          // a complete sync_usage reading advances wifiDevicesAt.
          v.wifiDevicesChangedAt = timestamp(now);
        }
        if (browser) rememberAppDevice(s, browser, now());
        enqueueRouterCommand(s, { action: "sync_usage" }, now);
      }
      if (command.action === "disconnect_wifi_device") {
        const v = s.vouchers.find((v) => v.id === command.device.voucherId);
        if (v && callResult.outcome !== "superseded") {
          const grant = (s.wifiDeviceGrants || []).find((g) => g.customerId === v.customerId && g.mac === command.device.mac);
          if (grant && command.device.retainApproval !== true) { grant.status = "revoked"; grant.revokedAt = timestamp(now); invalidateAppDevice(s, v.customerId, grant.mac, now()); }
          if (secondaryApprovalExpiry && command.device.retainApproval === true) confirmSecondaryDisconnect(s, v.customerId, command.device.mac, now());
          v.wifiDevices = (v.wifiDevices || []).filter((d) => !(d.mac === command.device.mac && d.sessionId === command.device.sessionId && d.startedAt === command.device.startedAt));
          v.wifiDevicesChangedAt = timestamp(now);
        }
        enqueueRouterCommand(s, { action: "sync_usage" }, now);
      }
      if (command.action === "sync_usage") {
        let updated = 0, exhausted = 0, refreshDevices = false;
        const observations = [];
        // Insights (#262): the devices this complete reading lists, once each.
        const online = new Set();
        let listed = Array.isArray(callResult) && callResult.length === 0;
        for (const reading of callResult || []) {
          const v = s.vouchers.find((v) => v.id === reading.voucherId);
          if (!v || v.accessMode === "home" || v.accessTransitionId) continue;
          const observation = { voucherId: v.id, observation: reading.observation };
          observations.push(observation);
          if (Array.isArray(reading.devices)) {
            listed = true;
            for (const d of reading.devices) if (MAC.test(d?.mac || "")) online.add(d.mac.toUpperCase());
          }
          // Router-reported devices are the trusted MAC mapping customers use to free a slot.
          // A separate worker/admin request can finish a disconnect while
          // this router read is in flight. Keep that confirmed device state
          // and request a new reading instead of restoring an ended session.
          const outdatedDevices = Date.parse(v.wifiDevicesChangedAt) > Date.parse(command.lastAttemptAt);
          if (Array.isArray(reading.devices) && outdatedDevices) refreshDevices = true;
          if (Array.isArray(reading.devices) && !outdatedDevices) {
            const previous = v.wifiDevices || [];
            v.wifiDevices = reading.devices.filter((d) => MAC.test(d?.mac || "")).slice(0, 100).map((d) => ({
              ...(deviceName(d.name) ? { name: deviceName(d.name) } : {}),
              mac: d.mac, address: typeof d.address === "string" ? d.address.slice(0, 45) : null,
              uptime: typeof d.uptime === "string" ? d.uptime.slice(0, 32) : null,
              usedBytes: Number.isFinite(Number(d.usedBytes)) ? Number(d.usedBytes) : 0,
              sessionId: typeof d.sessionId === "string" ? d.sessionId.slice(0, 80) : null,
              startedAt: (() => {
                if (!Number.isFinite(Date.parse(d.startedAt))) return null;
                const old = previous.find((item) => item.mac === d.mac && item.sessionId === d.sessionId && Math.abs(Date.parse(item.startedAt) - Date.parse(d.startedAt)) <= 5000);
                return old ? old.startedAt : d.startedAt;
              })(),
            }));
            v.wifiDevicesAt = timestamp(now);
            if (reading.devices.length <= 100 && reading.devices.every((d) => MAC.test(d?.mac || ""))) observation.devices = reading.devices;
          }
          // Keep the bundle's shared speed queue on the devices online now (#263).
          if (speedLimits) {
            const target = speedQueueTarget(v);
            if ((target.limited || v.speedQueue) && target.key !== v.speedQueue?.key) enqueueRouterCommand(s, { action: "sync_speed", targetId: v.id }, now);
          }
          // The router reports what it has counted since this voucher's counters last
          // started: the hotspot user's counters plus live sessions. RouterOS restarts
          // those counters from zero when the router reboots or the user is re-created.
          // Usage counted before that is kept in routerUsageOffset (and, for a Home
          // conversion, directUsageOffset). Without it, recorded usage froze until the
          // new counters passed it, and the router allowed the whole quota again.
          const counter = Number(reading.counterBytes), counted = Number.isSafeInteger(counter) && counter >= 0,
            previous = v.routerCounter, raw = Number(reading.usedBytes);
          let total = raw + (v.directUsageOffset || 0) + (v.routerUsageOffset || 0);
          const lower = Number.isSafeInteger(total) && total < v.usedBytes;
          // A session ending between the router's two reads is briefly missed, so one
          // lower reading is normal; counters that went down, or a total that stays
          // lower for 45 seconds or more, mean the counters restarted.
          const restarted = Number.isSafeInteger(raw) && raw >= 0 && (counted && Number.isSafeInteger(previous?.bytes) && counter < previous.bytes ||
            lower && Number.isFinite(Date.parse(previous?.lowerSince)) && +now() - Date.parse(previous.lowerSince) >= 45000);
          if (restarted) {
            v.routerUsageOffset = v.usedBytes - (v.directUsageOffset || 0);
            total = raw + v.usedBytes;
            v.routerCountersRestartedAt = timestamp(now);
            s.events.unshift({ id: randomUUID(), type: "network.usage_counters_restarted", at: timestamp(now), meta: { voucherId: v.id } });
            s.events = s.events.slice(0, 500);
            // Give the router the data actually left, not the whole quota again.
            if (v.status === "active" && v.quotaBytes !== null) {
              enqueueRouterCommand(s, { action: "sync_voucher", targetId: v.id }, now);
              v.routerSyncStatus = "pending";
            }
          }
          v.routerCounter = { ...(counted ? { bytes: counter } : {}), at: timestamp(now),
            ...(!restarted && lower ? { lowerSince: previous?.lowerSince || timestamp(now) } : {}) };
          if (!Number.isSafeInteger(total) || total < v.usedBytes) continue;
          v.usedBytes = total;
          v.lastUsageSyncAt = timestamp(now);
          updated++;
          recordUsageAlerts(v, now);
          if (enforceVoucherQuota(s, v, now)) exhausted++;
        }
        if (refreshDevices) enqueueRouterCommand(s, { action: "sync_usage" }, now);
        if (listed) recordDeviceSample(s, online.size, now());
        if (!secondaryApprovalExpiry) pauseSecondaryObservations(s);
        const expiredApprovals = secondaryApprovalExpiry ? observeSecondaryApprovals(s, observations, now(), { processStartedAt, readStartedAt: new Date(command.lastAttemptAt), expectedGrants: command.approvalObservationTargets }) : 0;
        return { processed: true, readings: (callResult || []).length, updated, exhausted, expiredApprovals };
      }
      return { processed: true };
    });
    const outcome = { commandId: command.id, action: command.action, attempts: command.attempts };
    if (completion.processed) {
      logger.info("network.command_completed", outcome);
      // Delivery time runs from the latest queuing; an operator replay was already counted as a dead letter.
      const queued = Math.max(...[command.at, command.queuedAt].map(Date.parse).filter(Number.isFinite));
      if (Number.isFinite(queued) && !(Date.parse(command.replayedAt) >= queued)) {
        metrics?.commandDelivered(command.action, (+now() - queued) / 1000);
      }
    }
    if (completion.deadLettered) metrics?.commandDeadLettered(command.action);
    if (error && !completion.skipped) {
      logger[completion.deadLettered ? "error" : "warn"]("network.command_failed",
        { ...outcome, state: completion.deadLettered ? "dead_letter" : "retry", ...errorFields(error) });
    }
    if (completion.deadLettered) {
      void sendDeadLetterAlert(alertWebhookUrl, { action: command.action, targetId: command.targetId,
        totalAttempts: completion.totalAttempts, lastError: completion.error });
    }
    return completion;
  }
  let running, wakePending = false;
  return {
    process,
    wake() {
      wakePending = true;
      queueMicrotask(() => { void this.run().catch((error) => logger.error("network.command_worker_failed", errorFields(error))); });
    },
    run() {
      if (running) return running;
      wakePending = false;
      running = (async () => {
        for (let i = 0; i < batchSize; i++) {
          if ((await process()).idle) break;
        }
      })().finally(() => {
        running = undefined;
        if (wakePending) this.wake();
      });
      return running;
    },
  };
}
