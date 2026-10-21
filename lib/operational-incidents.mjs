import { randomUUID } from "node:crypto";
import { routerRevision } from "./device-identities.mjs";

const actions = new Set(["sync_usage", "sync_voucher", "disconnect_voucher", "disconnect_device", "disconnect_wifi_device", "revoke_wifi_device", "mark_inactive"]);
const failed = (c) => ["retry", "dead_letter"].includes(c.status);
function problem(reason) {
  return /timeout|timed out/i.test(reason) ? "timeout" : /connect|unavailable|unreachable|fetch failed/i.test(reason) ? "unavailable" :
    /credential|unauthori|authentication|permission/i.test(reason) ? "authorization" : /mapping|scoped|legacy|session/i.test(reason) ? "mapping" : "operation";
}
function transition(s, incident, status, actionRequired, now) {
  if (incident.status === status && incident.actionRequired === actionRequired) return;
  incident.status = status; incident.actionRequired = actionRequired; incident.updatedAt = now().toISOString();
  if (status === "resolved") incident.resolvedAt = now().toISOString();
  s.auditLogs.unshift({ id: randomUUID(), action: "network.incident." + status, actor: "system", at: now().toISOString(),
    meta: { incidentId: incident.id, action: incident.action, problem: incident.problem, actionRequired } });
}
export function updateOperationalIncident(s, command, now = () => new Date()) {
  const ids = command.operationalIncidentIds || [command.operationalIncidentId];
  for (const incident of (s.operationalIncidents || []).filter((n) => ids.includes(n.id) && n.status !== "resolved")) {
    const members = s.routerCommands.filter((c) => (c.operationalIncidentIds || [c.operationalIncidentId]).includes(incident.id));
    const outstanding = members.filter(failed), pending = members.some((c) => ["queued", "processing"].includes(c.status));
    const unresolvedResult = members.some((c) => !["processed", "resolved", "queued", "processing", "retry", "dead_letter"].includes(c.status) || ["failed", "expired"].includes(c.result));
    const status = outstanding.length || unresolvedResult || !members.length ? "open" : pending ? "recovering" : "resolved";
    if (status === "resolved") {
      incident.resolution = members.some((c) => c.resolution === "obsolete_legacy_disconnect" || c.result === "superseded") ? "obsolete" : "confirmed";
      incident.completedCommands = members.map((c) => ({ id: c.id, action: c.action, status: c.status, totalAttempts: c.totalAttempts, resolution: c.resolution }));
    }
    transition(s, incident, status, members.some((c) => c.status === "dead_letter") || unresolvedResult || status === "open" && incident.actionRequired === true, now);
  }
}
export function recordOperationalFailure(s, command, now = () => new Date()) {
  if (!actions.has(command.action)) return;
  s.operationalIncidents ??= [];
  const revision = routerRevision(s) || "configured-router", issue = problem(command.lastError || ""), key = JSON.stringify([revision, command.action, issue]);
  let incident = s.operationalIncidents.find((n) => n.key === key && n.status !== "resolved");
  if (!incident) {
    incident = { id: randomUUID(), key, action: command.action, problem: issue, routerRevision: revision, count: 0, failures: {}, customerIds: [],
      firstAt: command.lastAttemptAt || command.at || now().toISOString(), lastAt: command.lastAttemptAt || now().toISOString() };
    s.operationalIncidents.push(incident);
  }
  const occurrence = JSON.stringify([command.totalAttempts || 0, command.lastAttemptAt || command.at]);
  if (incident.failures[command.id] !== occurrence) {
    incident.failures[command.id] = occurrence; incident.count++;
    const at = command.lastAttemptAt || now().toISOString();
    if (Date.parse(at) < Date.parse(incident.firstAt)) incident.firstAt = at;
    if (Date.parse(at) > Date.parse(incident.lastAt)) incident.lastAt = at;
  }
  command.operationalIncidentId = incident.id;
  command.operationalIncidentIds = [...new Set([...(command.operationalIncidentIds || []).filter((id) => s.operationalIncidents.some((n) => n.id === id && n.status !== "resolved")), incident.id])];
  if (command.action === "sync_usage" && command.targetId === "global") incident.global = true;
  const voucherIds = [command.targetId, command.device?.voucherId, ...(command.device?.targets || []).map((t) => t.voucherId)];
  incident.customerIds = [...new Set([...incident.customerIds, ...s.vouchers.filter((v) => voucherIds.includes(v.id)).map((v) => v.customerId).filter(Boolean)])];
  updateOperationalIncident(s, command, now);
  // Keep all unresolved work and the latest 200 resolved incident summaries.
  const retained = new Set(s.operationalIncidents.filter((n) => n.status === "resolved").sort((a, b) => Date.parse(b.resolvedAt) - Date.parse(a.resolvedAt)).slice(0, 200).map((n) => n.id));
  s.operationalIncidents = s.operationalIncidents.filter((n) => n.status !== "resolved" || retained.has(n.id));
}
export function incidentNotice(incident, admin) {
  const status = incident.status, closed = status === "resolved", obsolete = incident.resolution === "obsolete";
  return {
    id: (admin ? "incident:" : "service-incident:") + incident.id, category: admin ? "network" : "service",
    title: admin ? closed ? obsolete ? "Router work closed" : "Router work recovered" : status === "recovering" ? "Router recovery in progress" : "Router work needs attention" : closed ? obsolete ? "Network work closed" : "Network update completed" : "Network update delayed",
    body: admin ? `${incident.count} recorded failure(s) for ${incident.action.replaceAll("_", " ")} (${incident.problem}). Review this incident's commands and audit trail.` :
      closed ? obsolete ? "An outdated network operation was closed. Check your current connection status." : "The router confirmed the pending work. Check your current connection status." :
        incident.action === "sync_usage" ? "Connection and data readings may be out of date. Existing Wi-Fi access may still work. Check status again or contact support." : "A network update affecting your account is delayed. Check connection status or contact support.",
    updatedAt: incident.updatedAt || incident.firstAt, actionRequired: admin && incident.actionRequired === true,
    version: JSON.stringify([incident.id, status, incident.actionRequired, incident.resolution]),
    url: admin ? "/dashboard?incident=" + encodeURIComponent(incident.id) + "#connections" : "/dashboard#home",
    ...(admin ? { incident: { status, count: incident.count, firstAt: incident.firstAt, lastAt: incident.lastAt }, linkLabel: "Review incident" } : {}),
  };
}
