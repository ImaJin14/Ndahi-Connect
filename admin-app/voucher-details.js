import { escapeHtml as h } from "/shared/safe-html.js";

// Details live only in the current DOM. Neither contact data nor responses are
// persisted in browser storage, service-worker caches, or a cross-page cache.
export function mountVoucherDetails(container, { columns, refreshRecords }) {
  const entries = new Map(), listeners = new AbortController();
  let scopeKey, serial = 0, disposed = false;
  const api = window.NDAHI_CONFIG.apiUrl;
  async function get(path, signal) {
    const response = await fetch(api + path, { credentials: "include", cache: "no-store", signal });
    const result = await response.json();
    if (!response.ok) { const error = Error(result.error || "Details could not be loaded."); error.status = response.status; throw error; }
    return result;
  }
  function invalidate(entry, { erase = false } = {}) {
    entry.version++; entry.controller?.abort(); entry.controller = undefined;
    if (erase) entry.content.replaceChildren();
  }
  function clear() { for (const entry of entries.values()) { invalidate(entry, { erase: true }); entry.signature = undefined; } }
  function accessLost() {
    clear();
    for (const entry of entries.values()) {
      entry.open = false; entry.panel.hidden = true; entry.button.setAttribute("aria-expanded", "false");
    }
  }
  const value = (v) => v === null || v === undefined || v === "" ? "—" : String(v);
  const bytes = (v) => v === null ? "Unlimited" : `${Number(v || 0).toLocaleString()} bytes`;
  function markup(data) {
    const field = (label, v) => `<dt>${h(label)}</dt><dd style="overflow-wrap:anywhere;margin:0 0 .75rem">${h(value(v))}</dd>`,
      owner = data.ownership;
    return `<dl>${field("Ownership", owner.state === "unlinked" ? "Not linked yet" : owner.state === "unavailable" ? "Linked account unavailable" : "Linked to a customer account")}${
      data.permissions.contacts && owner.state === "linked" ? field("Customer name", owner.name) + field("Account phone", owner.accountPhone) : owner.state === "linked" ? field("Customer contact", "Restricted for this staff role") : ""
    }${field("Bundle", data.plan?.name)}${field("Voucher status", data.voucher.status)}${field("Remaining data", bytes(data.remainingBytes))}${field("Activated", data.voucher.activatedAt)}${field("Expires", data.voucher.expiresAt)}${field("Device limit", data.voucher.deviceLimit)}${
      data.permissions.payment && data.payment ? field("Payment reference", data.payment.providerReference || data.payment.id) + field("Payment status", data.payment.status) + field("Payment amount", `${value(data.payment.amount)} ${value(data.payment.currency)}`) + field("Payer phone (may differ from account phone)", data.payment.payerPhone) : ""
    }</dl>`;
  }
  async function load(entry) {
    invalidate(entry);
    const version = entry.version, expectedScope = scopeKey, controller = new AbortController();
    entry.controller = controller;
    if (!entry.signature) entry.content.textContent = "Loading voucher details…";
    entry.panel.setAttribute("aria-busy", "true");
    const current = () => !disposed && container.isConnected && entry.open && entries.get(entry.id) === entry && entry.version === version && expectedScope === scopeKey;
    try {
      const data = await get(`/api/admin/vouchers/${encodeURIComponent(entry.id)}/details`, controller.signal);
      if (!current()) return;
      // A delayed detail response can have been authorized before a role change.
      // Revalidate the current scope and row visibility before painting it.
      const check = await get(`/api/admin/vouchers/${encodeURIComponent(entry.id)}/details?checkScope=1`, controller.signal);
      if (!current()) return;
      if (data.scopeKey !== expectedScope || check.scopeKey !== expectedScope || check.id !== entry.id) {
        accessLost(); void refreshRecords(); return;
      }
      const signature = JSON.stringify(data);
      if (entry.signature !== signature) { entry.content.innerHTML = markup(data); entry.signature = signature; }
    } catch (error) {
      if (error.name === "AbortError" || !current()) return;
      if ([401, 403, 404].includes(error.status)) {
        accessLost(); void refreshRecords(); return;
      }
      // Old contact information is removed even when a refresh fails.
      entry.signature = undefined; entry.content.textContent = error.message || "Details could not be loaded.";
      const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "Retry details";
      retry.onclick = () => void load(entry); entry.content.append(" ", retry);
    } finally { if (current()) entry.panel.removeAttribute("aria-busy"); }
  }
  function create(item) {
    const base = document.createElement("tr"), panel = document.createElement("tr"), cell = document.createElement("td"),
      section = document.createElement("section"), button = document.createElement("button"), content = document.createElement("div"), refresh = document.createElement("button");
    const id = `voucher-details-${++serial}-${Math.random().toString(36).slice(2)}`;
    base.dataset.voucherRecord = item.id; panel.dataset.voucherPanel = item.id;
    content.setAttribute("aria-live", "polite");
    section.id = id; section.setAttribute("role", "region"); section.setAttribute("aria-label", "Voucher ownership details");
    cell.colSpan = columns; cell.style.whiteSpace = "normal"; section.style.maxWidth = "36rem";
    button.type = "button"; button.className = "secondary-action"; button.textContent = "Details";
    button.setAttribute("aria-controls", id); button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-label", `Details for voucher ${item.code || item.id}`);
    refresh.type = "button"; refresh.className = "secondary-action"; refresh.textContent = "Refresh details";
    section.append(refresh, content); cell.append(section); panel.append(cell); panel.hidden = true;
    const entry = { id: item.id, base, panel, button, content, version: 0, open: false };
    button.onclick = () => {
      entry.open = !entry.open; panel.hidden = !entry.open; button.setAttribute("aria-expanded", String(entry.open));
      if (entry.open) void load(entry); else { invalidate(entry, { erase: true }); entry.signature = undefined; }
    };
    refresh.onclick = () => void load(entry);
    return entry;
  }
  function render(body, items, renderRow, nextScope) {
    const focused = container.contains(document.activeElement) ? document.activeElement : null;
    if (scopeKey !== undefined && scopeKey !== nextScope) accessLost();
    scopeKey = nextScope;
    const ids = new Set(items.map((v) => v.id));
    for (const [id, entry] of entries) if (!ids.has(id)) { invalidate(entry, { erase: true }); entry.base.remove(); entry.panel.remove(); entries.delete(id); }
    for (const node of [...body.children]) if (!node.dataset.voucherRecord && !node.dataset.voucherPanel) node.remove();
    let cursor = body.firstChild;
    for (const item of items) {
      let entry = entries.get(item.id);
      if (!entry) { entry = create(item); entries.set(item.id, entry); }
      entry.button.setAttribute("aria-label", `Details for voucher ${item.code || item.id}`);
      const html = renderRow({ ...item, code: item.code || "Restricted" });
      if (entry.html !== html) {
        const focused = document.activeElement === entry.button, template = document.createElement("template");
        template.innerHTML = `<table><tbody>${html}</tbody></table>`;
        entry.base.replaceChildren(...template.content.querySelector("tr").childNodes);
        if (!item.permissions?.manage) entry.base.querySelectorAll("[data-voucher], [data-resend-email], [data-classify]").forEach((b) => b.remove());
        entry.base.lastElementChild.append(" ", entry.button); entry.html = html;
        if (focused) entry.button.focus({ preventScroll: true });
      }
      for (const node of [entry.base, entry.panel]) {
        if (node !== cursor) body.insertBefore(node, cursor);
        cursor = node.nextSibling;
      }
      if (entry.open) void load(entry);
    }
    if (focused?.isConnected && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
  document.addEventListener("visibilitychange", () => {
    clear(); if (!document.hidden && container.isConnected) void refreshRecords();
  }, { signal: listeners.signal });
  window.addEventListener("pagehide", accessLost, { signal: listeners.signal });
  document.addEventListener("click", (event) => {
    if (event.target.closest("#logout, [data-logout]")) accessLost();
  }, { capture: true, signal: listeners.signal });
  return { render, clear: accessLost, refresh: () => { for (const e of entries.values()) if (e.open) void load(e); },
    destroy() { disposed = true; clear(); entries.clear(); listeners.abort(); } };
}
