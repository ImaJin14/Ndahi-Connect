// Home WISP routers (canvas: AdminHomeRouters, #340; owner 26 Nov), inside
// the admin shell: Reconcile now and when it last ran, the counts, each
// registered router (masked MAC, online or not, whether sharing applies) with
// Revoke, recent changes and the rule. The NDAHI Home pilot import and
// readiness check stay in the old admin (owner, 26 Nov).
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { mountStandaloneMenu } from "/navigation.js";
const api = window.NDAHI_CONFIG.apiUrl;
const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr" : "en-GB"), ZONE = "Africa/Douala";
const day = (value) => new Date(value).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE }).replace(/\bSept\b/, "Sep");
const clock = (value, seconds) => new Date(value).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}), timeZone: ZONE });
const ago = (value) => {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(value)) / 60000));
  return minutes < 1 ? L("adminWispJustNow") : minutes === 1 ? L("adminWispOneMinAgo") : minutes < 60 ? L("adminWispMinsAgo", { count: minutes }) : `${day(value)} ${clock(value)}`;
};
let csrf, data;
async function call(path, input) {
  const response = await fetch(api + path, { credentials: "include", ...(input ? { method: "POST", body: JSON.stringify(input) } : {}),
    headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) } });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(result.error || L("adminWispUnavailable"));
  return result;
}
const $ = (selector) => document.querySelector(selector);
const message = (text) => { $("#wispMessage").textContent = text; };

// The page's own words.
$("#adminEyebrow").textContent = L("adminWispEyebrow");
$("#adminTitle").textContent = L("adminWispTitle");
$("#adminLede").textContent = L("adminWispLede");
$("#reconcileNow").textContent = L("adminWispReconcile");
$("#wispRoutersTitle").textContent = L("adminWispRouters");
$("#wispRecentTitle").textContent = L("adminWispRecent");
$("#wispRule").innerHTML = L("adminWispRule", { and: `<strong>${h(L("adminWispAnd"))}</strong>` });
$("#wispReasonLabel").textContent = L("adminWispReason");
$("#wispRevokeCancel").textContent = L("adminCancel");
$("#wispRevokeGo").textContent = L("adminWispRevoke");
document.querySelector("#logout").onclick = async () => {
  try { await fetch(api + "/api/admin/logout", { method: "POST", credentials: "include", headers: { "content-type": "application/json", ...(csrf ? { "x-csrf-token": csrf } : {}) } }); }
  finally { location.href = "/login"; }
};

const PILL = { online: "success", offline: "", disconnected: "danger", sharing: "success", idle: "success", withheld: "warning", removed: "" };
const pill = (kind, text) => `<span class="nd-pill${PILL[kind] ? " nd-pill--" + PILL[kind] : ""} admin-wisp__pill">${h(text)}</span>`;
function why(row) {
  if (row.sharing === "sharing") return row.checkedAt ? L("adminWispChecked", { when: ago(row.checkedAt) }) : L("adminWispNotChecked");
  if (row.sharing === "idle") return L("adminWispIdleWhy");
  if (row.sharing === "withheld") return L("adminWispWithheldWhy");
  return row.revokedAt ? L("adminWispRevokedAt", { time: clock(row.revokedAt) }) : row.expiredAt ? L("adminWispExpiredAt", { time: clock(row.expiredAt) }) : "";
}
// A translated line with some values marked up, as drawn: names bold, MACs in
// monospace. The text is escaped first; only the values are wrapped.
function rich(key, values, wrap) {
  const marks = Object.keys(wrap), tokens = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, marks.includes(k) ? `\u0001${k}\u0002` : v]));
  return h(L(key, tokens)).replace(/\u0001(\w+)\u0002/g, (_, k) => wrap[k](h(values[k])));
}
const bold = (value) => `<strong>${value}</strong>`, mono = (value) => `<span class="admin-wisp__mac">${value}</span>`;
function recentLine(e) {
  if (e.kind === "replaced") return rich("adminWispReplaced", { name: e.customer, from: e.from || "—", to: e.to || "—", time: clock(e.at, true) }, { name: bold, from: mono, to: mono });
  if (e.kind === "cutoff") return rich(e.reason === "revoked" ? "adminWispRevokedLine" : "adminWispExpiredLine", { name: e.customer, time: clock(e.at) }, { name: bold });
  return h(L("adminWispReconciledLine", { time: clock(e.at), count: e.checked ?? 0, stale: e.stale ?? 0 }));
}
function render(view, fresh) {
  const last = $("#wispLast");
  last.classList.toggle("admin-wisp__last--fresh", Boolean(fresh));
  last.textContent = fresh ? L("adminWispReconciledNow", { count: fresh.checked, stale: fresh.stale })
    : view.lastReconciledAt ? L("adminWispLast", { when: ago(view.lastReconciledAt), every: view.everyMinutes }) : L("adminWispNever", { every: view.everyMinutes });
  const m = view.metrics;
  $("#wispMetrics").innerHTML = [[m.registered, "adminWispRegistered"], [m.sharing, "adminWispSharingNow"], [m.withheld, "adminWispWithheld"], [m.stale, "adminWispStale"]]
    .map(([value, key]) => `<div class="nd-panel admin-wisp__metric"><b>${h(String(value))}</b><span>${h(L(key))}</span></div>`).join("");
  $("#wispRouters").innerHTML = view.rows.length ? `<table class="admin-wisp__grid"><thead><tr><th scope="col">${h(L("adminColCustomer"))}</th><th scope="col">${h(L("adminWispSubscription"))}</th><th scope="col">${h(L("adminWispRegisteredRouter"))}</th><th scope="col">${h(L("adminWispRouter"))}</th><th scope="col">${h(L("adminWispSharing"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminActions"))}</span></th></tr></thead><tbody>
    ${view.rows.map((r) => `<tr data-wisp-row="${h(r.customerId)}"><td><a href="/dashboard#customer/${encodeURIComponent(r.customerId)}">${h(r.name || L("adminUnnamedCustomer"))}</a></td>
      <td>${h(r.endsAt ? L(r.ended ? "adminWispExpiredOn" : "adminWispEndsOn", { date: day(r.endsAt) }) : "—")}</td><td class="admin-wisp__mac">${h(r.mac)}</td>
      <td>${pill(r.router, L({ online: "adminWispOnline", offline: "adminWispOffline", disconnected: "adminWispDisconnected" }[r.router]))}</td>
      <td>${pill(r.sharing, L({ sharing: "adminWispShare", idle: "adminWispShareIdle", withheld: "adminWispShareWithheld", removed: "adminWispShareRemoved" }[r.sharing]))}<br><span class="admin-wisp__why">${h(why(r))}</span></td>
      <td class="admin-wisp__act">${r.revocable ? `<button type="button" class="admin-wisp__revoke" data-wisp-revoke="${h(r.customerId)}">${h(L("adminWispRevoke"))}</button>` : ""}</td></tr>`).join("")}</tbody></table>`
    : `<p class="nd-meta">${h(L("adminWispNone"))}</p>`;
  $("#wispRecent").innerHTML = view.recent.length ? view.recent.map((e) => `<li>${recentLine(e)}</li>`).join("") : `<li>${h(L("adminWispNoChanges"))}</li>`;
  for (const button of document.querySelectorAll("[data-wisp-revoke]")) button.onclick = () => openRevoke(view.rows.find((r) => r.customerId === button.dataset.wispRevoke), button);
}
async function refresh(fresh) {
  const info = await call("/api/admin/home");
  data = info.routers;
  render(data, fresh);
}

// Revoke (confirmed, with a reason for the audit log): the router is
// disconnected and sharing removed; the customer's other records stay.
const dialog = $("#wispRevoke"), form = $("#wispRevokeForm");
let revoking = null;
function openRevoke(row, opener) {
  revoking = { row, opener };
  $("#wispRevokeTitle").textContent = L("adminWispRevokeTitle", { name: row.name || L("adminUnnamedCustomer") });
  $("#wispRevokeBody").textContent = L("adminWispRevokeBody");
  form.elements.reason.value = "";
  dialog.showModal();
  form.elements.reason.focus();
}
$("#wispRevokeCancel").onclick = () => { dialog.close(); revoking?.opener.focus(); };
form.onsubmit = async (event) => {
  event.preventDefault();
  const reason = form.elements.reason.value.trim();
  if (!reason || !revoking) return;
  const { row } = revoking;
  dialog.close();
  try {
    await call("/api/admin/home/revoke", { customerId: row.customerId, reason });
    await refresh();
    message(L("adminWispRevoked", { name: row.name || L("adminUnnamedCustomer") }));
  } catch (error) { message(error.message); }
};
$("#reconcileNow").onclick = async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  try { const result = await call("/api/admin/home/reconcile", {}); data = result.routers; render(data, result.run); }
  catch (error) { $("#wispLast").textContent = error.message; }
  finally { button.disabled = false; }
};
(async () => {
  try {
    const x = await call("/api/admin/dashboard");
    csrf = x.csrfToken;
    mountStandaloneMenu({ role: x.profile?.role, current: "homerouters", sales: Boolean(x.sales) });
    await refresh();
  } catch (error) { message(error.message); }
})();
