// Outages (#259, canvas: AdminOutage) at #outages. No outage: a "detected
// automatically" hint when the router stops answering, and the form to post a
// notice in English and French. Live: how long it has been down, post an
// update, "Mark as fixed…". Then give time back (the length rounded up, a day,
// or nothing; adding time asks for fresh PIN or passkey proof) and close it.
// Past outages below. Data: /api/admin/outages.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { requestAdminActionProof } from "./action-proof.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB"), ZONE = "Africa/Douala";
const time = (at) => new Date(at).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit", timeZone: ZONE });
const day = (at) => new Date(at).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE });
const length = (ms) => {
  const minutes = Math.max(1, Math.round(ms / 60000)), hours = Math.floor(minutes / 60), rest = minutes % 60;
  return hours ? (rest ? L("adminOutageHoursMinutes", { hours, minutes: rest }) : L("adminOutageHoursOnly", { hours })) : L("adminOutageMinutes", { minutes });
};
const gift = (hours) => (hours === 24 ? L("adminOutageOneDay") : hours === 1 ? L("adminOutageOneHour") : L("adminOutageHours", { hours }));
// "Started" as drawn: "Today 14:20" (or "Yesterday 23:10", or just "14:20"),
// in Douala time. Returns the instant, or null when it can't be read.
const both = (key) => [format(key, {}, "en"), format(key, {}, "fr")];
export function parseStarted(value, now, words = { today: both("adminOutageToday"), yesterday: both("adminOutageYesterday") }) {
  const m = String(value || "").trim().match(/^(?:(.+?)\s+)?(\d{1,2})\s*[:h]\s*(\d{2})$/i);
  if (!m || +m[2] > 23 || +m[3] > 59) return null;
  const word = (m[1] || "").toLowerCase(), is = (list) => list.some((w) => w.toLowerCase() === word);
  const back = !word || is(words.today) ? 0 : is(words.yesterday) ? 1 : null;
  if (back === null) return null;
  const midnight = Date.parse(new Date(+now + 3600000).toISOString().slice(0, 10) + "T00:00:00Z") - 3600000 - back * 864e5;
  return new Date(midnight + (+m[2]) * 3600000 + (+m[3]) * 60000).toISOString();
}

const allSitesLabel = (areas) => (areas && areas.site ? `${L("adminOutageAllSites")} · ${areas.site}` : L("adminOutageAllSites"));
const sameDay = (a, b) => new Date(+a + 3600000).toISOString().slice(0, 10) === new Date(+b + 3600000).toISOString().slice(0, 10);

export async function showOutages(host, context) {
  const { call } = context;
  host.innerHTML = `<p class="nd-meta">${h(L("adminLoading"))}</p>`;
  let data;
  try { data = await call("/api/admin/outages"); }
  catch (error) { host.innerHTML = `<p class="nd-callout nd-callout--warning" role="status">${h(error.message)}</p>`; return; }
  render(host, data, context);
}

function render(host, data, context) {
  const { call } = context, o = data.current, now = Date.now(), manage = data.canManage;
  const step = context.step || (o ? "live" : "idle");
  let top = "";
  if (!o && step === "idle" && manage) {
    const next = [30, 60, 90].map((minutes) => new Date(Math.ceil((now + minutes * 60000) / 1800000) * 1800000));
    // The owner's area names (Network setup; #385): "All sites · Bamenda", then "AP-Market only".
    const areas = data.areas || { site: "", areas: [] }, started = data.detected ? Date.parse(data.detected.since) : now;
    top = `<form class="nd-panel admin-outage__panel" id="outagePost" aria-labelledby="outagePostTitle">${data.detected ? `<p class="admin-outage__detected"><strong>${h(L("adminOutageDetected", { time: time(data.detected.since) }))}</strong> ${h(L("adminOutageDetectedHint"))}</p>` : ""}<h2 class="admin-outage__h2" id="outagePostTitle">${h(L("adminOutagePost"))}</h2>
      <div class="admin-outage__fields"><div><label for="outageArea">${h(L("adminOutageArea"))}</label><select id="outageArea" name="area"><option value="" selected>${h(allSitesLabel(areas))}</option>${areas.areas.map((a) => `<option value="${h(a)}">${h(L("adminOutageAreaOnly", { area: a }))}</option>`).join("")}</select></div>
        <div><label for="outageStart">${h(L("adminOutageStarted"))}</label><input id="outageStart" name="startedAt" value="${h(`${L(sameDay(started, now) ? "adminOutageToday" : "adminOutageYesterday")} ${time(started)}`)}" autocomplete="off" required></div>
        <div><label for="outageNext">${h(L("adminOutageNext"))}</label><select id="outageNext" name="nextUpdateBy">${next.map((at, i) => `<option value="${h(at.toISOString())}"${i === 1 ? " selected" : ""}>${h(time(at))}</option>`).join("")}</select></div></div>
      <div><label for="outageEn">${h(L("adminOutageMessageEn"))}</label><textarea id="outageEn" name="en" required>${h(format("adminOutageDefault", { time: time(data.detected ? data.detected.since : now) }, "en"))}</textarea></div>
      <div><label for="outageFr">${h(L("adminOutageMessageFr"))}</label><textarea id="outageFr" name="fr" required>${h(format("adminOutageDefault", { time: time(data.detected ? data.detected.since : now) }, "fr"))}</textarea></div>
      <label class="admin-outage__check"><input type="checkbox" name="show" checked>${h(L("adminOutageShow"))}</label>
      <label class="admin-outage__check"><input type="checkbox" name="notify" checked>${h(L("adminOutageNotify", { count: data.activeBundles }))}</label>
      <p class="admin-outage__message" role="status" aria-live="polite"></p>
      <div class="admin-outage__buttons"><button type="submit" class="admin-outage__go">${h(L("adminOutagePostButton"))}</button></div></form>`;
  }
  if (o && step === "live") {
    const down = now - Date.parse(o.startedAt);
    top = `<section class="nd-panel admin-outage__panel admin-outage__live" aria-labelledby="outageLiveTitle"><div class="admin-outage__live-head"><h2 class="admin-outage__h2" id="outageLiveTitle"><span class="admin-outage__dot" aria-hidden="true"></span>${h(L("adminOutageLive"))}</h2>
        <span class="admin-outage__down">${h(L("adminOutageDown", { length: length(down) }))}</span></div>
      <p class="admin-outage__line">${h([o.area, L("adminOutageSince", { time: time(o.startedAt) }), L(o.showToCustomers ? "adminOutageShown" : "adminOutageHidden"), L("adminOutageAffected", { count: o.affected })].join(" · "))}</p>
      ${manage ? `<form id="outageUpdate" class="admin-outage__form"><div><label for="outageUpdateText">${h(L("adminOutageUpdate"))}</label><textarea id="outageUpdateText" name="text" placeholder="${h(L("adminOutageUpdateHint"))}"></textarea></div>
      <p class="admin-outage__message" role="status" aria-live="polite">${context.notice ? h(context.notice) : ""}</p>
      <div class="admin-outage__buttons"><button type="submit" class="admin-outage__go2">${h(L("adminOutagePostUpdate"))}</button><button type="button" class="admin-outage__go" data-outage-fix>${h(L("adminOutageFix"))}</button></div></form>` : ""}</section>`;
  }
  if (o && step === "comp") {
    const lengthMs = now - Date.parse(o.startedAt), hours = Math.max(1, Math.ceil(lengthMs / 3600000));
    const choices = [["round", gift(hours), L("adminOutageRoundHint")], ["day", gift(24), L("adminOutageDayHint")], ["none", L("adminOutageNothing"), L("adminOutageNothingHint")]];
    const chosen = context.choice || "round", add = chosen === "round" ? hours : chosen === "day" ? 24 : 0;
    top = `<form class="nd-panel admin-outage__panel" id="outageClose" aria-labelledby="outageCloseTitle"><h2 class="admin-outage__h2" id="outageCloseTitle">${h(L("adminOutageBack"))}</h2>
      <p class="admin-outage__line">${L("adminOutageLasted", { length: `<strong>${h(length(lengthMs))}</strong>`, from: h(time(o.startedAt)), to: h(time(now)), customers: `<strong>${h(L("adminOutageCustomers", { count: o.affected }))}</strong>` })}</p>
      <fieldset class="admin-outage__choices"><legend>${h(L("adminOutageAddTo"))}</legend>${choices.map(([id, label, hint]) => `<label class="admin-outage__choice${id === chosen ? " admin-outage__choice--on" : ""}"><input type="radio" name="compensation" value="${id}"${id === chosen ? " checked" : ""}><span><strong>${h(label)}</strong><span>${h(hint)}</span></span></label>`).join("")}</fieldset>
      <p class="admin-outage__note">${h(L("adminOutageCloseNote"))}</p>
      <p class="admin-outage__message" role="status" aria-live="polite"></p>
      <div class="admin-outage__buttons"><button type="submit" class="admin-outage__go">${h(add ? L("adminOutageAdd", { amount: gift(add).replace(/^\+/, ""), count: o.affected }) : L("adminOutageClose"))}</button></div></form>`;
  }
  if (context.closed) top = `<p class="admin-outage__done" role="status"><strong>${h(L("adminOutageClosed"))}</strong> ${h(context.closed)}</p>`;
  const rows = data.past.map((p) => `<tr><td>${h(`${day(p.startedAt)} · ${time(p.startedAt)}`)}</td><td>${h(p.allSites ? L("adminOutageAllSites") : p.area)}</td><td>${h(length(p.lengthMs))}</td><td>${h(p.cause || (p.detectedProblem ? L("adminOutageCauseRouter") : "—"))}</td>
    <td${p.compensation?.hours ? "" : ' class="admin-outage__none"'}>${h(p.compensation?.hours ? L(p.compensation.hours === 24 ? "adminOutageGivenDay" : "adminOutageGivenHours", { hours: p.compensation.hours, count: p.compensation.customers }) : L("adminOutageNone"))}</td></tr>`).join("");
  host.innerHTML = `<div class="admin-outage">${top}<section class="nd-panel admin-outage__panel admin-outage__past" aria-labelledby="outagePastTitle"><h2 class="admin-outage__h2" id="outagePastTitle">${h(L("adminOutagePast"))}</h2>
    ${rows ? `<div class="admin-outage__table"><table><thead><tr><th scope="col">${h(L("adminOutageWhen"))}</th><th scope="col">${h(L("adminOutageAreaCol"))}</th><th scope="col">${h(L("adminOutageLength"))}</th><th scope="col">${h(L("adminOutageCause"))}</th><th scope="col">${h(L("adminOutageGivenBack"))}</th></tr></thead><tbody>${rows}</tbody></table></div>` : `<p class="nd-meta">${h(L("adminOutageNoPast"))}</p>`}</section></div>`;
  bind(host, data, context, step);
}

function bind(host, data, context, step) {
  const { call } = context, o = data.current;
  const busy = async (form, work) => {
    const button = form.querySelector("[type=submit]"), message = form.querySelector(".admin-outage__message");
    button.disabled = true;
    try { await work(); }
    catch (error) { if (error.name !== "AbortError" && message) message.textContent = error.message; }
    finally { if (button.isConnected) button.disabled = false; }
  };
  const post = host.querySelector("#outagePost");
  if (post) post.onsubmit = (event) => {
    event.preventDefault();
    const f = post.elements, startedAt = parseStarted(f.startedAt.value, new Date());
    if (!startedAt) { post.querySelector(".admin-outage__message").textContent = L("adminOutageStartedHint"); f.startedAt.focus(); return; }
    void busy(post, async () => {
      // A whole-site outage reads "All sites · Bamenda" to customers.
      await call("/api/admin/outages", { method: "POST", body: JSON.stringify({ area: f.area.value || allSitesLabel(data.areas), allSites: !f.area.value, startedAt, nextUpdateBy: f.nextUpdateBy.value,
        message: { en: f.en.value, fr: f.fr.value }, showToCustomers: f.show.checked, notify: f.notify.checked }) });
      await showOutages(host, { call });
    });
  };
  const update = host.querySelector("#outageUpdate");
  if (update) update.onsubmit = (event) => {
    event.preventDefault();
    void busy(update, async () => {
      await call("/api/admin/outages/update", { method: "POST", body: JSON.stringify({ outageId: o.id, text: update.elements.text.value }) });
      await showOutages(host, { call, notice: L("adminOutageUpdated") });
    });
  };
  host.querySelector("[data-outage-fix]")?.addEventListener("click", () => { render(host, data, { call, step: "comp" }); host.querySelector("#outageCloseTitle").focus?.(); });
  const close = host.querySelector("#outageClose");
  if (close) {
    close.querySelectorAll("input[name=compensation]").forEach((radio) => { radio.onchange = () => { render(host, data, { call, step: "comp", choice: radio.value }); host.querySelector(`input[value="${radio.value}"]`).focus(); }; });
    close.onsubmit = (event) => {
      event.preventDefault();
      const compensation = close.elements.compensation.value;
      void busy(close, async () => {
        const input = { outageId: o.id, compensation };
        const proof = compensation === "none" ? {} : await requestAdminActionProof({ call, purpose: "outage_compensation", input });
        const result = await call("/api/admin/outages/close", { method: "POST", body: JSON.stringify({ ...input, ...proof }) });
        const given = result.outage.compensation;
        const fresh = await call("/api/admin/outages");
        // Customers with an unclear history get no time automatically (#287): staff settle them by hand.
        const held = given && given.needsReview ? " " + L("adminOutageHeld", { count: given.needsReview }) : "";
        render(host, fresh, { call, closed: (given && given.hours ? L("adminOutageClosedAdded", { amount: gift(given.hours), count: result.outage.affected }) : L("adminOutageClosedNone")) + held });
      });
    };
  }
}
