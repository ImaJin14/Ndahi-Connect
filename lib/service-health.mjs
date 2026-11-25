// Connections (AdminConnections, #380; owner decisions 25 Nov): what each
// service card shows, checked every minute and again on "Test connection".
//
// - uplink (Starlink): the router's ping to the internet and the traffic now on
//   its uplink port. No speed test: one a minute would use Starlink data.
// - router (MikroTik): whether RouterOS answers, and its hotspot sessions.
// - omada: standalone access points have no controller to check.
// - mtn, orange (Mobile Money): how long recent payments took to confirm.
// - email: recent delivery results (receipt emails, and every send since start).
//
// Router, uplink and Omada readings are kept in memory and refreshed every
// minute. Mobile Money and email are worked out from the payments the
// dashboard already loads, so they add no database reads. Nothing is written
// to the database except one uplink row an hour for Insights.
// Router reads are GETs, plus RouterOS's own ping and monitor-traffic
// commands; nothing is changed on the router. Checked by the owner on-site.
import { RouterRest } from "./network-router.mjs";
import { unseal, allowedEndpoint } from "./network-secrets.mjs";

export const SERVICES = ["uplink", "router", "omada", "mtn", "orange", "email"];
const MINUTE = 60000, DAY = 864e5;
// Thresholds: a ping slower than 150 ms or losing packets is "Slow"; a median
// Mobile Money confirmation over a minute is "Slow"; three failures in a row
// are "Down".
const SLOW_PING_MS = 150, SLOW_CONFIRM_S = 60, FAILURES_DOWN = 3;

// "23ms456us" or "1s200ms" → milliseconds.
export function routerDuration(value) {
  const text = String(value || "");
  let ms = 0, found = false;
  for (const [, n, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|us|s)/g)) {
    found = true;
    ms += unit === "s" ? n * 1000 : unit === "ms" ? Number(n) : n / 1000;
  }
  return found ? ms : null;
}

// RouterOS's ping summary, then the uplink port and its traffic now.
export async function readUplink(rest) {
  const replies = await rest.request("ping", "POST", { address: "1.1.1.1", count: "3" }, { timeoutMs: 8000 });
  const last = Array.isArray(replies) ? replies.at(-1) || {} : {};
  const loss = Number.parseInt(last["packet-loss"], 10);
  const avg = routerDuration(last["avg-rtt"]);
  const routes = await rest.request("ip/route?dst-address=0.0.0.0/0&active=true", "GET", undefined, { timeoutMs: 5000 });
  const gw = (Array.isArray(routes) ? routes : []).map((r) => String(r["immediate-gw"] || "")).find((g) => g.includes("%")) || "";
  const port = gw.split("%")[1] || null;
  let mbps = null;
  if (port && /^[A-Za-z0-9_.-]{1,40}$/.test(port)) {
    const traffic = await rest.request("interface/monitor-traffic", "POST", { interface: port, once: "" }, { timeoutMs: 5000 });
    const rx = Number((Array.isArray(traffic) ? traffic[0] : traffic)?.["rx-bits-per-second"]);
    if (Number.isFinite(rx)) mbps = Math.round(rx / 1e5) / 10;
  }
  return { lossPercent: Number.isFinite(loss) ? loss : null, pingMs: avg === null ? null : Math.round(avg), port, mbps };
}

export function uplinkResult(reading) {
  if (reading.lossPercent === 100 || reading.pingMs === null) return { state: "down", detail: { key: "adminHealthUplinkDown" } };
  const slow = reading.pingMs >= SLOW_PING_MS || (reading.lossPercent || 0) > 0;
  return { state: slow ? "slow" : "ok", detail: reading.mbps === null ? { key: "adminHealthUplinkPing", values: { ms: reading.pingMs } }
    : { key: "adminHealthUplink", values: { ms: reading.pingMs, mbps: reading.mbps } } };
}

// Mobile Money, per network, from the latest finished payments of the last day.
export function paymentResult(state, network, now) {
  const since = +now - DAY;
  const recent = (state.payments || [])
    .filter((p) => p.network === network && Date.parse(p.createdAt) >= since)
    .filter((p) => p.confirmedAt || ["failed", "expired", "cancelled"].includes(p.status))
    .sort((a, b) => Date.parse(b.confirmedAt || b.updatedAt || b.createdAt) - Date.parse(a.confirmedAt || a.updatedAt || a.createdAt))
    .slice(0, 10);
  if (!recent.length) return { state: "nodata", detail: { key: "adminHealthNoPayments" } };
  // Refusals (a low balance, a wrong PIN) are the provider working.
  const failedByProvider = (p) => !p.confirmedAt && !p.refusal && p.failureReason !== "insufficient_balance" && p.failureReason !== "declined";
  if (recent.length >= FAILURES_DOWN && recent.slice(0, FAILURES_DOWN).every(failedByProvider)) return { state: "down", detail: { key: "adminHealthPaymentsDown", values: { count: FAILURES_DOWN } } };
  const seconds = recent.filter((p) => p.confirmedAt).map((p) => (Date.parse(p.confirmedAt) - Date.parse(p.createdAt)) / 1000).filter((n) => n >= 0).sort((a, b) => a - b);
  if (!seconds.length) return { state: "nodata", detail: { key: "adminHealthNoPayments" } };
  const median = seconds[Math.floor((seconds.length - 1) / 2)];
  return median > SLOW_CONFIRM_S ? { state: "slow", detail: { key: "adminHealthPaymentsSlow", values: { seconds: Math.round(median / 10) * 10 } } }
    : { state: "ok", detail: { key: "adminHealthPaymentsOk" } };
}

// Email, from receipt emails of the last day and every send since the API started.
export function emailResult(state, seen, now) {
  const since = +now - DAY, outcomes = [];
  for (const p of state.payments || []) {
    const row = p.receiptEmail;
    if (!row) continue;
    if (row.status === "sent" && Date.parse(row.sentAt) >= since) outcomes.push({ ok: true, at: Date.parse(row.sentAt) });
    else if (row.status === "failed" && Date.parse(row.lastAttemptAt || row.updatedAt || p.updatedAt) >= since) outcomes.push({ ok: false, at: Date.parse(row.lastAttemptAt || row.updatedAt || p.updatedAt) });
  }
  for (const o of seen) if (o.at >= since) outcomes.push(o);
  outcomes.sort((a, b) => b.at - a.at);
  if (!outcomes.length) return { state: "nodata", detail: { key: "adminHealthNoEmail" } };
  if (outcomes.length >= FAILURES_DOWN && outcomes.slice(0, FAILURES_DOWN).every((o) => !o.ok)) return { state: "down", detail: { key: "adminHealthEmailDown", values: { count: FAILURES_DOWN } } };
  if (outcomes.slice(0, 10).some((o) => !o.ok)) return { state: "slow", detail: { key: "adminHealthEmailRetrying" } };
  return { state: "ok", detail: { key: "adminHealthEmailOk" } };
}

export function createServiceHealth({ store, env = {}, omada, now = () => new Date(), fetcher, logger, recordUplink = async () => {} }) {
  fetcher ||= fetch;
  const results = new Map(), seenEmail = [];
  let running, uplinkHour = null, uplinkPeak = null;
  const set = (id, result, at, tested = false) => results.set(id, { id, ...result, checkedAt: at.toISOString(), ...(tested ? { tested: true } : {}) });

  // The saved live router connection (Network setup), read with its settings only.
  async function routerConnection() {
    const s = await store.snapshot({ only: [], settings: ["networkSetup"] });
    const connection = s.networkSetup?.connections?.router;
    if (!connection || connection.mode !== "live") return null;
    const secret = unseal(connection.secret, env);
    allowedEndpoint(secret.url, env);
    return secret;
  }
  // One router check at a time: a Test while the minute's check runs waits for it.
  let routerRunning;
  function checkRouter(tested) {
    routerRunning ??= readRouter(tested).finally(() => { routerRunning = undefined; });
    return routerRunning;
  }
  async function readRouter(tested) {
    const at = now(), mode = env.MIKROTIK_MODE || "mock";
    let connection = null;
    try { connection = await routerConnection(); } catch (error) { logger?.warn?.("health.router_connection_unavailable", { message: error.message }); }
    if (!connection) {
      const state = mode === "mock" ? "test" : "off";
      set("router", { state, detail: { key: state === "test" ? "adminServiceRouterTest" : "adminServiceRouterOff" } }, at, tested);
      set("uplink", { state, detail: { key: state === "test" ? "adminServiceTestDetail" : "adminHealthUplinkNoRouter" } }, at, tested);
      return;
    }
    const rest = new RouterRest(connection, fetcher);
    let sessions = null, version = null;
    try {
      const resource = await rest.request("system/resource", "GET", undefined, { timeoutMs: 5000 });
      version = String(resource?.version || "").split(" ")[0] || null;
    } catch {
      set("router", { state: "down", detail: { key: "adminHealthRouterDown" } }, at, tested);
      set("uplink", { state: "unknown", detail: { key: "adminHealthUplinkNoRouter" } }, at, tested);
      return;
    }
    try { const active = await rest.request("ip/hotspot/active", "GET", undefined, { timeoutMs: 5000 }); sessions = Array.isArray(active) ? active.length : null; } catch { sessions = null; }
    set("router", { state: "ok", detail: sessions === null ? { key: "adminHealthRouterNoHotspot", values: { version: version || "RouterOS" } } : { key: "adminHealthRouter", values: { count: sessions } } }, at, tested);
    try {
      const reading = await readUplink(rest);
      set("uplink", uplinkResult(reading), at, tested);
      await noteUplink(reading, at);
    } catch {
      set("uplink", { state: "unknown", detail: { key: "adminHealthUplinkUnread" } }, at, tested);
    }
  }
  // One row an hour for Insights (#382): the busiest uplink reading in the hour.
  async function noteUplink(reading, at) {
    if (reading.mbps === null) return;
    const hour = new Date(Math.floor(+at / 36e5) * 36e5).toISOString();
    if (uplinkHour && uplinkHour !== hour && uplinkPeak) await recordUplink({ hour: uplinkHour, ...uplinkPeak }).catch(() => {});
    if (uplinkHour !== hour) { uplinkHour = hour; uplinkPeak = null; }
    if (!uplinkPeak || reading.mbps > uplinkPeak.peakMbps) uplinkPeak = { peakMbps: reading.mbps, pingMs: reading.pingMs };
  }
  async function checkOmada(tested) {
    const at = now(), mode = env.OMADA_MODE || "not-configured";
    if (mode === "standalone") return set("omada", { state: "standalone", detail: { key: "adminHealthOmadaStandalone" }, testable: false }, at);
    if (mode === "mock") return set("omada", { state: "test", detail: { key: "adminServiceTestDetail" } }, at, tested);
    if (mode !== "live" || !omada) return set("omada", { state: "off", detail: { key: "adminServiceOmadaOff" } }, at, tested);
    try {
      const status = await omada.status(), aps = (status.accessPoints || []).filter((ap) => ap.status === undefined || ap.status === 1 || /connected|online/i.test(String(ap.status)));
      set("omada", { state: "ok", detail: { key: "adminHealthOmada", values: { count: aps.length } } }, at, tested);
    } catch { set("omada", { state: "down", detail: { key: "adminHealthOmadaDown" } }, at, tested); }
  }
  // Mobile Money and email, from payments the caller already has.
  function dataResult(s, id, at) {
    const payMode = env.PAYMENT_MODE || "mock", mailMode = env.EMAIL_MODE || "not-configured";
    if (id === "email") return mailMode === "mock" ? { state: "test", detail: { key: "adminServiceTestDetail" } }
      : mailMode === "not-configured" ? { state: "off", detail: { key: "adminServiceEmailOff" } } : emailResult(s, seenEmail, at);
    return payMode === "mock" ? { state: "test", detail: { key: "adminServiceTestDetail" } } : paymentResult(s, id, at);
  }
  async function runAll() {
    await Promise.allSettled([checkRouter(false), checkOmada(false)]);
  }
  return {
    // Every minute (server.mjs), one run at a time.
    run() { running ??= runAll().catch((error) => logger?.error?.("health.run_failed", { message: error.message })).finally(() => { running = undefined; }); return running; },
    // "Test connection": the one service again, now.
    async test(id) {
      if (!SERVICES.includes(id)) throw new RangeError("Choose a service to test.");
      if (id === "router" || id === "uplink") await checkRouter(true);
      else if (id === "omada") await checkOmada(true);
      else { const at = now(); return { id, ...dataResult(await store.snapshot({ only: ["payments"] }), id, at), checkedAt: at.toISOString(), tested: true }; }
      return results.get(id);
    },
    // The cards, in the drawn order, for the dashboard's state `s`; a service
    // not checked yet says so.
    view(s) {
      const at = now();
      return SERVICES.map((id) => ["mtn", "orange", "email"].includes(id) ? { id, ...dataResult(s, id, at), checkedAt: at.toISOString() }
        : results.get(id) || { id, state: "pending", detail: { key: "adminHealthPending" }, checkedAt: null });
    },
    // Wraps the email adapter so every send's outcome counts (kept for a day, at most 200).
    watchEmail(adapter) {
      if (!adapter) return adapter;
      return new Proxy(adapter, { get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function" || !/^send/.test(String(property))) return typeof value === "function" ? value.bind(target) : value;
        return async (...args) => {
          try { const out = await value.apply(target, args); seenEmail.unshift({ ok: true, at: +now() }); return out; }
          catch (error) { seenEmail.unshift({ ok: false, at: +now() }); throw error; }
          finally { seenEmail.splice(200); }
        };
      } });
    },
  };
}
