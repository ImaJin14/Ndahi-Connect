// Edit bundle and Add bundle (canvas: AdminBundleEdit, #339) for the Unlimited
// catalogue. #bundle/<id> edits a bundle; #bundle/new?accessType=…&validityValue=…
// &validityUnit=…&deviceSlots=… adds one (the catalogue's "Not offered" cells).
// The client mirrors the server's rules so Save waits for valid terms, but the
// catalogue API decides (lib/catalogue.mjs) and audits every change; orders
// and vouchers keep the terms they were sold with. Owner decisions on the
// speed note, the display order hint and the never-bought case:
// https://github.com/ImaJin14/Ndahi-Connect/issues/339#issuecomment-7145743743
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { validityLabel } from "/bundle-catalogue.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const number = (n) => Number(n).toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-US");
const PERSONAL = "personal_unlimited", HOME = "home_wisp_unlimited";
const PRICE = /^[1-9]\d{0,8}$/, WHOLE = /^\d+$/, MBPS = /^\d+(?:\.\d{1,3})?$/;
const devices = (n) => (n === 1 ? L("adminCatOneDevice") : L("adminCatDevices", { count: n }));
const STATUS = { published: ["adminCatPublished", "admin-cat__pill--published"], unpublished: ["adminCatUnpublished", "admin-cat__pill--unpublished"], archived: ["adminCatArchived", "admin-cat__pill--archived"] };

// The state of the form, and what follows from it.
function derive(f) {
  const v = Number(f.validityValue), hours = f.validityUnit === "days" ? v * 24 : v, n = Number(f.slots), home = f.type === HOME;
  const validity = WHOLE.test(String(f.validityValue).trim()) ? validityLabel({ validityValue: v, validityUnit: f.validityUnit }) : "";
  const bad = {
    price: !PRICE.test(String(f.price).trim()),
    validity: !WHOLE.test(String(f.validityValue).trim()) || hours < 1 || hours > 8760,
    slots: !home && (!WHOLE.test(String(f.slots).trim()) || n < 1 || n > 10),
    name: !String(f.name).trim() || String(f.name).length > 80,
    position: String(f.position).trim() !== "" && (!WHOLE.test(String(f.position).trim()) || Number(f.position) < 1),
    speed: [f.download, f.upload].some((x) => String(x).trim() !== "" && (!MBPS.test(String(x).trim()) || Number(x) <= 0 || Number(x) > 10000)),
  };
  const typeName = L(home ? "adminCatHome" : "adminCatPersonal");
  const suggested = [typeName, validity || "—", ...(home ? [] : [devices(WHOLE.test(String(f.slots)) ? n : 0)])].join(" · ");
  const speed = !bad.speed && String(f.download).trim() !== "" ? L("adminUpToMbps", { speed: number(f.download) }) : "";
  const line = [L("adminEditUnlimitedData"), validity || "—", home ? L("adminCatHouseholdSharing") : (n === 1 ? L("adminEditRegisteredOne") : L("adminEditRegistered", { count: WHOLE.test(String(f.slots)) ? n : 0 })), speed].filter(Boolean).join(" · ");
  return { bad, invalid: Object.values(bad).some(Boolean), suggested, line, home, priceShown: bad.price ? "— XAF" : `${number(f.price)} XAF` };
}

export function mountBundleEdit(host, { call, setHead, statusHost, speedLimitsOn }) {
  let data = null, b = null, f = null, isNew = false, saved = "", error = "", busy = false, flash = "";
  // A new bundle's empty fields aren't errors until they have been used.
  const FIELD = { price: "price", validityValue: "validity", slots: "slots", position: "position", download: "speed", upload: "speed" };
  const shown = (d, key) => d.bad[key] && (!isNew || f.touched.has(key));
  const rows = () => [...(data?.bundles || []), ...(data?.legacy || [])].sort((a, b2) => a.displayOrder - b2.displayOrder);
  const titleOf = () => {
    if (isNew) return derive(f).suggested;
    // As the suggested name reads: "Home WISP Unlimited · 30 days", "Personal Unlimited · 7 days · 2 devices".
    const terms = b.accessType === HOME ? validityLabel(b) : `${validityLabel(b)} · ${devices(b.deviceSlots)}`, name = b.name.includes(terms) ? b.name : `${b.name} · ${terms}`;
    return b.status === "archived" ? name + L("adminEditArchivedSuffix") : name;
  };

  function head() {
    setHead({ title: titleOf() });
    const heading = document.getElementById("adminTitle");
    heading?.classList.add("admin-title--sub");
    heading?.parentElement?.classList.add("admin-head-title--inline");
    if (statusHost && heading && statusHost.previousElementSibling !== heading) heading.after(statusHost);
    const status = isNew ? f.pub : b.status;
    if (statusHost) statusHost.innerHTML = `<span class="admin-cat__pill admin-cat__pill--head ${STATUS[status][1]}">${h(L(STATUS[status][0]))}</span>`;
  }

  function render() {
    const d = derive(f), archived = !isNew && b.status === "archived";
    const radio = (id, label, hint) => `<button type="button" role="radio" class="admin-edit__type" data-edit-type="${id}" aria-checked="${f.type === id}"><span class="admin-edit__dot" aria-hidden="true"></span><span><strong>${h(L(label))}</strong><span>${h(L(hint))}</span></span></button>`;
    const seg = (name, id, label, on) => `<button type="button" role="radio" class="admin-edit__seg-btn" data-edit-${name}="${id}" aria-checked="${on}">${h(L(label))}</button>`;
    const err = (key, text) => `<p class="admin-edit__err" id="editErr-${key}" role="alert"${shown(d, key) ? "" : " hidden"}>${h(L(text))}</p>`;
    const inUse = !isNew && b.inUse;
    const removeText = inUse
      ? h(L("adminEditArchiveText", { orders: "\u0001", active: "\u0002", archived: "\u0003" }))
        .replace("\u0001", `<strong>${h(L(b.orders === 1 ? "adminEditOrdersOne" : "adminEditOrders", { count: b.orders }))}</strong>`)
        .replace("\u0002", `<strong>${h(L(b.active === 1 ? "adminCatActiveOne" : "adminCatActive", { count: b.active }))}</strong>`)
        .replace("\u0003", `<strong>${h(L("adminEditArchivedWord"))}</strong>`)
      : h(L("adminCatDeleteBody"));
    host.innerHTML = `<div class="admin-edit">
<div class="admin-edit__main">
  <fieldset class="admin-edit__fields"${archived ? " disabled" : ""}>
  <section class="nd-panel admin-edit__panel" aria-labelledby="editType"><h2 class="admin-edit__h2" id="editType">${h(L("adminEditAccessType"))}</h2>
    <div class="admin-edit__types" role="radiogroup" aria-label="${h(L("adminEditAccessType"))}">${radio(PERSONAL, "adminCatPersonal", "adminEditPersonalHint")}${radio(HOME, "adminCatHome", "adminEditHomeHint")}</div>
    <p class="admin-edit__hint admin-edit__hint--flat">${h(L("adminEditTypeNote"))}</p>
  </section>
  <section class="nd-panel admin-edit__panel" aria-labelledby="editTerms"><h2 class="admin-edit__h2" id="editTerms">${h(L("adminEditTerms"))}</h2>
    <div><label class="admin-edit__lbl" for="editName">${h(L("adminEditName"))}</label><input class="admin-edit__in" id="editName" name="name" maxlength="80" value="${h(f.name)}" autocomplete="off">
      <p class="admin-edit__hint" id="editSuggested">${h(L("adminEditSuggested", { name: d.suggested }))}</p></div>
    <div class="admin-edit__grid">
      <div><label class="admin-edit__lbl" for="editPrice">${h(L("adminEditPrice"))}</label><input class="admin-edit__in${shown(d, "price") ? " admin-edit__in--bad" : ""}" id="editPrice" name="price" inputmode="numeric" value="${h(f.price)}" autocomplete="off">${err("price", "adminEditPriceError")}</div>
      <div><span class="admin-edit__lbl" id="editValidityLabel">${h(L("adminEditValidity"))}</span>
        <div class="admin-edit__validity" role="group" aria-labelledby="editValidityLabel"><input class="admin-edit__in${shown(d, "validity") ? " admin-edit__in--bad" : ""}" id="editValidity" name="validityValue" aria-label="${h(L("adminEditValidityAmount"))}" inputmode="numeric" value="${h(f.validityValue)}" autocomplete="off">
          <div class="admin-edit__seg" role="radiogroup" aria-label="${h(L("adminEditUnit"))}">${seg("unit", "hours", "adminEditHours", f.validityUnit === "hours")}${seg("unit", "days", "adminEditDays", f.validityUnit === "days")}</div></div>
        ${err("validity", "adminEditValidityError")}<p class="admin-edit__hint">${h(L("adminEditValidityHint"))}</p></div>
    </div>
    ${d.home ? `<div><span class="admin-edit__lbl">${h(L("adminEditRouter"))}</span><div class="admin-edit__lock">${h(L("adminEditRouterLock"))}</div></div>`
      : `<div><span class="admin-edit__lbl" id="editSlotsLabel">${h(L("adminEditSlots"))}</span>
      <div class="admin-edit__chips" role="group" aria-labelledby="editSlotsLabel">${[1, 2, 3, 4, 5, 6].map((n) => `<button type="button" class="admin-edit__chip" data-edit-slots="${n}" aria-pressed="${String(f.slots).trim() === String(n)}">${n}</button>`).join("")}
        <span class="admin-edit__or">${h(L("adminEditOr"))}</span><input class="admin-edit__in admin-edit__in--slots${shown(d, "slots") ? " admin-edit__in--bad" : ""}" id="editSlots" name="slots" aria-label="${h(L("adminEditOtherSlots"))}" inputmode="numeric" value="${h(f.slots)}" autocomplete="off"></div>
      ${err("slots", "adminEditSlotsError")}<p class="admin-edit__hint">${h(L("adminEditSlotsHint"))}</p></div>`}
    <div><span class="admin-edit__lbl">${h(L("adminEditData"))}</span><div class="admin-edit__lock">${h(L("adminBundleUnlimited"))}</div></div>
  </section>
  <section class="nd-panel admin-edit__panel" aria-labelledby="editSale"><h2 class="admin-edit__h2" id="editSale">${h(L("adminEditOnSale"))}</h2>
    <div class="admin-edit__grid admin-edit__grid--start">
      <div><label class="admin-edit__lbl" for="editPosition">${h(L("adminEditDisplayOrder"))}</label><input class="admin-edit__in${shown(d, "position") ? " admin-edit__in--bad" : ""}" id="editPosition" name="position" inputmode="numeric" value="${h(f.position)}" autocomplete="off">
        ${err("position", "adminEditPositionError")}<p class="admin-edit__hint">${h(L("adminEditDisplayOrderHint"))}</p></div>
      <div><span class="admin-edit__lbl" id="editPubLabel">${h(L("adminEditPublication"))}</span>
        <div class="admin-edit__seg" role="radiogroup" aria-labelledby="editPubLabel">${seg("pub", "published", "adminCatPublished", f.pub === "published")}${seg("pub", "unpublished", "adminCatUnpublished", f.pub === "unpublished")}</div></div>
    </div>
    <p class="admin-edit__unpublished" id="editUnpublished"${f.pub === "unpublished" ? "" : " hidden"}>${h(L("adminEditUnpublishedNote"))}</p>
    <details class="admin-edit__speed"${f.download || f.upload ? " open" : ""}><summary>${h(L("adminEditSpeed"))}</summary>
      <div class="admin-edit__grid admin-edit__grid--speed">
        <div><label class="admin-edit__lbl" for="editDownload">${h(L("adminSpeedDown"))}</label><input class="admin-edit__in" id="editDownload" name="download" inputmode="decimal" placeholder="${h(L("adminSpeedNoLimit"))}" value="${h(f.download)}" autocomplete="off"></div>
        <div><label class="admin-edit__lbl" for="editUpload">${h(L("adminSpeedUp"))}</label><input class="admin-edit__in" id="editUpload" name="upload" inputmode="decimal" placeholder="${h(L("adminSpeedNoLimit"))}" value="${h(f.upload)}" autocomplete="off"></div>
      </div>
      ${err("speed", "adminEditSpeedError")}<p class="admin-edit__hint">${h(L("adminSpeedHelp"))}</p>
      ${speedLimitsOn ? "" : `<p class="admin-edit__speed-off" id="speedLimitsOff">${h(L("adminSpeedOff"))}</p>`}
    </details>
  </section>
  </fieldset>
  <div class="admin-edit__actions"><button type="button" class="admin-edit__save" data-edit-save${d.invalid || archived ? " disabled" : ""}>${h(L("adminSaveBundle"))}</button>
    <span class="admin-edit__saved" role="status">${h(saved)}</span></div>
  ${error ? `<p class="nd-callout nd-callout--danger" role="alert">${h(error)}</p>` : ""}
  ${isNew ? "" : `<section class="nd-panel admin-edit__panel admin-edit__danger" aria-labelledby="editRemove"><h2 class="admin-edit__h2" id="editRemove">${h(L("adminEditRemove"))}</h2>
    <p class="admin-edit__remove-text">${removeText}</p>
    <div><button type="button" class="admin-edit__remove${inUse ? "" : " admin-edit__remove--delete"}" data-edit-remove${archived ? " disabled" : ""}>${h(L(archived ? "adminEditArchivedDone" : inUse ? "adminEditArchive" : "adminCatDeletePermanently"))}</button></div>
  </section>`}
</div>
<aside class="admin-edit__aside" aria-labelledby="editPreview">
  <h2 class="admin-edit__aside-title" id="editPreview">${h(L("adminWhatCustomersSee"))}</h2>
  <div class="admin-edit__card"><div class="admin-edit__card-head"><strong id="editCardName">${h(d.suggested)}</strong><strong class="admin-edit__card-price" id="editCardPrice">${h(d.priceShown)}</strong></div>
    <span class="admin-edit__card-line" id="editCardLine">${h(d.line)}</span><span class="admin-edit__card-tag" id="editCardTag">${h(L(d.home ? "adminEditHomeTag" : "adminEditPersonalTag"))}</span></div>
  <section class="admin-edit__who" aria-label="${h(L("adminEditWhoAria"))}"><strong>${h(L("adminEditWho"))}</strong>
    <div class="admin-edit__row"><span>${h(L("adminEditNewCheckouts"))}</span><strong>${h(L("adminEditNewTerms"))}</strong></div>
    ${isNew ? "" : `<div class="admin-edit__row"><span>${h(L(b.pending === 1 ? "adminEditPendingOne" : "adminEditPending", { count: b.pending || 0 }))}</span><strong>${h(L("adminEditKeep", { price: number(b.pendingPrice ?? b.price) }))}</strong></div>
    <div class="admin-edit__row"><span>${h(L(b.active === 1 ? "adminCatActiveOne" : "adminCatActive", { count: b.active || 0 }))}</span><strong>${h(L("adminEditUnchanged"))}</strong></div>`}
    <p class="admin-edit__hint">${h(L("adminEditServerNote"))}</p></section>
</aside>
</div>`;
    head();
  }

  // Typing updates what follows from the terms without redrawing the fields.
  function sync() {
    const d = derive(f), $ = (id) => host.querySelector("#" + id);
    for (const key of ["price", "validity", "slots", "position", "speed"]) { const e = $("editErr-" + key); if (e) e.hidden = !shown(d, key); }
    for (const [id, key] of [["editPrice", "price"], ["editValidity", "validity"], ["editSlots", "slots"], ["editPosition", "position"]]) $(id)?.classList.toggle("admin-edit__in--bad", shown(d, key));
    host.querySelectorAll("[data-edit-slots]").forEach((chip) => chip.setAttribute("aria-pressed", String(String(f.slots).trim() === chip.dataset.editSlots)));
    $("editSuggested").textContent = L("adminEditSuggested", { name: d.suggested });
    $("editCardName").textContent = d.suggested; $("editCardPrice").textContent = d.priceShown; $("editCardLine").textContent = d.line;
    host.querySelector("[data-edit-save]").disabled = d.invalid || (!isNew && b.status === "archived");
    if (isNew) head();
  }

  function payload() {
    const home = f.type === HOME;
    return { name: f.name.trim(), price: String(f.price).trim(), accessType: f.type, validityValue: Number(f.validityValue), validityUnit: f.validityUnit,
      ...(home ? {} : { deviceSlots: Number(f.slots) }), status: f.pub, ...(String(f.position).trim() ? { position: Number(f.position) } : {}),
      downloadMbps: String(f.download).trim() || null, uploadMbps: String(f.upload).trim() || null };
  }

  host.addEventListener("input", (event) => {
    const field = event.target.name;
    if (!f || !field) return;
    if (field === "name") f.nameTouched = true;
    if (FIELD[field]) f.touched.add(FIELD[field]);
    f[field] = event.target.value;
    if (isNew && !f.nameTouched && field !== "name") { f.name = derive(f).suggested; host.querySelector("#editName").value = f.name; }
    saved = ""; host.querySelector(".admin-edit__saved").textContent = "";
    sync();
  });
  host.addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !f || busy) return;
    const redraw = (selector) => { saved = ""; if (isNew && !f.nameTouched) f.name = derive(f).suggested; render(); host.querySelector(selector)?.focus(); };
    if (button.dataset.editType) { f.type = button.dataset.editType; if (f.type === HOME) f.slots = "1"; redraw(`[data-edit-type="${f.type}"]`); return; }
    if (button.dataset.editUnit) { f.validityUnit = button.dataset.editUnit; redraw(`[data-edit-unit="${f.validityUnit}"]`); return; }
    if (button.dataset.editPub) { f.pub = button.dataset.editPub; redraw(`[data-edit-pub="${f.pub}"]`); return; }
    if (button.dataset.editSlots) { f.slots = button.dataset.editSlots; redraw(`[data-edit-slots="${f.slots}"]`); return; }
    if (button.hasAttribute("data-edit-save")) {
      busy = true; error = "";
      try {
        const result = await call(isNew ? "/api/admin/catalogue/create" : "/api/admin/catalogue/update",
          { method: "POST", body: JSON.stringify(isNew ? payload() : { id: b.id, version: b.version, ...payload() }) });
        if (isNew) { flash = L("adminEditSaved"); busy = false; location.hash = `bundle/${encodeURIComponent(result.bundle.id)}`; return; }
        data = result; b = result.bundles.find((x) => x.id === b.id) || b; f = formOf(b); saved = L("adminEditSaved");
      } catch (e) { error = e.message; saved = ""; }
      busy = false; render();
      host.querySelector("[data-edit-save]")?.focus();
      return;
    }
    if (button.hasAttribute("data-edit-remove")) {
      busy = true; error = "";
      try {
        const result = await call("/api/admin/catalogue/delete", { method: "POST", body: JSON.stringify({ id: b.id, version: b.version }) });
        busy = false;
        if (result.deleted) { location.hash = "bundles"; return; }
        data = result; b = result.bundles.find((x) => x.id === b.id) || { ...b, status: "archived" }; f = formOf(b); saved = "";
      } catch (e) { error = e.message; }
      busy = false; render();
      host.querySelector("[data-edit-remove]")?.focus();
    }
  });

  function formOf(bundle) {
    const position = rows().findIndex((x) => x.id === bundle.id) + 1;
    return { type: bundle.accessType, name: bundle.name, nameTouched: true, touched: new Set(), price: String(bundle.price), validityValue: String(bundle.validityValue), validityUnit: bundle.validityUnit,
      slots: String(bundle.deviceSlots ?? 1), pub: bundle.status === "unpublished" ? "unpublished" : "published", position: position ? String(position) : "",
      download: bundle.downloadMbps == null ? "" : String(bundle.downloadMbps), upload: bundle.uploadMbps == null ? "" : String(bundle.uploadMbps) };
  }

  return {
    // Shows #bundle/<param>; false when there is no such Unlimited bundle.
    async open(param) {
      const [id, query = ""] = String(param || "").split("?");
      try { data = await call("/api/admin/catalogue"); } catch (e) { host.innerHTML = `<p class="nd-callout nd-callout--danger" role="alert">${h(e.message)}</p>`; return true; }
      error = ""; saved = flash; flash = "";
      if (id === "new") {
        const q = new URLSearchParams(query), type = q.get("accessType") === HOME ? HOME : PERSONAL;
        isNew = true; b = null;
        f = { type, name: "", nameTouched: false, touched: new Set(), price: "", validityValue: q.get("validityValue") || (type === HOME ? "30" : "24"), validityUnit: q.get("validityUnit") === "hours" ? "hours" : "days",
          slots: type === HOME ? "1" : q.get("deviceSlots") || "1", pub: "unpublished", position: String(rows().length + 1), download: "", upload: "" };
        if (!q.get("validityUnit") && !q.get("validityValue") && type !== HOME) f.validityUnit = "hours";
        f.name = derive(f).suggested;
      } else {
        b = data.bundles.find((x) => x.id === id);
        if (!b) return false;
        isNew = false; f = formOf(b);
      }
      render();
      return true;
    },
  };
}
