// Replace a device (#350, canvas: PhoneReplaceDevice; owner 27 Nov): on the
// device refused because every Personal Unlimited slot is full. Pick the device
// this one replaces and confirm with the PIN; the server removes that device
// (session, saved sign-in, binding) and its slot frees only once the router
// confirms; then this phone connects with the same PIN. If the router can't
// confirm, nothing changes and Try again asks it again (the replace request is
// safe to repeat). The bundle's end date never moves.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format, getPreferredLanguage } from "/shared/i18n.js";
import { requestJson, randomId } from "./compat.js";
import { ApiError, responseError } from "./errors.js";
import { wifiHint, startWifiRequest } from "./wifi-pairing.js";
import { withWifiHint } from "./hotspot-path.js";
const lang = getPreferredLanguage();
document.documentElement.lang = lang;
const L = (key, values) => format(key, values || {}, lang);
const api = window.NDAHI_CONFIG.apiUrl, $ = (id) => document.getElementById(id), main = $("replaceMain"), foot = $("replaceFoot");
const hint = wifiHint(), params = new URLSearchParams(location.search);
let csrf = "", slots = null, chosen = params.get("slot") || "", pin = "", customerName = "", step = 0, failed = false;

async function call(path, input) {
  const { response, body } = await requestJson(api + path, input === undefined ? { credentials: "include", cache: "no-store" }
    : { method: "POST", credentials: "include", headers: { "content-type": "application/json", "x-csrf-token": csrf }, body: JSON.stringify(input) });
  if (!response.ok) throw responseError(response, body);
  return body;
}
const mask = (mac) => "••:••:••:" + String(mac || "").toUpperCase().split(":").slice(-3).join(":");
const shortName = (name) => { const [first, last] = String(name || "").trim().split(/\s+/); return first ? first + (last ? " " + last[0].toUpperCase() + "." : "") : ""; };
const kind = () => { const ua = navigator.userAgent; return /iPhone/.test(ua) ? "Iphone" : /iPad/.test(ua) ? "Ipad" : /Android/i.test(ua) ? (/Mobile/i.test(ua) ? "AndroidPhone" : "AndroidTablet") : /Windows/.test(ua) ? "Windows" : /Macintosh|Mac OS X/.test(ua) ? "Mac" : /CrOS/.test(ua) ? "Chromebook" : /Linux/.test(ua) ? "Linux" : ""; };
const ago = (at) => { const minutes = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 60000)); return minutes < 60 ? L("replaceMinutes", { count: Math.max(1, minutes) }) : minutes < 2880 ? L("replaceHours", { count: Math.round(minutes / 60) }) : L("replaceDays", { count: Math.round(minutes / 1440) }); };
const meta = (row, n) => [L("replaceSlot", { n }), row.mac, row.online ? L("replaceOnlineNow") : row.lastSeenAt ? L("replaceOffline", { ago: ago(row.lastSeenAt) }) : L("replaceOfflineOnly")].join(" · ");
const rows = () => (slots?.rows || []).filter((row) => !row.removing);
const oldName = () => rows().concat(slots?.rows || []).find((row) => row.id === chosen)?.name || L("replaceTheDevice");
const ends = () => slots?.endsAt ? new Date(slots.endsAt).toLocaleString(lang === "fr" ? "fr-FR" : "en-GB", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).replace(",", "").replace(/(\d{2}:\d{2})$/, L("replaceAt") + " $1") : "";
const title = (text, tag = "h1") => `<${tag} class="replace__h1" tabindex="-1">${h(text)}</${tag}>`;
function showFoot(html) { foot.innerHTML = html; foot.hidden = !html; }

function pick() {
  main.className = "replace__main";
  const total = slots.total, list = rows();
  const heading = total === 1 ? L("replaceOneInUse") : total === 2 ? L("replaceBothInUse") : L("replaceAllInUse", { count: total });
  main.innerHTML = title(heading)
    + `<div class="replace__this"><strong>${h(L("replaceThisDevice"))}</strong>${kind() ? " · " + h(L("replaceKind" + kind())) : ""}<br><span class="replace__mono">${h(L("replaceSeenBy", { mac: mask(hint?.mac) }))}</span></div>`
    + `<p class="replace__p">${h(L("replaceChoose"))}</p>`
    + `<div class="replace__opts" role="radiogroup" aria-label="${h(L("replaceWhich"))}">${list.map((row, i) => `<button type="button" class="replace__opt" role="radio" aria-checked="${row.id === chosen}" data-slot="${h(row.id)}"><span><strong>${h(row.name || L("replaceUnnamed"))}</strong><span class="replace__mono">${h(meta(row, (slots.rows.indexOf(row)) + 1))}</span></span></button>`).join("")}</div>`
    + `<div><label class="replace__label" for="replacePin">${h(L("replacePin"))}</label><input class="replace__pin" id="replacePin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]{4,6}" maxlength="6" required></div>`
    + `<p class="replace__msg" id="replaceError" role="alert"></p>`;
  const ready = () => { const button = $("replaceStart"); if (button) button.disabled = !chosen || !/^\d{4,6}$/.test($("replacePin").value); };
  showFoot(`<button type="button" class="replace__btn" id="replaceStart" disabled>${h(L("replaceDo", { name: oldName() }))}</button><a class="replace__btn2" href="/dashboard#devices">${h(L("replaceCancel"))}</a>`);
  for (const button of main.querySelectorAll("[data-slot]")) button.onclick = () => {
    chosen = button.dataset.slot;
    for (const other of main.querySelectorAll("[data-slot]")) other.setAttribute("aria-checked", String(other === button));
    $("replaceStart").textContent = L("replaceDo", { name: oldName() }); ready();
  };
  $("replacePin").oninput = ready; ready();
  $("replaceStart").onclick = () => { pin = $("replacePin").value; step = 0; failed = false; void run(); };
}
function work() {
  main.className = "replace__main replace__main--work";
  const labels = [L("replaceStepDisconnect", { name: oldName() }), L("replaceStepClear"), L("replaceStepConfirm"), L("replaceStepConnect")];
  main.innerHTML = `<h1 class="replace__h1" role="status" tabindex="-1">${h(L(failed ? "replacePaused" : "replaceMoving"))}</h1>`
    + `<ol class="replace__steps">${labels.map((label, i) => { const state = failed && i === 2 ? "bad" : i < step ? "done" : i === step ? "current" : "next";
      return `<li data-step-state="${state}"><span class="replace__mk" aria-hidden="true">${state === "bad" ? "!" : state === "done" ? "✓" : i + 1}</span><span>${h(label)}</span></li>`; }).join("")}</ol>`
    + (failed ? `<p class="replace__alert" role="alert"><strong>${h(L("replaceFailedTitle", { name: oldName() }))}</strong> ${h(L("replaceFailedBody"))}</p>` : "")
    + `<p class="replace__note">${h(L("replaceNote"))}</p><p class="replace__msg" id="replaceError" role="alert"></p>`;
  showFoot(failed ? `<button type="button" class="replace__btn" id="replaceRetry">${h(L("replaceRetry"))}</button>` : "");
  if (failed) $("replaceRetry").onclick = () => { failed = false; step = 0; void run(); };
}
function done(home) {
  main.className = "replace__main replace__main--done";
  const name = oldName();
  main.innerHTML = `<div class="replace__icon" aria-hidden="true"><svg width="40" height="40" viewBox="0 0 24 24" focusable="false" fill="none" stroke="#345000" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12 5 5 9-10"></path></svg></div>`
    + title(L("replaceDoneTitle")) + `<p class="replace__text">${h(L("replaceDoneBody", { name }))}</p>`
    + (ends() ? `<p class="replace__ends">${h(L("replaceEndsBefore"))} <strong>${h(ends())}</strong>${h(L("replaceEndsAfter"))}</p>` : "");
  showFoot(`<a class="replace__btn" href="${h(home)}">${h(L("replaceDone"))}</a>`);
}
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function run() {
  work(); main.querySelector("h1").focus();
  try {
    // 1–2: remove the old device (its session and saved sign-in). Repeating is safe.
    const reply = await call("/api/account/device-management/replace", { approvalId: chosen, pin });
    slots = reply.slots || slots; step = 2; work();
    // 3: the router confirms it's off; the slot frees only then.
    const deadline = Date.now() + 120000;
    for (;;) {
      const list = await call("/api/account/device-management"), held = (list.slots?.rows || []).some((row) => row.id === chosen);
      const removal = (list.approvedDevices || []).find((d) => d.id === chosen)?.removal;
      if (!held) break;
      if (removal === "failed" || Date.now() > deadline) { failed = true; work(); return; }
      await wait(2000);
    }
    step = 3; work();
    // 4: this phone connects, with the same PIN as owner proof.
    done(await connect());
  } catch (error) {
    if (error.code === "VERIFICATION_FAILED" || error.status === 429) { pick(); $("replaceError").textContent = error.message; return; }
    work(); $("replaceError").textContent = error.message || L("replaceProblem");
  }
}
async function connect() {
  const post = (path, payload) => call(path, payload), input = { mac: hint.mac, address: hint.address, key: randomId(), recover: true, pin }, deadline = Date.now() + 120000;
  let result;
  while (Date.now() < deadline) {
    try {
      result = await startWifiRequest((payload) => post("/api/account/device-management/connect", payload), input, (next) => { input.key = next; });
      if (result.code === "HOTSPOT_PENDING") { result = null; await wait(2000); continue; }
      break;
    } catch (error) {
      if (error.code === "DEVICE_REFRESH_REQUIRED") { await wait(2000); continue; }
      throw error;
    }
  }
  if (!result) throw new ApiError(408, L("replaceNotConnected"));
  let request = result.request;
  while (Date.now() < deadline && request.status === "connecting") { await wait(2000); request = (await post("/api/wifi/pairing/status", { id: request.id, key: input.key })).request; }
  if (request.status !== "connected") throw new ApiError(408, request.message || L("replaceNotConnected"));
  return "/dashboard#home";
}

$("replaceTitle").textContent = L("replaceTitle");
void (async () => {
  try {
    const account = await call("/api/account/dashboard");
    csrf = account.csrfToken; customerName = shortName(account.customer?.name);
    $("replaceSignedIn").textContent = customerName ? L(hint ? "replaceSignedInWifi" : "replaceSignedInAs", { name: customerName }) : "";
    const list = await call("/api/account/device-management");
    slots = list.slots || null;
    if (!hint) { main.innerHTML = `<p class="replace__msg">${h(L("replaceNeedWifi"))}</p>`; showFoot(`<a class="replace__btn" href="${h(withWifiHint("/hotspot"))}">${h(L("replaceOpenWifi"))}</a>`); return; }
    if (!slots) { main.innerHTML = `<p class="replace__msg">${h(L("replaceNoSlots"))}</p>`; showFoot(`<a class="replace__btn2" href="/dashboard#devices">${h(L("replaceCancel"))}</a>`); return; }
    if (!rows().some((row) => row.id === chosen)) chosen = "";
    pick();
  } catch (error) {
    if (error.status === 401) { location.replace("/login?next=" + encodeURIComponent(location.pathname + location.search)); return; }
    main.innerHTML = `<p class="replace__msg" role="alert">${h(error.message || L("replaceProblem"))}</p>`;
  }
})();
