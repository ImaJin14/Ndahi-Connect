// Kits & installs (#347, canvas: AdminStoreServices) at #services, owners and
// operators. Three tabs in the page head:
//   Kits           kits on sale beside the chosen kit's form (name, router,
//                  first bundle, price with "Bought separately", Set up,
//                  installation, Pay in 3), Save kit and its status buttons
//   Installations  the next days' jobs (technician, On the way, Done… with the
//                  signal and a photo, Couldn't install, the report), then the
//                  Installation settings panel (owner, 27 Nov)
//   Payment plans  the figures, each plan (remind, give more days once, cancel
//                  and refund) and the plan rules
// Every figure comes from /api/admin/store; the server checks every action.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { fcfa, maskPhone } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const ZONE = "Africa/Douala", DAY = 864e5;
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB");
const named = (value) => (value && typeof value === "object" ? value[currentLanguage()] || value.en || "" : String(value || ""));
const dayKey = (at) => new Date(at).toLocaleDateString("en-CA", { timeZone: ZONE });
// "Thu 19" for the day pills; "Sat 5 Dec" for dates in the tables.
const pillDay = (at) => new Date(at).toLocaleDateString(locale(), { weekday: "short", day: "numeric", timeZone: ZONE });
const shortDate = (at) => new Date(at).toLocaleDateString(locale(), { weekday: "short", day: "numeric", month: "short", timeZone: ZONE });
const stamp = (at) => new Date(at).toLocaleString(locale(), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: ZONE });
// A noon in Douala on a "YYYY-MM-DD" day, safe for weekday maths.
const noon = (key) => new Date(key + "T11:00:00Z");
// "Amina N." as drawn: the first name and the last name's initial; a name
// that starts with an initial already ("K. Nji") stays as it is.
const shortName = (name) => {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (/^\p{L}\.$/u.test(parts[0] || "")) return parts.join(" ");
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0]}.` : parts[0] || "—";
};
const validityDays = (b) => (b?.validityUnit === "days" ? b.validityValue : Math.round((b?.validityHours || 0) / 24));
const length = (b) => {
  const days = validityDays(b);
  if (days >= 1) return days === 1 ? L("adminKitsDay") : L("adminKitsDays", { count: days });
  return L("adminKitsHours", { count: b?.validityHours || 0 });
};
// The First bundle select: "[PLAN 2] · Unlimited · 7 days · 2 devices", or
// "Home WISP Unlimited · 30 days" (no device count for Home WISP, 24 Nov).
const bundleLabel = (b) => b.accessType === "personal_unlimited"
  ? [named(b.name), L("adminKitsUnlimited"), length(b), b.deviceSlots === 1 ? L("adminKitsDevice") : L("adminKitsDevices", { count: b.deviceSlots })].join(" · ")
  : [named(b.name), length(b)].join(" · ");
const productName = (p) => named(p?.name) || p?.sku || "";
// Summaries name products by their short code, as drawn ("AX1500 + …", "Home kit · AX1500").
const productCode = (p) => p?.sku || named(p?.name) || "";
const TONE = { success: "admin-kits__pill--success", neutral: "admin-kits__pill--neutral", info: "admin-kits__pill--info", warning: "admin-kits__pill--warning", danger: "admin-kits__pill--danger" };
const pill = (text, tone) => `<span class="admin-kits__pill ${TONE[tone]}">${h(text)}</span>`;
const JOB_TONE = { booked: "info", moved: "warning", on_the_way: "warning", installed: "success", not_installed: "danger", cancelled: "neutral" };
const OPEN_JOB = ["booked", "moved", "on_the_way"];
const TABS = ["kits", "installs", "plans"];
const DEPOSITS = [30, 40, 50], PERIODS = [30, 45, 60], GRACES = [7, 14];

// A job counts once its order is paid; a booking held during payment isn't one yet.
const jobs = (snapshot) => snapshot.orders.filter((o) => o.installation && o.progress?.paidAt && o.installation.status !== "cancelled" && o.kind !== "plan_payment");
const todayOpenJobs = (snapshot, now = Date.now()) => jobs(snapshot).filter((o) => o.installation.day === dayKey(now) && OPEN_JOB.includes(o.installation.status)).length;
// The side menu's count, as drawn on Kits & installs: today's jobs still to do.
export const servicesBadge = (snapshot) => (snapshot?.orders ? todayOpenJobs(snapshot, Date.parse(snapshot.serverTime) || Date.now()) : 0);

export function mountServices(host, tabsHost, { call, role }) {
  let state, tab = "kits", kitId = "", day = "", openJob = "", report = "", photo = null, loading, notice = "";
  host.innerHTML = `<button type="button" class="nd-btn nd-btn--secondary" id="servicesRetry" hidden>${h(L("adminKitsRetry"))}</button><p class="nd-meta admin-kits__message" id="servicesMessage" role="status" aria-live="polite"></p><div class="admin-kits" id="servicesContent"></div>`;
  const $ = (s) => host.querySelector(s), message = $("#servicesMessage"), content = $("#servicesContent");
  const now = () => Date.parse(state?.serverTime) || Date.now();
  async function run(button, task) {
    if (button?.disabled) return;
    const label = button?.textContent;
    if (button) { button.disabled = true; button.textContent = L("adminSaving"); }
    message.textContent = "";
    try { await task(); } catch (error) { message.textContent = error.message; } finally {
      if (button?.isConnected) { button.disabled = false; button.textContent = label; }
    }
  }
  async function load() {
    if (loading) return loading;
    $("#servicesRetry").hidden = true;
    if (!state) message.textContent = L("adminKitsLoading");
    loading = (async () => {
      try {
        state = await call("/api/admin/store");
        message.textContent = notice; notice = "";
        render();
      } catch (error) {
        $("#servicesRetry").hidden = false;
        throw error;
      } finally { loading = undefined; }
    })();
    return loading;
  }
  // `done` is the line to show, or a function that also picks what to show next.
  async function save(path, input, done) {
    state = await call("/api/admin/store/" + path, { method: "POST", body: JSON.stringify(input) });
    const line = typeof done === "function" ? done() : done;
    render();
    // A sentence ending in a short name ("… Amina N.") keeps one full stop.
    message.textContent = (line || "").replace(/\.\.$/, ".");
  }
  // The tab from the address (#services/installs), kept when it changes.
  function show(param = "") {
    if (TABS.includes(param)) tab = param;
    if (!state) return run(null, load);
    render();
  }
  function pick(next) {
    tab = next;
    message.textContent = "";
    history.replaceState(null, "", "#services" + (next === "kits" ? "" : "/" + next));
    render();
    tabsHost.querySelector(`[data-services-tab="${next}"]`)?.focus();
  }

  function render() {
    if (!state) return;
    renderTabs();
    content.innerHTML = tab === "installs" ? installsView() : tab === "plans" ? plansView() : kitsView();
    if (tab === "installs") wireInstalls(); else if (tab === "plans") wirePlans(); else wireKits();
  }
  // The head's tabs, with Installations' jobs today and Payment plans' late count.
  function renderTabs() {
    const badges = { installs: todayOpenJobs(state, now()), plans: state.plans?.metrics?.late || 0 };
    tabsHost.innerHTML = `<div class="admin-kits__tabs" role="tablist" aria-label="${h(L("adminKitsSection"))}">${TABS.map((id) =>
      `<button type="button" role="tab" class="admin-kits__tab" data-services-tab="${id}" aria-selected="${id === tab}" tabindex="${id === tab ? 0 : -1}">${h(L("adminKitsTab_" + id))}${badges[id] ? ` <span class="admin-kits__badge">${badges[id]}</span>` : ""}</button>`).join("")}</div>`;
    tabsHost.querySelectorAll("[data-services-tab]").forEach((b) => {
      b.onclick = () => pick(b.dataset.servicesTab);
      b.onkeydown = (e) => {
        const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
        if (step) { e.preventDefault(); pick(TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]); }
      };
    });
  }

  // ---------- Kits ----------
  const listed = () => state.kits.filter((k) => k.status !== "archived").sort((a, b) => (a.status === "on_sale" ? 0 : 1) - (b.status === "on_sale" ? 0 : 1));
  const routers = () => state.products.filter((p) => p.status !== "archived");
  const bundleOf = (id) => (state.kitBundles || []).find((b) => b.id === id);
  // "AX1500 + Home WISP Unlimited first month · 50,000 FCFA · 14 sold this month";
  // a draft names its parts only, as drawn.
  function kitSummary(k) {
    const bundle = k.firstBundle, parts = k.items.map((item) => productCode(item)).filter(Boolean);
    if (bundle) parts.push(validityDays(bundle) === 30 ? L("adminKitsFirstMonth", { name: named(bundle.name) }) : named(bundle.name));
    const line = parts.join(" + ");
    return k.status === "on_sale" ? [line, fcfa(k.price), L("adminKitsSold", { count: k.soldThisMonth || 0 })].join(" · ") : line;
  }
  function kitsView() {
    const kits = listed();
    if (kitId !== "new" && !kits.some((k) => k.id === kitId)) kitId = kits[0]?.id || "new";
    const k = kits.find((x) => x.id === kitId);
    return `<div class="admin-kits__split">
<section class="admin-kits__panel admin-kits__list" aria-labelledby="kitsListTitle"><h2 class="admin-kits__h2" id="kitsListTitle">${h(L("adminKitsOnSale"))}</h2>
  <div class="admin-kits__kits">${kits.length ? kits.map((x) => `<button type="button" class="admin-kits__kit" data-kit="${h(x.id)}" aria-pressed="${x.id === kitId}"><span class="admin-kits__kit-row"><strong>${h(named(x.name))}</strong>${pill(L("adminKitsPill_" + x.status), x.status === "on_sale" ? "success" : "neutral")}</span><span class="admin-kits__kit-line">${h(kitSummary(x))}</span></button>`).join("") : `<p class="nd-meta">${h(L("adminKitsNone"))}</p>`}</div>
  <button type="button" class="admin-kits__go admin-kits__start" id="kitNew">${h(L("adminKitsNew"))}</button>
</section>
${kitForm(k)}
</div>`;
  }
  function kitForm(k) {
    const item = k?.items?.[0], bundles = state.kitBundles || [], products = routers();
    const homeWisp = bundles.find((b) => b.accessType === "home_wisp_unlimited");
    const chosenBundle = k?.firstBundleId || homeWisp?.id || bundles[0]?.id || "";
    const status = k ? k.status === "draft" ? `<button type="button" class="admin-kits__go2" data-kit-status="on_sale">${h(L("adminKitsPutOnSale"))}</button>`
      : `<button type="button" class="admin-kits__go2" data-kit-status="draft">${h(L("adminKitsToDraft"))}</button><button type="button" class="admin-kits__go2" data-kit-status="archived">${h(L("adminKitsArchive"))}</button>` : "";
    const check = (name, on, label, hint) => `<label class="admin-kits__check"><input type="checkbox" name="${name}" ${on ? "checked" : ""}><span>${label}${hint || ""}</span></label>`;
    return `<section class="admin-kits__panel admin-kits__edit" aria-labelledby="kitEditTitle"><h2 class="admin-kits__h2" id="kitEditTitle">${h(k ? L("adminKitsEdit", { name: named(k.name) }) : L("adminKitsNew"))}</h2>
<form id="kitForm" class="admin-kits__form" novalidate>
  <div class="admin-kits__grid">
    <div><label class="admin-kits__lbl" for="kitName">${h(L("adminKitsName"))}</label><input class="admin-kits__in" id="kitName" name="name" maxlength="120" required value="${h(named(k?.name))}"></div>
    <div><label class="admin-kits__lbl" for="kitRouter">${h(L("adminKitsRouter"))}</label><select class="admin-kits__in" id="kitRouter" name="router" required>${products.length ? products.map((p) => `<option value="${h(p.id)}" ${p.id === item?.productId ? "selected" : ""}>${h(L("adminKitsInStock", { name: productName(p), count: p.available ?? 0 }))}</option>`).join("") : `<option value="">${h(L("adminKitsNoProducts"))}</option>`}</select></div>
    <div><label class="admin-kits__lbl" for="kitBundle">${h(L("adminKitsFirstBundle"))}</label><select class="admin-kits__in" id="kitBundle" name="bundle" required>${bundles.length ? bundles.map((b) => `<option value="${h(b.id)}" ${b.id === chosenBundle ? "selected" : ""}>${h(bundleLabel(b))}</option>`).join("") : `<option value="">${h(L("adminKitsNoBundles"))}</option>`}</select></div>
    <div><label class="admin-kits__lbl" for="kitPrice">${h(L("adminKitsPrice"))}</label><input class="admin-kits__in" id="kitPrice" name="price" inputmode="numeric" value="${h(k?.price ?? "")}"><p class="admin-kits__saving" id="kitSaving" aria-live="polite"></p></div>
  </div>
  ${check("setUp", k ? k.setUp : true, `<strong>${h(L("adminKitsSetUp"))}</strong><br><span class="admin-kits__hint">${h(L("adminKitsSetUpHint"))}</span>`)}
  ${check("installation", k ? k.installation : true, `<strong>${h(L("adminKitsInstall"))}</strong> <span class="admin-kits__muted">${h(L("adminKitsInstallHint"))}</span>`)}
  ${check("payIn3", k ? k.payIn3 : true, `<strong>${h(L("adminKitsPayIn3"))}</strong>`)}
  <div class="admin-kits__actions"><button type="submit" class="admin-kits__go">${h(L("adminKitsSave"))}</button>${status}</div>
</form></section>`;
  }
  // "Bought separately" from the chosen router and bundle at today's prices; the
  // saving only when the kit costs less, as the shop shows it.
  function showSaving() {
    const form = $("#kitForm"), out = $("#kitSaving");
    if (!form || !out) return;
    const product = state.products.find((p) => p.id === form.router.value), bundle = bundleOf(form.bundle.value);
    const others = (state.kits.find((k) => k.id === kitId)?.items || []).slice(1);
    const parts = [product?.price, bundle?.price, ...others.map((item) => (Number.isSafeInteger(item.price) ? item.price * item.quantity : null))];
    if (parts.some((n) => !Number.isSafeInteger(n))) { out.textContent = ""; return; }
    const separately = parts.reduce((sum, n) => sum + n, 0), price = Number(form.price.value);
    const saving = Number.isSafeInteger(price) && price > 0 && price < separately ? separately - price : 0;
    out.textContent = saving ? L("adminKitsSeparately", { amount: fcfa(separately), saving: fcfa(saving) }) : L("adminKitsSeparatelyNoSaving", { amount: fcfa(separately) });
  }
  function wireKits() {
    content.querySelectorAll("[data-kit]").forEach((b) => (b.onclick = () => { kitId = b.dataset.kit; message.textContent = ""; render(); }));
    $("#kitNew").onclick = () => { kitId = "new"; message.textContent = ""; render(); $("#kitName").focus(); };
    const form = $("#kitForm");
    form.oninput = showSaving;
    showSaving();
    form.onsubmit = (e) => {
      e.preventDefault();
      const k = state.kits.find((x) => x.id === kitId), name = form.name.value.trim();
      const items = [{ productId: form.router.value, quantity: 1 }, ...(k?.items || []).slice(1).map((item) => ({ productId: item.productId, quantity: item.quantity }))];
      run(e.submitter, () => save("kits/save", {
        ...(k ? { id: k.id, version: k.version } : {}),
        // One name in both languages (owner, 27 Nov, #347).
        name: { en: name, fr: name }, description: k?.description || { en: "", fr: "" }, items, firstBundleId: form.bundle.value,
        price: form.price.value.trim() === "" ? null : Number(form.price.value), setUp: form.setUp.checked, installation: form.installation.checked, payIn3: form.payIn3.checked,
      }, () => {
        if (!k) kitId = state.kits.find((x) => named(x.name) === name && x.status === "draft")?.id || state.kits[0]?.id || "";
        return L("adminKitsSaved");
      }));
    };
    content.querySelectorAll("[data-kit-status]").forEach((b) => (b.onclick = () => {
      const k = state.kits.find((x) => x.id === kitId), status = b.dataset.kitStatus, name = named(k.name);
      if (status === "archived" && !confirm(L("adminKitsArchiveConfirm", { name }))) return;
      run(b, () => save("kits/status", { id: k.id, version: k.version, status },
        L(status === "on_sale" ? "adminKitsNowOnSale" : status === "draft" ? "adminKitsNowDraft" : "adminKitsArchived", { name })));
    }));
  }

  // ---------- Installations ----------
  // Today, then the next working days (Monday to Saturday): five pills, as drawn.
  function dayList() {
    const today = dayKey(now()), list = [today];
    for (let at = +noon(today) + DAY; list.length < 5; at += DAY) if (new Date(at).getUTCDay() !== 0) list.push(dayKey(at));
    return list;
  }
  const dayLabel = (key, today) => (key === today ? L("adminKitsToday", { day: pillDay(noon(key)) }) : pillDay(noon(key)));
  const techs = () => state.installations?.settings?.technicians || [];
  function jobAction(o, today) {
    const b = o.installation;
    if (["installed", "not_installed"].includes(b.status)) return `<button type="button" class="admin-kits__go2" data-job-report="${h(o.id)}" aria-expanded="${report === o.id}">${h(L("adminKitsViewReport"))}</button>`;
    if (!OPEN_JOB.includes(b.status)) return "";
    // On the visit day a booked job starts with "On the way" (owner, 27 Nov, #347).
    if (b.day === today && b.status !== "on_the_way") return `<button type="button" class="admin-kits__go2" data-job-way="${h(o.id)}">${h(L("adminKitsOnTheWay"))}</button>`;
    return `<button type="button" class="admin-kits__go2" data-job-done="${h(o.id)}" aria-expanded="${openJob === o.id}">${h(L("adminKitsDone"))}</button>`;
  }
  function jobRow(o, today) {
    const b = o.installation, who = shortName(o.contact?.name), device = [named(o.kit?.name || o.product?.name), productCode(o.kit?.items?.[0])].filter(Boolean).join(" · ");
    const person = o.customerId ? `<a class="admin-kits__who" href="/dashboard#customer/${encodeURIComponent(o.customerId)}">${h(who)}</a>` : `<strong>${h(who)}</strong>`;
    const tech = `<select class="admin-kits__in admin-kits__tech" data-job-tech="${h(o.id)}" aria-label="${h(L("adminKitsTechFor", { name: who }))}" ${OPEN_JOB.includes(b.status) ? "" : "disabled"}>${b.technicianId ? "" : `<option value="">${h(L("adminKitsChooseTech"))}</option>`}${techs().map((t) => `<option value="${h(t.id)}" ${t.id === b.technicianId ? "selected" : ""}>${h(t.name)}</option>`).join("")}</select>`;
    return `<tr><td>${h(L("adminKitsSlot_" + b.slot))}</td><td>${person}<br><span class="admin-kits__small">${h(maskPhone(b.phone))}</span></td><td>${h(b.area?.name || "")}<br><span class="admin-kits__small">${h(b.directions || "")}</span></td><td>${h(device)}</td><td>${tech}</td><td>${pill(L("adminKitsJob_" + b.status), JOB_TONE[b.status] || "neutral")}</td><td>${jobAction(o, today)}</td></tr>`;
  }
  function doneForm(o) {
    return `<form class="admin-kits__done" id="jobDone" data-job="${h(o.id)}" novalidate>
  <div class="admin-kits__field"><label class="admin-kits__lbl" for="jobSignal">${h(L("adminKitsSignal"))}</label><input class="admin-kits__in" id="jobSignal" name="signal" maxlength="40" required></div>
  <div class="admin-kits__field"><label class="admin-kits__lbl" for="jobPhoto">${h(L("adminKitsPhoto"))}</label><input class="admin-kits__in admin-kits__file" id="jobPhoto" type="file" accept="image/png,image/jpeg,image/webp"></div>
  <button type="submit" class="admin-kits__go">${h(L("adminKitsMarkInstalled"))}</button>
  <button type="button" class="admin-kits__go2 admin-kits__go2--danger" data-job-not="${h(o.id)}">${h(L("adminKitsCouldnt"))}</button>
</form>`;
  }
  function reportView(o) {
    const b = o.installation, tech = techs().find((t) => t.id === b.technicianId)?.name || b.installedBy || "—";
    const text = b.status === "installed"
      ? L("adminKitsReportInstalled", { when: stamp(b.installedAt), who: tech, signal: b.signal || "—" })
      : L("adminKitsReportNot", { when: b.notInstalledAt ? stamp(b.notInstalledAt) : "", reason: b.reason || L("adminKitsReportNoReason"), amount: fcfa(b.price + b.travelFee) });
    const src = b.photo ? String(window.NDAHI_CONFIG?.apiUrl || "").replace(/\/$/, "") + b.photo : "";
    return `<div class="admin-kits__report" id="jobReport"><p>${h(text)}</p>${src ? `<a href="${h(src)}" target="_blank" rel="noopener"><img src="${h(src)}" alt="${h(L("adminKitsReportPhoto"))}" class="admin-kits__photo" loading="lazy"></a>` : ""}</div>`;
  }
  function settingsPanel() {
    const c = state.installations?.settings || {}, areas = c.areas?.length ? c.areas : [{}], people = c.technicians?.length ? c.technicians : [{}];
    const open = Number.isSafeInteger(c.price) && c.areas?.length && (c.capacity?.morning || 0) + (c.capacity?.afternoon || 0) > 0;
    const remove = (kind, n) => `<button type="button" class="admin-kits__go2" data-remove-${kind}="${n}" aria-label="${h(L(kind === "area" ? "adminKitsRemoveArea" : "adminKitsRemoveTech", { n: n + 1 }))}">${h(L("adminKitsRemove"))}</button>`;
    return `<section class="admin-kits__panel" aria-labelledby="installSettingsTitle"><h2 class="admin-kits__h2" id="installSettingsTitle">${h(L("adminKitsSettings"))}</h2>
${open ? "" : `<p class="admin-kits__note">${h(L("adminKitsSettingsClosed"))}</p>`}
<form id="installSettings" class="admin-kits__form" novalidate>
  <div class="admin-kits__grid">
    <div><label class="admin-kits__lbl" for="installPrice">${h(L("adminKitsInstallPrice"))}</label><input class="admin-kits__in" id="installPrice" name="price" inputmode="numeric" value="${h(c.price ?? "")}"></div>
    <div><label class="admin-kits__lbl" for="installMorning">${h(L("adminKitsCapMorning"))}</label><input class="admin-kits__in" id="installMorning" name="morning" type="number" min="0" max="20" value="${h(c.capacity?.morning ?? 0)}"></div>
    <div><label class="admin-kits__lbl" for="installAfternoon">${h(L("adminKitsCapAfternoon"))}</label><input class="admin-kits__in" id="installAfternoon" name="afternoon" type="number" min="0" max="20" value="${h(c.capacity?.afternoon ?? 0)}"></div>
  </div>
  <fieldset class="admin-kits__set"><legend class="admin-kits__lbl">${h(L("adminKitsAreas"))}</legend>
    ${areas.map((a, n) => `<div class="admin-kits__row" data-area-row="${n}" data-id="${h(a.id || "")}"><div><label class="admin-kits__lbl" for="areaName${n}">${h(L("adminKitsAreaName"))}</label><input class="admin-kits__in" id="areaName${n}" name="areaName" maxlength="80" value="${h(a.name || "")}"></div><div><label class="admin-kits__lbl" for="areaTown${n}">${h(L("adminKitsAreaTown"))}</label><input class="admin-kits__in" id="areaTown${n}" name="areaTown" maxlength="80" value="${h(a.town || "")}"></div><div><label class="admin-kits__lbl" for="areaFee${n}">${h(L("adminKitsAreaFee"))}</label><input class="admin-kits__in" id="areaFee${n}" name="areaFee" inputmode="numeric" value="${h(a.travelFee ?? "")}"></div>${remove("area", n)}</div>`).join("")}
    <button type="button" class="admin-kits__go2 admin-kits__start" id="addArea">${h(L("adminKitsAddArea"))}</button>
  </fieldset>
  <fieldset class="admin-kits__set"><legend class="admin-kits__lbl">${h(L("adminKitsTechnicians"))}</legend>
    ${people.map((t, n) => `<div class="admin-kits__row admin-kits__row--tech" data-tech-row="${n}" data-id="${h(t.id || "")}"><div><label class="admin-kits__lbl" for="techName${n}">${h(L("adminKitsTechName"))}</label><input class="admin-kits__in" id="techName${n}" name="techName" maxlength="80" value="${h(t.name || "")}"></div>${remove("tech", n)}</div>`).join("")}
    <button type="button" class="admin-kits__go2 admin-kits__start" id="addTech">${h(L("adminKitsAddTech"))}</button>
  </fieldset>
  <div class="admin-kits__actions"><button type="submit" class="admin-kits__go">${h(L("adminKitsSaveSettings"))}</button></div>
</form></section>`;
  }
  function installsView() {
    const today = dayKey(now()), list = dayList(), all = jobs(state);
    if (!list.includes(day)) day = today;
    const c = state.installations?.settings || {}, onDay = all.filter((o) => o.installation.day === day)
      .sort((a, b) => (a.installation.slot === b.installation.slot ? Date.parse(a.createdAt) - Date.parse(b.createdAt) : a.installation.slot === "morning" ? -1 : 1));
    const count = (key) => all.filter((o) => o.installation.day === key).length;
    const chosen = onDay.find((o) => o.id === openJob && OPEN_JOB.includes(o.installation.status)), shown = onDay.find((o) => o.id === report);
    return `<div class="admin-kits__days" role="group" aria-label="${h(L("adminKitsDayGroup"))}">${list.map((key) => {
      const n = count(key);
      return `<button type="button" class="admin-kits__day" data-day="${key}" aria-pressed="${key === day}">${h(dayLabel(key, today))} · ${h(n === 1 ? L("adminKitsJob") : L("adminKitsJobs", { count: n }))}</button>`;
    }).join("")}</div>
<section class="admin-kits__panel admin-kits__panel--table" aria-labelledby="jobsTitle">
  <div class="admin-kits__head"><h2 class="admin-kits__h2" id="jobsTitle">${h(L("adminKitsJobsOn", { day: dayLabel(day, today) }))}</h2><span class="admin-kits__muted admin-kits__cap">${h(L("adminKitsCapacity", { morning: c.capacity?.morning || 0, afternoon: c.capacity?.afternoon || 0, technicians: techs().length }))}</span></div>
  <div class="admin-kits__scroll"><table class="admin-kits__table"><thead><tr><th scope="col">${h(L("adminKitsColSlot"))}</th><th scope="col">${h(L("adminKitsColCustomer"))}</th><th scope="col">${h(L("adminKitsColArea"))}</th><th scope="col">${h(L("adminKitsColDevice"))}</th><th scope="col">${h(L("adminKitsColTech"))}</th><th scope="col">${h(L("adminKitsColStatus"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminKitsColAction"))}</span></th></tr></thead>
  <tbody>${onDay.length ? onDay.map((o) => jobRow(o, today)).join("") : `<tr><td colspan="7" class="admin-kits__empty">${h(L("adminKitsNoJobs"))}</td></tr>`}</tbody></table></div>
  ${chosen ? doneForm(chosen) : shown ? reportView(shown) : ""}
  <p class="admin-kits__note admin-kits__note--foot">${h(L("adminKitsNote"))}</p>
</section>
${settingsPanel()}`;
  }
  const job = (id) => state.orders.find((o) => o.id === id);
  const updateJob = (button, o, input, done) => run(button, () => save("installations/update", { id: o.id, version: o.version, ...input }, done));
  function wireInstalls() {
    content.querySelectorAll("[data-day]").forEach((b) => (b.onclick = () => { day = b.dataset.day; openJob = ""; report = ""; render(); }));
    content.querySelectorAll("[data-job-tech]").forEach((select) => (select.onchange = () => {
      const o = job(select.dataset.jobTech);
      updateJob(null, o, { action: "assign", technicianId: select.value || null });
    }));
    content.querySelectorAll("[data-job-way]").forEach((b) => (b.onclick = () => updateJob(b, job(b.dataset.jobWay), { action: "on_the_way" })));
    content.querySelectorAll("[data-job-done]").forEach((b) => (b.onclick = () => {
      openJob = openJob === b.dataset.jobDone ? "" : b.dataset.jobDone; report = ""; photo = null; render();
      $("#jobSignal")?.focus();
    }));
    content.querySelectorAll("[data-job-report]").forEach((b) => (b.onclick = () => { report = report === b.dataset.jobReport ? "" : b.dataset.jobReport; openJob = ""; render(); }));
    const done = $("#jobDone");
    if (done) {
      $("#jobPhoto").onchange = (e) => run(null, async () => {
        photo = null;
        const file = e.target.files[0];
        if (!file) return;
        if (!["image/png", "image/jpeg", "image/webp"].includes(file.type) || file.size > 8e6) throw Error(L("adminKitsBadPhoto"));
        // Resized as on Edit product: up to 960 px, WebP, under the API's limit.
        const bitmap = await createImageBitmap(file), scale = Math.min(1, 960 / Math.max(bitmap.width, bitmap.height)), canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        let data = canvas.toDataURL("image/webp", 0.8);
        if (data.length > 230000) data = canvas.toDataURL("image/webp", 0.4);
        if (data.length > 230000) throw Error(L("adminKitsPhotoTooDetailed"));
        message.textContent = L("adminKitsUploading");
        photo = (await call("/api/admin/store/photos", { method: "POST", body: JSON.stringify({ data }) })).photo.id;
        message.textContent = "";
      });
      done.onsubmit = (e) => {
        e.preventDefault();
        const o = job(done.dataset.job);
        updateJob(e.submitter, o, { action: "installed", signal: done.signal.value.trim(), ...(photo ? { photoId: photo } : {}) }, () => { openJob = ""; report = o.id; photo = null; return L("adminKitsInstalledSaved"); });
      };
      done.querySelector("[data-job-not]").onclick = (e) => {
        const o = job(done.dataset.job), b = o.installation;
        const reason = prompt(L("adminKitsCouldntReason", { amount: fcfa(b.price + b.travelFee) }));
        if (reason === null) return;
        updateJob(e.currentTarget, o, { action: "not_installed", reason: reason.trim() }, () => { openJob = ""; report = o.id; return L("adminKitsNotInstalledSaved"); });
      };
    }
    wireSettings();
  }
  // `keep`: blank rows stay while staff add or remove rows; saving drops them.
  function settingsInput(form, keep = false) {
    const rows = (kind) => [...form.querySelectorAll(`[data-${kind}-row]`)];
    return {
      price: form.price.value.trim() === "" ? null : Number(form.price.value),
      capacity: { morning: Number(form.morning.value), afternoon: Number(form.afternoon.value) },
      areas: rows("area").map((row) => ({ id: row.dataset.id || undefined, name: row.querySelector("[name=areaName]").value.trim(), town: row.querySelector("[name=areaTown]").value.trim(),
        travelFee: Number(row.querySelector("[name=areaFee]").value || 0) })).filter((a) => keep || a.name || a.town),
      technicians: rows("tech").map((row) => ({ id: row.dataset.id || undefined, name: row.querySelector("[name=techName]").value.trim() })).filter((t) => keep || t.name),
    };
  }
  function wireSettings() {
    const form = $("#installSettings");
    // Adding or removing a row keeps what was typed in the others.
    const redraw = (change) => {
      const input = settingsInput(form, true);
      change(input);
      state.installations.settings = { ...state.installations.settings, ...input };
      render();
    };
    $("#addArea").onclick = () => { redraw((i) => i.areas.push({ name: "", town: "", travelFee: "" })); $("#areaName" + (state.installations.settings.areas.length - 1))?.focus(); };
    $("#addTech").onclick = () => { redraw((i) => i.technicians.push({ name: "" })); $("#techName" + (state.installations.settings.technicians.length - 1))?.focus(); };
    form.querySelectorAll("[data-remove-area]").forEach((b) => (b.onclick = () => redraw((i) => i.areas.splice(Number(b.dataset.removeArea), 1))));
    form.querySelectorAll("[data-remove-tech]").forEach((b) => (b.onclick = () => redraw((i) => i.technicians.splice(Number(b.dataset.removeTech), 1))));
    form.onsubmit = (e) => {
      e.preventDefault();
      const input = settingsInput(form);
      run(e.submitter, () => save("installations/settings", input, L("adminKitsSettingsSaved")));
    };
  }

  // ---------- Payment plans ----------
  const unpaidOf = (plan) => plan.payments.filter((p) => !p.paidAt);
  // Running plans (newest first, as drawn), paid ones until handed over, and
  // cancellations of the last 30 days.
  function plansListed() {
    const recent = now() - 30 * DAY;
    const rank = (o) => (o.plan.status === "running" ? 0 : o.plan.status === "completed" ? 1 : 2);
    return state.orders.filter((o) => o.plan && o.kind !== "plan_payment" && (o.plan.status === "running" || (o.plan.status === "completed" && o.status !== "collected")
      || (o.plan.status === "cancelled" && Date.parse(o.plan.cancelledAt || o.createdAt) >= recent)))
      .sort((a, b) => rank(a) - rank(b) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }
  function planRow(o) {
    const plan = o.plan, next = unpaidOf(plan)[0], paid = plan.payments.filter((p) => p.paidAt).reduce((sum, p) => sum + p.amount, 0);
    const percent = plan.price ? Math.round((paid / plan.price) * 100) : 0, who = shortName(o.contact?.name);
    let status, actions = "";
    if (plan.status === "running" && plan.late && next) {
      const late = Math.max(1, Math.floor((now() - Date.parse(next.dueAt)) / DAY));
      status = pill(late === 1 ? L("adminKitsPlanLateOne") : L("adminKitsPlanLate", { count: late }), "danger");
      // "Extended to 24 Nov": the date due plus the extra days given.
      const extended = plan.extension ? L("adminKitsExtended", { day: new Date(Date.parse(next.dueAt) + plan.extension.days * DAY).toLocaleDateString(locale(), { day: "numeric", month: "short", timeZone: ZONE }) }) : "";
      actions = `<button type="button" class="admin-kits__go2" data-plan-extend="${h(o.id)}" ${plan.extension ? "disabled" : ""}>${h(extended || L("adminKitsExtend", { count: plan.rules?.grace || 7 }))}</button>${role === "owner" ? `<button type="button" class="admin-kits__go2 admin-kits__go2--danger" data-plan-cancel="${h(o.id)}">${h(L("adminKitsCancelRefund"))}</button>` : ""}`;
    } else if (plan.status === "running") {
      status = pill(L("adminKitsPlan_on_track"), "success");
      actions = `<button type="button" class="admin-kits__go2" data-plan-remind="${h(o.id)}">${h(L("adminKitsRemind"))}</button>`;
    } else if (plan.status === "completed") status = pill(L("adminKitsPlan_paid"), "info");
    else status = pill(L("adminKitsPlan_cancelled"), "neutral");
    return `<tr><td><strong>${h(who)}</strong></td><td>${h(named(o.kit?.name || o.product?.name))}</td><td>${percent}%</td><td>${h(plan.status === "running" && next ? shortDate(next.dueAt) : "—")}</td><td>${status}</td><td${actions && plan.late ? ' class="admin-kits__cell-actions"' : ""}>${actions}</td></tr>`;
  }
  function plansView() {
    const m = state.plans?.metrics || {}, rules = state.plans?.rules || {}, list = plansListed(), owner = role === "owner";
    const select = (id, name, options, value, label) => `<div><label class="admin-kits__lbl" for="${id}">${h(L(label))}</label><select class="admin-kits__in" id="${id}" name="${name}" ${owner ? "" : "disabled"}>${options.map(([v, text]) => `<option value="${v}" ${v === value ? "selected" : ""}>${h(text)}</option>`).join("")}</select></div>`;
    return `<div class="admin-kits__metrics">
  <div class="admin-kits__panel admin-kits__metric"><b>${h(String(m.running ?? 0))}</b><span>${h(L("adminKitsMetricRunning"))}</span></div>
  <div class="admin-kits__panel admin-kits__metric"><b>${h(fcfa(m.stillToPay ?? 0))}</b><span>${h(L("adminKitsMetricToPay"))}</span></div>
  <div class="admin-kits__panel admin-kits__metric"><b>${h(String(m.late ?? 0))}</b><span>${h(L("adminKitsMetricLate"))}</span></div>
  <div class="admin-kits__panel admin-kits__metric"><b>${m.completionRate == null ? "—" : h(m.completionRate + "%")}</b><span>${h(L("adminKitsMetricDone"))}</span></div>
</div>
<section class="admin-kits__panel admin-kits__panel--table" aria-labelledby="plansTitle"><h2 class="admin-kits__h2" id="plansTitle">${h(L("adminKitsPlans"))}</h2>
  <div class="admin-kits__scroll"><table class="admin-kits__table"><thead><tr><th scope="col">${h(L("adminKitsColCustomer"))}</th><th scope="col">${h(L("adminKitsColItem"))}</th><th scope="col">${h(L("adminKitsColPaid"))}</th><th scope="col">${h(L("adminKitsColNext"))}</th><th scope="col">${h(L("adminKitsColStatus"))}</th><th scope="col"><span class="nd-visually-hidden">${h(L("adminKitsColAction"))}</span></th></tr></thead>
  <tbody>${list.length ? list.map(planRow).join("") : `<tr><td colspan="6" class="admin-kits__empty">${h(L("adminKitsNoPlans"))}</td></tr>`}</tbody></table></div>
</section>
<section class="admin-kits__panel" aria-labelledby="planRulesTitle"><h2 class="admin-kits__h2" id="planRulesTitle">${h(L("adminKitsRules"))}</h2>
  <form id="planRules" class="admin-kits__grid" novalidate>
    ${select("ruleDeposit", "depositPct", DEPOSITS.map((n) => [n, n + "%"]), rules.depositPct ?? 40, "adminKitsDeposit")}
    ${select("ruleDays", "days", PERIODS.map((n) => [n, L("adminKitsDays", { count: n })]), rules.days ?? 30, "adminKitsWithin")}
    ${select("ruleGrace", "grace", GRACES.map((n) => [n, L("adminKitsDays", { count: n })]), rules.grace ?? 7, "adminKitsGrace")}
    <div><label class="admin-kits__lbl" for="ruleFrom">${h(L("adminKitsFrom"))}</label><input class="admin-kits__in" id="ruleFrom" name="minPrice" inputmode="numeric" value="${h(rules.minPrice ?? "")}" ${owner ? "" : "disabled"}></div>
  </form>
  <p class="admin-kits__note">${h(L("adminKitsRulesNote"))}${owner ? "" : " " + h(L("adminKitsRulesOwner"))}</p>
</section>`;
  }
  function wirePlans() {
    const plan = (id) => state.orders.find((o) => o.id === id);
    content.querySelectorAll("[data-plan-remind]").forEach((b) => (b.onclick = () => {
      const o = plan(b.dataset.planRemind);
      run(b, () => save("plans/update", { id: o.id, version: o.version, action: "remind" }, L("adminKitsReminded", { name: shortName(o.contact?.name) })));
    }));
    content.querySelectorAll("[data-plan-extend]").forEach((b) => (b.onclick = () => {
      const o = plan(b.dataset.planExtend);
      run(b, () => save("plans/update", { id: o.id, version: o.version, action: "extend" }));
    }));
    content.querySelectorAll("[data-plan-cancel]").forEach((b) => (b.onclick = () => {
      // What comes back: the plan's payments, and the visit if it is still booked.
      const o = plan(b.dataset.planCancel), visit = o.installation && OPEN_JOB.includes(o.installation.status) ? o.installation.price + o.installation.travelFee : 0;
      const paid = o.plan.payments.filter((p) => p.paidAt).reduce((sum, p) => sum + p.amount, 0) + visit;
      const name = shortName(o.contact?.name);
      if (!confirm(L("adminKitsCancelConfirm", { name, amount: fcfa(paid) }))) return;
      run(b, () => save("plans/update", { id: o.id, version: o.version, action: "cancel" }, L("adminKitsCancelled", { name, amount: fcfa(paid) })));
    }));
    // No Save button on the board: each change saves at once (owner).
    const form = $("#planRules");
    form.onchange = () => run(null, () => save("plans/rules", {
      depositPct: Number(form.depositPct.value), days: Number(form.days.value), grace: Number(form.grace.value),
      minPrice: form.minPrice.value.trim() === "" ? null : Number(form.minPrice.value),
    }, L("adminKitsRulesSaved")));
  }

  $("#servicesRetry").onclick = (e) => run(e.currentTarget, load);
  return { show, load };
}
