import { requestJson } from "./compat.js";
import { runConnectionDiagnostics } from "./network-status.js";
import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton } from "/shared/pending.js";
import { mountThemeToggle } from "./portal-nav.js";

mountThemeToggle();

const config = window.NDAHI_CONFIG || {}, contacts = document.getElementById("supportContacts");
const links = [];
function contact(label, href, isButton = false) {
  const p = document.createElement("p"), a = document.createElement("a");
  a.textContent = label; a.href = href;
  if (isButton) { a.className = "button whatsapp-btn"; a.target = "_blank"; a.rel = "noopener"; }
  p.appendChild(a); links.push(p);
}
if (config.supportPhone) {
  const rawNumber = config.supportPhone.replace(/[^0-9]/g, "");
  if (rawNumber) {
    const waUrl = `https://wa.me/${encodeURIComponent(rawNumber)}?text=${encodeURIComponent("Hello NDAHI Support,\nI need assistance with my NDAHI Connect service.")}`;
    contact("💬 Chat with Support on WhatsApp", waUrl, true);
  }
  contact("Call support: " + config.supportPhone, "tel:" + config.supportPhone.replace(/[^+0-9]/g, ""));
}
if (config.supportEmail) contact("Email support: " + config.supportEmail, "mailto:" + config.supportEmail);
if (links.length) { contacts.textContent = ""; links.forEach((link) => contacts.appendChild(link)); }

function openAnswer() {
  const target = document.getElementById(location.hash.slice(1));
  if (target && target.tagName === "DETAILS") target.open = true;
}
window.addEventListener("hashchange", openAnswer); openAnswer();

requestJson(config.apiUrl + "/api/status", { cache: "no-store" }).then(({ response, body }) => {
  if (!response.ok) return;
  const labels = { online: "Network online", degraded: "Service is degraded", offline: "Network offline", maintenance: "Maintenance in progress", bootstrap: "Service setup in progress" };
  document.getElementById("helpNetwork").textContent = (labels[body.service] || "Network status unavailable") + (body.zoneNotes ? ". " + body.zoneNotes : ".");
}).catch(() => { document.getElementById("helpNetwork").textContent = "Network information is unavailable. Your last account balance and payment status are shown after signing in online."; });

const diagBtn = document.getElementById("runDiagnostics");
if (diagBtn) {
  diagBtn.onclick = async () => {
    const output = document.getElementById("diagnosticsOutput");
    if (!output) return;
    await runButton(diagBtn, "Testing connection…", async () => {
      output.innerHTML = '<p class="loading">Pinging NDAHI gateway…</p>';
      const res = await runConnectionDiagnostics(config.apiUrl || "");
      const qualityClass = res.quality === "good" ? "success" : res.quality === "fair" ? "warning" : "error";
      output.innerHTML = `<div class="diag-card ${qualityClass}">
        <h3>Gateway Health: ${h(res.quality.toUpperCase())}</h3>
        <p><strong>Advice:</strong> ${h(res.advice)}</p>
        <div class="stats">
          <div class="stat"><b>${res.avgLatency !== null ? `${h(res.avgLatency)} ms` : "Failed"}</b><small>Average latency</small></div>
          <div class="stat"><b>${h(res.packetLoss)}%</b><small>Packet loss</small></div>
          <div class="stat"><b>${h(res.jitter)} ms</b><small>Jitter</small></div>
        </div>
      </div>`;
    });
  };
}
