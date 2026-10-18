import { requestJson } from "./compat.js";
const config = window.NDAHI_CONFIG || {}, contacts = document.getElementById("supportContacts");
const links = [];
function contact(label, href) {
  const p = document.createElement("p"), a = document.createElement("a");
  a.textContent = label; a.href = href; p.appendChild(a); links.push(p);
}
if (config.supportEmail) contact("Email support: " + config.supportEmail, "mailto:" + config.supportEmail);
if (config.supportPhone) contact("Call support: " + config.supportPhone, "tel:" + config.supportPhone.replace(/[^+0-9]/g, ""));
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
