import { escapeHtml as h } from "/shared/safe-html.js";

export async function mountIncidentDetails(call) {
  const id = new URLSearchParams(location.search).get("incident");
  if (!id) return;
  const parent = document.getElementById("panel-connections");
  if (!parent) return;
  const host = document.createElement("section"); host.setAttribute("aria-label", "Network incident details"); host.tabIndex = -1;
  host.innerHTML = '<h3>Network incident</h3><p role="status">Loading incident…</p>'; parent.prepend(host);
  async function load() {
    try {
      const result = await call("/api/admin/network/incidents/" + encodeURIComponent(id)), n = result.incident;
      host.innerHTML = `<h3>Network incident</h3><p>${h(n.action.replaceAll("_", " "))} · ${h(n.status)} · ${h(n.count)} occurrence(s)</p><p>First: ${h(new Date(n.firstAt).toLocaleString())}<br>Latest: ${h(new Date(n.lastAt).toLocaleString())}</p>${n.resolution === "obsolete" ? "<p>An outdated operation was closed. This is not confirmation of router recovery.</p>" : ""}<p>${h(result.total)} related command(s); showing up to 100.</p><ul>${result.commands.map((c) => `<li><strong>${h(c.action.replaceAll("_", " "))}</strong> · ${h(c.status)} · ${h(c.attempts)} attempt(s)<br><small><code>${h(c.id)}</code></small>${c.canReplay ? ` <button type="button" data-replay-command="${h(c.id)}">Replay</button>` : ""}${c.canResolve ? ` <button type="button" data-resolve-command="${h(c.id)}">Mark obsolete</button>` : ""}</li>`).join("")}</ul><p><a href="/dashboard#audit">Open audit trail</a> · <a href="/dashboard#connections">All network commands</a></p>`;
      host.focus();
    } catch (error) { host.innerHTML = `<h3>Network incident</h3><p role="status">${h(error.message)}</p><button type="button" data-retry-incident>Retry incident</button>`; host.querySelector("button").onclick = load; }
  }
  await load();
}
