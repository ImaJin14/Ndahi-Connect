// Bundle catalogue (canvas: AdminBundles, #338). Everything shown comes from
// GET /api/admin/catalogue: the Personal Unlimited price grid (validity rows ×
// 1–6 device columns), the Home WISP card, and every bundle in the order
// customers see, with the earlier plans as read-only rows (owner, 24 Nov:
// https://github.com/ImaJin14/Ndahi-Connect/issues/338#issuecomment-7144376762).
// Reorder, publish, unpublish and delete (archive once sold) call the
// catalogue API, which is authoritative and audits every change.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const DEVICE_COLUMNS = [1, 2, 3, 4, 5, 6];
const number = (n) => Number(n).toLocaleString(currentLanguage() === "fr" ? "fr-FR" : "en-US");
const price = (n) => (n == null ? "—" : number(n));
const devices = (n) => (n === 1 ? L("adminCatOneDevice") : L("adminCatDevices", { count: n }));
const isPersonal = (b) => b.accessType === "personal_unlimited";
const isHome = (b) => b.accessType === "home_wisp_unlimited";

// "5 hours", "24 hours", "7 days": as the bundle was set up.
export function validityLabel(b) {
  const value = Number(b.validityValue), unit = b.validityUnit === "days" ? "days" : "hours";
  if (unit === "days") return value === 1 ? L("adminCatOneDay") : L("adminCatDays", { count: value });
  return value === 1 ? L("adminCatOneHour") : L("adminCatHours", { count: value });
}
// Legacy plans by their own terms: "5 GB · 7 days · 1 device".
function legacyDetail(p) {
  const hours = Number(p.validityHours) || 0;
  const time = hours % 24 === 0 && hours >= 24 ? (hours === 24 ? L("adminCatOneDay") : L("adminCatDays", { count: hours / 24 })) : hours === 1 ? L("adminCatOneHour") : L("adminCatHours", { count: hours });
  return [p.quotaGb == null ? L("adminBundleUnlimited") : `${number(p.quotaGb)} GB`, time, devices(Number(p.deviceLimit) || 1)].join(" · ");
}
export function bundleTerms(b) {
  if (b.kind === "legacy") {
    if (b.status !== "archived") return legacyDetail(b);
    return L(b.quotaGb == null ? "adminCatRetired" : "adminCatRetiredFixed");
  }
  return `${validityLabel(b)} · ${isHome(b) ? L("adminCatHouseholdSharing") : devices(b.deviceSlots)}`;
}
// Counts print as drawn ("1204 orders · 23 active"); prices keep their grouping.
const usedBy = (b) => (!b.orders ? L("adminCatNoOrders") : L(b.orders === 1 ? "adminCatUsedOne" : "adminCatUsed", { orders: b.orders, active: b.active }));
const STATUS = { published: ["adminCatPublished", "admin-cat__pill--published"], unpublished: ["adminCatUnpublished", "admin-cat__pill--unpublished"], archived: ["adminCatArchived", "admin-cat__pill--archived"] };
const pill = (status) => `<span class="admin-cat__pill ${STATUS[status][1]}">${h(L(STATUS[status][0]))}</span>`;
const editHref = (b) => `/dashboard#bundle/${encodeURIComponent(b.id)}`;
const createHref = (fields) => `/dashboard#bundle/new?${new URLSearchParams(fields)}`;
const ACTIONS = { reorder: "/api/admin/catalogue/reorder", publish: "/api/admin/catalogue/publish", unpublish: "/api/admin/catalogue/unpublish", delete: "/api/admin/catalogue/delete" };

// The bundle shown in a grid cell: the published one first, then by order.
function pick(list) {
  return [...list].sort((a, b) => (a.status === "published" ? 0 : 1) - (b.status === "published" ? 0 : 1) || a.displayOrder - b.displayOrder)[0];
}

// One row per validity with a Personal Unlimited bundle on sale; unpublished
// bundles show in their row's cell, and a validity with none on sale is only
// in the list below (as drawn: the unpublished "Weekend test").
function personalGrid(bundles) {
  const offered = bundles.filter((b) => isPersonal(b) && b.status !== "archived");
  const onSale = new Set(offered.filter((b) => b.status === "published").map((b) => `${b.validityValue}:${b.validityUnit}`));
  const rows = new Map();
  for (const b of offered.filter((x) => onSale.has(`${x.validityValue}:${x.validityUnit}`))) {
    const key = `${b.validityValue}:${b.validityUnit}`;
    if (!rows.has(key)) rows.set(key, { hours: b.validityHours, sample: b, cells: new Map() });
    const cells = rows.get(key).cells;
    if (!cells.has(b.deviceSlots)) cells.set(b.deviceSlots, []);
    cells.get(b.deviceSlots).push(b);
  }
  const head = `<span></span>${DEVICE_COLUMNS.map((n) => `<span class="admin-cat__gh">${h(devices(n))}</span>`).join("")}`;
  const body = [...rows.values()].sort((a, b) => a.hours - b.hours).map((row) => {
    const label = validityLabel(row.sample);
    return `<span class="admin-cat__gl">${h(label)}</span>${DEVICE_COLUMNS.map((n) => {
      const b = row.cells.has(n) && pick(row.cells.get(n));
      if (!b) {
        return `<a class="admin-cat__cell admin-cat__cell--none" href="${h(createHref({ accessType: "personal_unlimited", validityValue: row.sample.validityValue, validityUnit: row.sample.validityUnit, deviceSlots: n }))}"
  aria-label="${h(L("adminCatCreateAria", { validity: label, count: n }))}"><strong>+</strong><span>${h(L("adminCatNotOffered"))}</span></a>`;
      }
      const best = b.mostBought && b.status === "published";
      return `<a class="admin-cat__cell${best ? " admin-cat__cell--best" : ""}${b.status === "published" ? "" : " admin-cat__cell--off"}" href="${h(editHref(b))}" data-cell="${h(b.id)}"
  aria-label="${h(L(b.status === "published" ? "adminCatCellAria" : "adminCatCellAriaOff", { validity: label, devices: devices(n), price: price(b.price) }))}"><strong>${h(price(b.price))}</strong><span>${h(L(best ? "adminCatMostBought" : STATUS[b.status][0]))}</span></a>`;
    }).join("")}`;
  }).join("");
  return `<div class="admin-cat__scroll"><div class="admin-cat__grid" role="table" aria-label="${h(L("adminCatGridAria"))}">${head}${body}</div></div>`;
}

function homeCards(bundles) {
  const home = bundles.filter((b) => isHome(b) && b.status !== "archived");
  if (!home.length) {
    return `<a class="admin-cat__cell admin-cat__cell--none admin-cat__home-none" href="${h(createHref({ accessType: "home_wisp_unlimited", validityValue: 30, validityUnit: "days" }))}"
  aria-label="${h(L("adminCatCreateHomeAria"))}"><strong>+</strong><span>${h(L("adminCatNotOffered"))}</span></a>`;
  }
  return home.map((b) => `<a class="admin-cat__home" href="${h(editHref(b))}" data-home="${h(b.id)}"><span><strong>${h(validityLabel(b))}</strong><span class="admin-cat__home-subs">${h(L(b.active === 1 ? "adminCatActiveOne" : "adminCatActive", { count: b.active || 0 }))}</span></span><strong class="admin-cat__home-price">${h(price(b.price))}</strong>${pill(b.status)}</a>`).join("");
}

export function mountCatalogue(host, { call }) {
  let data = null, filter = "all", dialog = null, done = "", busy = false, error = "";
  const rows = () => [...(data?.bundles || []), ...(data?.legacy || [])].sort((a, b) => a.displayOrder - b.displayOrder);
  const named = (b) => `${b.name} · ${bundleTerms(b)}`;

  function render() {
    if (!data) { host.innerHTML = error ? `<p class="nd-callout nd-callout--danger">${h(error)}</p>` : `<p class="nd-meta">${h(L("adminLoading"))}</p>`; return; }
    const all = rows(), counts = { all: all.length, published: 0, unpublished: 0, archived: 0 };
    all.forEach((b) => { counts[b.status]++; });
    const onSale = (test) => data.bundles.filter((b) => test(b) && b.status === "published").length;
    const personal = onSale(isPersonal), total = personal + onSale(isHome);
    const shown = all.map((b, index) => ({ b, index })).filter(({ b }) => filter === "all" || b.status === filter);
    const d = dialog && all.find((b) => b.id === dialog), archive = d && d.inUse;
    host.innerHTML = `<section class="nd-panel admin-cat__panel" aria-labelledby="catPersonal">
  <div class="admin-cat__head"><div><h2 class="admin-cat__h2" id="catPersonal">${h(L("adminCatPersonal"))}</h2><p class="admin-cat__sub">${h(L("adminCatPersonalSub", { personal, total }))}</p></div>
  <span class="admin-cat__legend"><span><i class="admin-cat__dot"></i>${h(L("adminCatPublished"))}</span><span><i class="admin-cat__dot admin-cat__dot--off"></i>${h(L("adminCatUnpublished"))}</span></span></div>
  ${personalGrid(data.bundles)}
  <p class="admin-cat__note">${h(L("adminCatGridNote"))}</p>
</section>
<section class="nd-panel admin-cat__panel admin-cat__wisp" aria-labelledby="catHome">
  <div class="admin-cat__wisp-text"><h2 class="admin-cat__h2" id="catHome">${h(L("adminCatHome"))}</h2><p class="admin-cat__sub">${h(L("adminCatHomeSub"))}</p></div>
  ${homeCards(data.bundles)}
</section>
<section class="nd-panel admin-cat__panel admin-cat__panel--list" aria-labelledby="catAll">
  <div class="admin-cat__head admin-cat__head--center"><div><h2 class="admin-cat__h2" id="catAll">${h(L("adminCatAll"))}</h2><p class="admin-cat__sub">${h(L("adminCatAllSub"))}</p></div>
  <div class="admin-cat__filters" role="group" aria-label="${h(L("adminCatShow"))}">${["all", "published", "unpublished", "archived"].map((id) =>
    `<button type="button" class="nd-chip admin-cat__chip" data-cat-filter="${id}" aria-pressed="${filter === id}">${h(L({ all: "adminCatFilterAll", published: "adminCatPublished", unpublished: "adminCatUnpublished", archived: "adminCatArchived" }[id]))} · ${counts[id]}</button>`).join("")}</div></div>
  ${d ? `<div class="admin-cat__dialog admin-cat__dialog--${archive ? "archive" : "delete"}" role="alertdialog" aria-label="${h(L("adminCatRemoveBundle"))}" aria-describedby="catDialogText" tabindex="-1">
    <span id="catDialogText" class="admin-cat__dialog-text"><strong>${h(L(archive ? "adminCatArchiveTitle" : "adminCatDeleteTitle", { bundle: named(d) }))}</strong> ${h(archive ? L("adminCatArchiveBody", { orders: d.orders, active: d.active }) : L("adminCatDeleteBody"))}</span>
    <button type="button" class="admin-cat__btn" data-cat-cancel>${h(L("adminCatCancel"))}</button>
    <button type="button" class="admin-cat__confirm" data-cat-confirm="${h(d.id)}">${h(L(archive ? "adminCatArchive" : "adminCatDeletePermanently"))}</button></div>` : ""}
  ${done ? `<p class="admin-cat__done" role="status">${h(done)}</p>` : ""}${error ? `<p class="nd-callout nd-callout--danger" role="alert">${h(error)}</p>` : ""}
  <div class="admin-cat__table-wrap"><table class="admin-cat__table"><thead><tr><th scope="col">${h(L("adminCatColOrder"))}</th><th scope="col">${h(L("adminCatColBundle"))}</th><th scope="col">${h(L("adminCatColPrice"))}</th><th scope="col">${h(L("adminCatColStatus"))}</th><th scope="col">${h(L("adminCatColUsed"))}</th><th scope="col"><span class="admin-cat__sr">${h(L("adminCatColActions"))}</span></th></tr></thead>
  <tbody>${shown.map(({ b, index }) => {
    const legacy = b.kind === "legacy", archived = b.status === "archived";
    const actions = archived ? `<span class="admin-cat__kept">${h(L("adminCatHistoryKept"))}</span>`
      : legacy ? "" : `<span class="admin-cat__actions"><a class="admin-cat__btn" href="${h(editHref(b))}" aria-label="${h(L("adminCatEditAria", { bundle: named(b) }))}">${h(L("adminCatEdit"))}</a><button type="button" class="admin-cat__btn" data-cat-flip="${h(b.id)}" aria-label="${h(L(b.status === "published" ? "adminCatUnpublishAria" : "adminCatPublishAria", { bundle: named(b) }))}">${h(L(b.status === "published" ? "adminCatUnpublish" : "adminCatPublish"))}</button><button type="button" class="admin-cat__btn admin-cat__btn--danger" data-cat-remove="${h(b.id)}" aria-label="${h(L("adminCatDeleteAria", { bundle: named(b) }))}">${h(L("adminCatDelete"))}</button></span>`;
    return `<tr class="${archived ? "admin-cat__row--archived" : ""}" data-cat-row="${h(b.id)}">
  <td class="admin-cat__order"><button type="button" class="admin-cat__move" data-cat-move="-1" data-index="${index}" aria-label="${h(L("adminCatMoveUp", { bundle: named(b) }))}"${index === 0 ? " disabled" : ""}>↑</button><button type="button" class="admin-cat__move" data-cat-move="1" data-index="${index}" aria-label="${h(L("adminCatMoveDown", { bundle: named(b) }))}"${index === all.length - 1 ? " disabled" : ""}>↓</button><span class="admin-cat__pos">${index + 1}</span></td>
  <td class="admin-cat__bundle"><strong>${h(b.name)}</strong><br><span class="admin-cat__terms">${h(bundleTerms(b))}</span></td>
  <td><strong>${h(legacy && archived ? "—" : price(b.price))}</strong></td>
  <td>${pill(b.status)}</td>
  <td class="admin-cat__used">${h(usedBy(b))}</td>
  <td class="admin-cat__cell-actions">${actions}</td></tr>`;
  }).join("")}</tbody></table></div>
  <p class="admin-cat__note admin-cat__note--foot">${h(L("adminCatFootNote"))}</p>
</section>`;
    if (d) host.querySelector(".admin-cat__dialog")?.focus();
  }

  async function act(path, body, message) {
    if (busy) return;
    busy = true; error = "";
    try {
      const result = await call(ACTIONS[path], { method: "POST", body: JSON.stringify(body) });
      data = result; dialog = null; done = typeof message === "function" ? message(result) : message;
    } catch (e) { error = e.message; done = ""; }
    busy = false;
    render();
  }

  host.addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button || button.disabled || !host.contains(button)) return;
    const all = rows(), byId = (id) => all.find((b) => b.id === id);
    if (button.dataset.catFilter) { filter = button.dataset.catFilter; render(); return; }
    if (button.dataset.catMove) {
      const i = Number(button.dataset.index), j = i + Number(button.dataset.catMove);
      if (j < 0 || j >= all.length) return;
      const ids = all.map((b) => b.id);
      [ids[i], ids[j]] = [ids[j], ids[i]];
      void act("reorder", { ids }, L("adminCatOrderSaved"));
      return;
    }
    if (button.dataset.catFlip) {
      const b = byId(button.dataset.catFlip), publish = b.status !== "published";
      void act(publish ? "publish" : "unpublish", { id: b.id, version: b.version }, L(publish ? "adminCatPublishedDone" : "adminCatUnpublishedDone", { bundle: named(b) }));
      return;
    }
    if (button.dataset.catRemove) { dialog = button.dataset.catRemove; done = ""; render(); return; }
    if (button.hasAttribute("data-cat-cancel")) {
      const id = dialog; dialog = null; render();
      host.querySelector(`[data-cat-remove="${CSS.escape(id)}"]`)?.focus();
      return;
    }
    if (button.dataset.catConfirm) {
      const b = byId(button.dataset.catConfirm);
      void act("delete", { id: b.id, version: b.version }, (result) => result.archived ? L("adminCatArchivedDone", { bundle: named(b) }) : L("adminCatDeletedDone", { name: b.name }));
    }
  });
  host.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && dialog) { event.preventDefault(); host.querySelector("[data-cat-cancel]")?.click(); }
  });

  return {
    async refresh() {
      try { data = await call("/api/admin/catalogue"); error = ""; } catch (e) { error = e.message; }
      render();
    },
  };
}
