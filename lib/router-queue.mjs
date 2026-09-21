import { randomUUID } from "node:crypto";

const ACTIONS = new Set([
  "sync_voucher",
  "disconnect_voucher",
  "disconnect_device",
  "mark_inactive",
  "sync_usage",
]);
const successStatus = {
  sync_voucher: "synchronized",
  disconnect_voucher: "disconnected",
};
const isJob = (command) => command?.kind === "router_command";
const timestamp = (now) => now().toISOString();
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
    existing.nextAttemptAt = timestamp(now);
    delete existing.leaseToken;
    delete existing.leaseUntil;
    delete existing.lastError;
    return existing;
  }
  const command = {
    id, kind: "router_command", action, targetId, status: "queued",
    attempts: 0, totalAttempts: 0, at: timestamp(now), nextAttemptAt: timestamp(now),
  };
  s.routerCommands.push(command);
  return command;
}

// Operator action: an owner/operator can requeue a stuck or dead-lettered
// command after resolving the underlying router/network problem.
export function scheduleRouterCommandReplay(s, id, now = () => new Date()) {
  const command = (s.routerCommands || []).find((c) => isJob(c) && c.id === id);
  if (!command) return result(404, { error: "Network command not found." });
  if (!["retry", "dead_letter"].includes(command.status)) {
    return result(409, { error: "Only failed network commands can be replayed." });
  }
  command.status = "queued";
  command.attempts = 0;
  command.replays = (command.replays || 0) + 1;
  command.replayedAt = timestamp(now);
  command.nextAttemptAt = timestamp(now);
  delete command.leaseToken;
  delete command.leaseUntil;
  delete command.deadLetteredAt;
  return result(202, { accepted: true, commandId: command.id });
}

export function routerQueueSummary(s) {
  const commands = (s.routerCommands || []).filter(isJob);
  return {
    pending: commands.filter((c) => ["queued", "retry", "processing"].includes(c.status)).length,
    deadLetters: commands.filter((c) => c.status === "dead_letter").length,
    commands: commands.filter((c) => c.status !== "processed").map((c) => ({
      id: c.id, action: c.action, targetId: c.targetId, status: c.status,
      attempts: c.attempts, totalAttempts: c.totalAttempts, lastError: c.lastError,
      nextAttemptAt: c.nextAttemptAt, at: c.at,
    })),
  };
}

export function createRouterCommandProcessor({ store, router, now = () => new Date(),
  timeoutMs = 15000, batchSize = 25, maxAttempts = 8, alertWebhookUrl }) {
  const fail = (command, reason, permanent = false) => {
    command.lastError = reason;
    command.status = permanent || command.attempts >= maxAttempts ? "dead_letter" : "retry";
    command.nextAttemptAt = command.status === "retry"
      ? new Date(+now() + Math.min(3600000, 30000 * 2 ** (command.attempts - 1))).toISOString() : null;
    if (command.status === "dead_letter") command.deadLetteredAt = timestamp(now);
    delete command.leaseToken;
    delete command.leaseUntil;
  };
  async function process(id) {
    const claim = await store.transaction((s) => {
      s.routerCommands ??= [];
      const command = s.routerCommands.find((c) => isJob(c) && (!id || c.id === id) &&
        (["queued", "retry"].includes(c.status) && Date.parse(c.nextAttemptAt) <= +now() ||
          c.status === "processing" && Date.parse(c.leaseUntil) <= +now()));
      if (!command) return null;
      command.status = "processing";
      command.attempts++;
      command.totalAttempts++;
      command.lastAttemptAt = timestamp(now);
      command.leaseToken = randomUUID();
      command.leaseUntil = new Date(+now() + timeoutMs + 15000).toISOString();
      const voucher = command.action === "sync_voucher"
        ? s.vouchers.find((v) => v.id === command.targetId) : null;
      return { command: structuredClone(command), voucher: voucher && structuredClone(voucher) };
    });
    if (!claim) return { idle: true };
    const { command, voucher } = claim;
    let error, callResult, timer, permanent = false;
    if (command.action === "sync_voucher" && !voucher) {
      error = new Error("voucher_not_found");
      permanent = true;
    } else {
      try {
        callResult = await Promise.race([
          command.action === "sync_voucher" ? router.syncVoucher(voucher)
            : command.action === "disconnect_voucher" ? router.disconnectVoucher(command.targetId)
            : command.action === "disconnect_device" ? router.disconnectDevice(command.targetId)
            : command.action === "mark_inactive" ? router.markInactive()
            : router.readUsage(),
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timeoutMs); }),
        ]);
      } catch (e) { error = e; }
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
        fail(current, String(error.message || error).slice(0, 240), permanent);
        const deadLettered = current.status === "dead_letter";
        if (target) {
          target.routerSyncStatus = deadLettered ? "dead_letter" : "pending";
          target.routerError = current.lastError;
        }
        return { retried: !deadLettered, deadLettered, error: current.lastError, totalAttempts: current.totalAttempts };
      }
      current.status = "processed";
      current.processedAt = timestamp(now);
      current.nextAttemptAt = null;
      delete current.lastError;
      delete current.leaseToken;
      delete current.leaseUntil;
      if (target) { target.routerSyncStatus = successStatus[command.action]; delete target.routerError; }
      if (command.action === "sync_usage") {
        let updated = 0;
        for (const reading of callResult || []) {
          const v = s.vouchers.find((v) => v.id === reading.voucherId);
          if (!v || !Number.isFinite(Number(reading.usedBytes)) || Number(reading.usedBytes) < v.usedBytes) continue;
          v.usedBytes = Number(reading.usedBytes);
          v.lastUsageSyncAt = timestamp(now);
          updated++;
        }
        return { processed: true, readings: (callResult || []).length, updated };
      }
      return { processed: true };
    });
    if (completion.deadLettered) {
      void sendDeadLetterAlert(alertWebhookUrl, { action: command.action, targetId: command.targetId,
        totalAttempts: completion.totalAttempts, lastError: completion.error });
    }
    return completion;
  }
  let running;
  return {
    process,
    run() {
      if (running) return running;
      running = (async () => {
        for (let i = 0; i < batchSize; i++) {
          if ((await process()).idle) break;
        }
      })().finally(() => { running = undefined; });
      return running;
    },
  };
}
