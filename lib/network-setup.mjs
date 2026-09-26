import { randomUUID, randomBytes } from "node:crypto";
import { seal, unseal, allowedEndpoint } from "./network-secrets.mjs";
import { RouterRest, routerPlan, routerTables } from "./network-router.mjs";

const active = new Set(["queued", "running", "awaiting_confirmation", "confirming", "rolling_back", "recovery_required"]);
const safeJob = ({ secret, ...job }) => job;
const safeConnection = ({ secret, ...connection }) => connection;
export class SimulatedRouter {
  constructor() {
    this.tables = Object.fromEntries(routerTables.map((p) => [p, []]));
    this.guards = new Set();
  }
  async discover() { return { model: "Simulated router", version: "7.20 (simulation)", identity: "Demo only", interfaces: [{ name: "ether1", running: true }, { name: "ether2", running: true }], guards: [...this.guards].map((id) => `ndahi-rollback-${id}`), tables: structuredClone(this.tables) }; }
  async backup(id) { return `simulation-${id}.backup`; }
  async arm(id, operations) { this.guards.add(id); this.before = structuredClone(this.tables); this.operations = operations; }
  async applyOperation(op) {
    const rows = this.tables[op.path], row = op.action === "update" && rows.find((v) => v[".id"] === op.id);
    if (row) Object.assign(row, op.values); else rows.push({ ".id": `*${randomUUID()}`, ...op.values });
  }
  async pending(id) { return this.guards.has(id); }
  async confirm(id) { this.guards.delete(id); }
  async rollback(id) { if (this.before) this.tables = this.before; this.guards.delete(id); }
}

export function createNetworkSetup({ store, env, now = () => new Date(), routerFactory, omadaFactory }) {
  const running = new Map(), simulated = new SimulatedRouter();
  const timestamp = () => now().toISOString();
  const record = (s, actor, action, meta = {}) => {
    s.auditLogs ??= [];
    s.auditLogs.unshift({ id: randomUUID(), action: `network.setup.${action}`, actor, at: timestamp(), meta });
    s.auditLogs = s.auditLogs.slice(0, 1000);
  };
  const settings = (s) => s.networkSetup ??= { connections: {} };
  const jobs = (s) => s.networkSetupJobs ??= [];
  const connectionFor = async (kind) => {
    const s = await store.snapshot(), c = s.networkSetup?.connections?.[kind];
    if (!c) throw Error("Save a connection before discovering devices.");
    return c;
  };
  const adapterFor = (c) => {
    if (c.mode === "simulation") {
      if (c.kind !== "router") throw Error("Omada simulation is unavailable.");
      return simulated;
    }
    const secret = unseal(c.secret, env);
    allowedEndpoint(secret.url, env);
    return c.kind === "router" ? (routerFactory?.(secret) || new RouterRest(secret)) : omadaFactory(secret);
  };
  const updateJob = (id, fn) => store.transaction((s) => { const j = jobs(s).find((v) => v.id === id); if (j) fn(j, s); });
  async function run(id) {
    let job, adapter;
    try {
      job = await store.transaction((s) => {
        const j = jobs(s).find((v) => v.id === id);
        if (!j || j.status !== "queued") return null;
        if (j.mode === "live" && env.NETWORK_PROVISIONING_ENABLED !== "true") { j.step = "Live provisioning is disabled. Enable it or cancel this queued job."; return null; }
        j.status = "running"; j.startedAt = timestamp(); j.step = "Checking current configuration";
        return structuredClone(j);
      });
      if (!job) return;
      const connection = await connectionFor(job.kind);
      if (connection.revision !== job.connectionRevision) throw Error("Connection changed. Create a new preview.");
      adapter = adapterFor(connection);
      const privateJob = unseal(job.secret, env);
      if (job.kind === "omada") {
        await adapter.apply(privateJob.plan, async (step) => updateJob(id, (j) => { j.step = step; }));
        await updateJob(id, (j, s) => { j.status = "completed"; j.step = "Controller change verified"; j.finishedAt = timestamp(); record(s, job.actor, "completed", { jobId: id }); });
        return;
      }
      const plan = routerPlan(privateJob.plan.config, await adapter.discover());
      if (plan.conflicts.length || plan.fingerprint !== privateJob.plan.fingerprint) throw Error("Router configuration changed after preview. Discover and review again.");
      if (!plan.operations.length) {
        await updateJob(id, (j) => { j.status = "completed"; j.step = "Configuration already matches"; }); return;
      }
      await updateJob(id, (j) => { j.step = "Saving encrypted backup on the router"; });
      const backup = await adapter.backup(id, privateJob.backupPassword);
      await updateJob(id, (j) => { j.backup = backup; j.step = "Arming automatic rollback"; j.guardAttempted = true; });
      await adapter.arm(id, plan.operations);
      await updateJob(id, (j) => { j.armedAt = timestamp(); j.confirmBefore = new Date(+now() + 8 * 60000).toISOString(); });
      for (let index = 0; index < plan.operations.length; index++) {
        await updateJob(id, (j) => { j.step = `Applying ${index + 1}/${plan.operations.length}: ${plan.operations[index].path}`; });
        await adapter.applyOperation(plan.operations[index]);
      }
      const verification = routerPlan(plan.config, await adapter.discover(), { ignoreGuard: id });
      if (verification.conflicts.length || verification.operations.length) throw Error("Router read-back did not match the reviewed configuration.");
      await updateJob(id, (j, s) => { j.status = "awaiting_confirmation"; j.step = "Test Wi-Fi and internet access, then keep changes before the deadline"; record(s, job.actor, "applied", { jobId: id }); });
    } catch {
      // Never persist provider errors: those can contain credentials or raw payloads.
      if (job) await updateJob(id, (j, s) => {
        j.status = j.guardAttempted || j.kind === "omada" ? "recovery_required" : "failed";
        j.step = j.guardAttempted ? "Apply interrupted. Automatic rollback remains armed; refresh status or request rollback." : "Apply failed. Check connectivity and create a fresh preview.";
        record(s, job.actor, "failed", { jobId: id, status: j.status });
      });
    }
  }
  function launch(id) {
    if (!running.has(id)) running.set(id, run(id).catch(() => {}).finally(() => running.delete(id)));
  }
  async function handle(action, input, actor) {
    if (action === "controller-status") {
      try {
        const c = await connectionFor("omada"), inventory = await adapterFor(c).discover();
        return { configured: true, mode: c.mode, connected: true, accessPoints: inventory.accessPoints };
      } catch { return { configured: false, connected: false, accessPoints: [], error: "Saved controller is unavailable. Review Network setup." }; }
    }
    if (action === "status") {
      const s = await store.snapshot();
      for (const j of s.networkSetupJobs || []) if (j.status === "queued") launch(j.id);
      // A process restart must not replay an uncertain physical mutation.
      await store.transaction((s) => {
        for (const j of jobs(s)) if (["running", "confirming", "rolling_back"].includes(j.status) && !running.has(j.id) && +now() - Date.parse(j.startedAt || j.at) > 600000) {
          j.status = "recovery_required"; j.step = "Interrupted job. Inspect the device and use recovery before starting another job.";
        }
      });
      const latest = await store.snapshot();
      return { runtimeRouterEnabled: latest.networkSetup?.runtimeRouterEnabled === true, enabled: env.NETWORK_PROVISIONING_ENABLED === "true", encryptionReady: /^[a-fA-F0-9]{64}$/.test(env.NETWORK_CONFIG_KEY || ""), allowedOrigins: String(env.NETWORK_ALLOWED_ORIGINS || "").split(",").filter(Boolean), connections: Object.values(latest.networkSetup?.connections || {}).map(safeConnection), jobs: (latest.networkSetupJobs || []).slice(-30).reverse().map(safeJob) };
    }
    if (action === "activate") {
      if (env.NETWORK_PROVISIONING_ENABLED !== "true" || input.tested !== true) throw Error("Enable live provisioning and verify the hotspot before activating voucher enforcement.");
      const c = await connectionFor("router");
      if (c.mode !== "live") throw Error("Simulation cannot enforce vouchers.");
      const discovery = await adapterFor(c).discover();
      if (!discovery.tables["ip/hotspot"].some((v) => v.name === "ndahi-hotspot" && v.disabled !== "true")) throw Error("The managed hotspot is not enabled.");
      await store.transaction((s) => {
        if (settings(s).connections.router.revision !== c.revision || jobs(s).some((j) => active.has(j.status))) throw Error("Resolve outstanding provisioning work before activation.");
        if (!jobs(s).some((j) => j.kind === "router" && j.mode === "live" && j.connectionRevision === c.revision && j.status === "completed")) throw Error("Complete and confirm router provisioning first.");
        settings(s).runtimeRouterEnabled = true;
        record(s, actor, "voucher_enforcement_activated", { revision: c.revision });
      });
      return { activated: true };
    }
    if (action === "connection") {
      const kind = input.kind;
      if (!["router", "omada"].includes(kind)) throw Error("Select a router or Omada connection.");
      const mode = input.mode === "simulation" ? "simulation" : "live";
      if (mode === "simulation" && (env.NODE_ENV === "production" || kind !== "router")) throw Error("Simulation is only available for routers outside production.");
      const url = mode === "live" ? allowedEndpoint(String(input.url || ""), env) : "simulation";
      const previous = (await store.snapshot()).networkSetup?.connections?.[kind];
      const old = previous?.secret && previous.url === url ? unseal(previous.secret, env) : {};
      const secret = { url };
      for (const field of kind === "router" ? ["username", "password"] : ["controllerId", "siteId", "clientId", "clientSecret", "wlanId"]) {
        secret[field] = String(input[field] || old[field] || "");
        if (mode === "live" && (!secret[field] || secret[field].length > 1024)) throw Error(`Enter ${field}.`);
      }
      const connection = { kind, mode, url, revision: randomUUID(), secret: seal(secret, env), updatedAt: timestamp() };
      const currentSettings = (await store.snapshot()).networkSetup;
      if (kind === "router" && currentSettings?.runtimeRouterEnabled) {
        if (previous?.url !== url || mode !== "live" || old.username !== secret.username) throw Error("Active router replacement requires a scheduled migration. Only its password can be rotated here.");
        await adapterFor(connection).discover();
      }
      await store.transaction((s) => {
        if (jobs(s).some((j) => active.has(j.status))) throw Error("Resolve the active provisioning job before changing connections.");
        if (settings(s).connections[kind]?.revision !== previous?.revision || (kind === "router" && settings(s).runtimeRouterEnabled && !currentSettings?.runtimeRouterEnabled)) throw Error("Connection changed during this request. Reload and try again.");
        settings(s).connections[kind] = connection;
        for (const j of jobs(s)) if (j.status === "preview") j.status = "superseded";
        record(s, actor, "connection_saved", { kind, mode });
      });
      return { connection: safeConnection(connection) };
    }
    if (action === "discover") {
      const c = await connectionFor(input.kind), adapter = adapterFor(c);
      let discovery;
      try { discovery = await adapter.discover(); } catch { throw Error("Discovery failed. Check the management tunnel, certificate, credentials, and supported API version."); }
      // Router table reads can contain scripts or authentication fields. Only
      // expose the explicit inventory needed by the setup form.
      const safe = input.kind === "router" ? { model: discovery.model, version: discovery.version, identity: discovery.identity, interfaces: discovery.interfaces } : discovery;
      return { mode: c.mode, discovery: safe };
    }
    if (action === "preview") {
      const c = await connectionFor(input.kind), adapter = adapterFor(c);
      const plan = c.kind === "router" ? routerPlan(input.config, await adapter.discover()) : await adapter.preview(input.config);
      const publicPlan = c.kind === "router" ? plan : { ...plan, config: { ...plan.config, password: undefined }, before: undefined, payload: undefined };
      const job = { id: randomUUID(), kind: c.kind, mode: c.mode, actor, at: timestamp(), expiresAt: new Date(+now() + 15 * 60000).toISOString(), status: "preview", connectionRevision: c.revision, plan: publicPlan,
        secret: seal({ plan, backupPassword: randomBytes(24).toString("base64url") }, env) };
      await store.transaction((s) => {
        if (settings(s).connections[c.kind]?.revision !== c.revision) throw Error("Connection changed; preview again.");
        if (jobs(s).some((j) => active.has(j.status))) throw Error("Resolve the active job before creating another preview.");
        for (const old of jobs(s)) if (old.status === "preview") old.status = "superseded";
        jobs(s).push(job); record(s, actor, "previewed", { jobId: job.id });
      });
      return { job: safeJob(job) };
    }
    if (action === "apply") {
      const job = await store.transaction((s) => {
        const j = jobs(s).find((v) => v.id === input.jobId);
        if (!j) throw Error("Preview not found.");
        if (j.status !== "preview") return structuredClone(j); // duplicate submission never executes twice
        if (j.actor !== actor) throw Error("Create your own preview before applying changes.");
        if (j.mode === "live" && env.NETWORK_PROVISIONING_ENABLED !== "true") throw Error("Live provisioning is disabled on the server. Complete lab validation before enabling it.");
        if (Date.parse(j.expiresAt) <= +now() || j.plan.conflicts.length || input.reviewed !== true) throw Error("Review a fresh conflict-free preview before applying.");
        if (jobs(s).some((v) => v.id !== j.id && active.has(v.status))) throw Error("Another provisioning job is active.");
        j.status = "queued"; record(s, actor, "queued", { jobId: j.id }); return structuredClone(j);
      });
      launch(job.id); return { job: safeJob(job) };
    }
    if (action === "cancel") {
      await store.transaction((s) => {
        const j = jobs(s).find((v) => v.id === input.jobId);
        if (!j || !["preview", "queued"].includes(j.status)) throw Error("Only previews and queued jobs can be cancelled.");
        j.status = "cancelled"; j.step = "Cancelled before device changes"; j.finishedAt = timestamp();
        record(s, actor, "cancelled", { jobId: j.id });
      });
      return { job: safeJob((await store.snapshot()).networkSetupJobs.find((j) => j.id === input.jobId)) };
    }
    if (action === "resolve") {
      if (input.recovered !== true) throw Error("Verify recovery on the equipment before resolving this job.");
      await store.transaction((s) => {
        const j = jobs(s).find((v) => v.id === input.jobId);
        if (!j || j.status !== "recovery_required" || running.has(j.id)) throw Error("Only interrupted jobs can be resolved manually.");
        j.status = "recovered_manually"; j.finishedAt = timestamp(); j.step = "Owner verified recovery on the equipment";
        record(s, actor, "manual_recovery", { jobId: j.id });
      });
      return { job: safeJob((await store.snapshot()).networkSetupJobs.find((j) => j.id === input.jobId)) };
    }
    if (["confirm", "rollback", "refresh", "recovery"].includes(action)) {
      const s = await store.snapshot(), job = s.networkSetupJobs?.find((v) => v.id === input.jobId);
      if (!job) throw Error("Job not found.");
      if (action === "recovery") {
        await store.transaction((s) => record(s, actor, "recovery_viewed", { jobId: job.id }));
        return { backup: job.backup, password: unseal(job.secret, env).backupPassword, instructions: "Download the named encrypted backup from RouterOS Files. Restore locally using WinBox if management access is lost. Restore reboots the router. Keep this password with the backup." };
      }
      const c = await connectionFor(job.kind), adapter = adapterFor(c);
      if (c.revision !== job.connectionRevision) throw Error("Job connection changed; use local recovery.");
      if (action === "refresh") {
        if (job.kind === "router" && job.guardAttempted && !["completed", "rolled_back"].includes(job.status)) {
          const pending = await adapter.pending(job.id);
          if (!pending) await updateJob(job.id, (j) => { j.status = "recovery_required"; j.step = "Watchdog is no longer armed. Verify the router locally, then run rollback to reconcile this job."; });
        }
        return { job: safeJob((await store.snapshot()).networkSetupJobs.find((j) => j.id === job.id)) };
      }
      if (running.has(job.id)) throw Error("Job is still running. Wait for it to finish.");
      const lease = await store.transaction((s) => {
        const j = jobs(s).find((v) => v.id === job.id);
        if (action === "confirm" && (j.status !== "awaiting_confirmation" || Date.parse(j.confirmBefore) <= +now() || input.tested !== true)) throw Error("Confirmation window expired or testing is incomplete. Roll back and review again.");
        if (action === "rollback" && !["awaiting_confirmation", "recovery_required"].includes(j.status)) throw Error("This job is not eligible for rollback.");
        j.status = action === "confirm" ? "confirming" : "rolling_back"; return true;
      });
      if (lease) {
        const task = (async () => {
          try {
            if (action === "confirm") {
              if (!await adapter.pending(job.id)) throw Error("Rollback already ran.");
              const plan = routerPlan(unseal(job.secret, env).plan.config, await adapter.discover(), { ignoreGuard: job.id });
              if (plan.conflicts.length || plan.operations.length) throw Error("Configuration drift detected.");
              await adapter.confirm(job.id);
            } else if (job.kind === "router") await adapter.rollback(job.id);
            else await adapter.rollback(unseal(job.secret, env).plan);
            await updateJob(job.id, (j, s) => { j.status = action === "confirm" ? "completed" : "rolled_back"; j.finishedAt = timestamp(); j.step = action === "confirm" ? "Changes kept" : "Rollback completed"; record(s, actor, action, { jobId: j.id }); });
          } catch {
            await updateJob(job.id, (j) => { j.status = "recovery_required"; j.step = "Recovery could not be verified. Inspect the device locally before retrying."; });
          }
        })();
        running.set(job.id, task);
        try { await task; } finally { running.delete(job.id); }
      }
      return { job: safeJob((await store.snapshot()).networkSetupJobs.find((j) => j.id === job.id)) };
    }
    throw Error("Unknown network setup action.");
  }
  return { handle, idle: () => Promise.all([...running.values()]) };
}
