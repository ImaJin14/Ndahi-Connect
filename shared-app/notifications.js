import { escapeHtml as h } from "/shared/safe-html.js";
import { runButton } from "/shared/pending.js";

let mounted;
export function mountNotifications({ apiUrl, path, csrf, admin = false }) {
  if (mounted) { void mounted.refresh(); return mounted; }
  const style = document.createElement("link"); style.rel = "stylesheet"; style.href = "/shared/notifications.css"; document.head.appendChild(style);
  const bell = document.createElement("button"); bell.type = "button"; bell.className = "notification-bell";
  bell.setAttribute("aria-label", "Notifications"); bell.setAttribute("aria-haspopup", "dialog"); bell.setAttribute("aria-expanded", "false");
  bell.innerHTML = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M9 21h6"/></svg><span data-notification-count hidden></span>';
  const logout = document.querySelector("header #logout"), header = document.querySelector("header");
  if (!header) return;
  (logout ? logout.parentElement : header).insertBefore(bell, logout || null);
  const backdrop = document.createElement("div"); backdrop.className = "notification-backdrop"; backdrop.hidden = true;
  const panel = document.createElement("section"); panel.className = "notification-panel"; panel.hidden = true;
  panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-labelledby", "notificationTitle");
  panel.innerHTML = '<div class="notification-heading"><h2 id="notificationTitle">Notifications</h2><button type="button" data-refresh-notifications aria-label="Refresh notifications" title="Refresh notifications">↻</button><button type="button" data-close-notifications aria-label="Close notifications">✕</button></div><p data-notification-message role="status" aria-live="polite"></p><div data-notification-body></div>';
  document.body.append(backdrop, panel);
  const output = panel.querySelector("[data-notification-message]"), host = panel.querySelector("[data-notification-body]");
  let inbox, timer, returnFocus = bell, loading = false, tab = "unread", category = "all", settings = false, editing = false, dateEditing = false, generation = 0, requestId = 0, from = "", to = "", cursor = "", previous = [];
  const post = (input) => { generation++; return call({ method: "POST", body: JSON.stringify(input) }); };
  async function call(options = {}) {
    const query = new URLSearchParams({ view: tab, category, from, to, limit: "25", cursor });
    const response = await fetch(apiUrl + path + "?" + query.toString(), { cache: "no-store", credentials: "include", ...options,
      headers: { "content-type": "application/json", ...(options.method === "POST" ? { "x-csrf-token": csrf() } : {}) } });
    const value = await response.json();
    if (!response.ok) throw Error(value.error || "Notifications could not load.");
    return value;
  }
  function badge() {
    const count = inbox?.unreadCount || 0, label = bell.querySelector("[data-notification-count]");
    label.hidden = !count; label.textContent = count > 99 ? "99+" : String(count);
    bell.setAttribute("aria-label", "Notifications" + (count ? " (" + count + " unread)" : ""));
  }
  function render() {
    if (!inbox || panel.hidden || editing || dateEditing) return;
    const focused = document.activeElement, hadFocus = host.contains(focused), focusName = focused && focused.name;
    const focusAttribute = ["data-notification-view", "data-notification-category", "data-notification-from", "data-notification-to", "data-apply-filters", "data-page-next", "data-page-previous", "data-open-settings", "data-read-all", "data-settings-back"].find((key) => focused && focused.hasAttribute(key));
    const items = inbox.items.filter((n) => (category === "all" || n.category === category) &&
      (tab === "archived" ? n.archived : !n.archived && (tab === "action" ? n.actionRequired : tab === "unread" ? !n.read : true)));
    host.innerHTML = settings ? '<form data-notification-settings><h3>Notification settings</h3><p>Security notices and items requiring action stay visible in your inbox.</p>' +
      Object.entries(inbox.preferences.categories).filter(([key]) => inbox.categories[key]).map(([key, enabled]) =>
        '<label><input type="checkbox" name="' + h(key) + '" ' + (enabled ? "checked" : "") + (key === "security" ? " disabled" : "") + '> ' + h(inbox.categories[key]) + '</label>').join("") +
      (!admin ? '<fieldset><legend>Data and bundle alerts</legend><p>Use the Usage category above to enable or disable these alerts in your inbox.</p>' +
        [["90", "90% of data used"], ["low", "Low data (about 2 MB remaining)"], ["100", "Data exhausted"]].map(([level, label]) =>
          '<label><input type="checkbox" name="usage-' + level + '" ' + ((inbox.preferences.usageThresholds || ["90", "low", "100"]).includes(level) ? "checked" : "") + '> ' + h(label) + '</label>').join("") +
        '<label><input type="checkbox" name="expiryWarnings" ' + (inbox.preferences.expiryWarnings ? "checked" : "") + '> Warn within one hour of bundle expiry</label>' +
        '<label><input type="checkbox" name="subscriptionUpdates" ' + (inbox.preferences.subscriptionUpdates !== false ? "checked" : "") + '> Expired or exhausted bundle updates</label>' +
        '<label><input type="checkbox" name="usagePush" ' + (inbox.preferences.usagePush ? "checked" : "") + '> Data-usage push alerts</label><p>Warnings use the latest server reading; arrival at an exact balance or time is not guaranteed.</p></fieldset>' +
        '<fieldset><legend>Email</legend><label><input type="checkbox" name="emailFallback" ' + (inbox.preferences.emailFallback ? "checked" : "") + '> Email data and expiry alerts when browser push is unavailable</label><label><input type="checkbox" name="emailTransactions" ' + (inbox.preferences.emailTransactions !== false ? "checked" : "") + '> Email welcome, receipts, vouchers and activation notices</label><label><input type="checkbox" name="emailSecurity" ' + (inbox.preferences.emailSecurity ? "checked" : "") + '> Email security notices</label><p>' + (inbox.emailAvailable ? "Sent to your confirmed account email." : "Link and confirm an email in Account to receive email notices.") + '</p></fieldset>' : "") +
      '<label><input type="checkbox" name="pushEnabled" ' + (inbox.preferences.pushEnabled ? "checked" : "") + (inbox.pushAvailable ? "" : " disabled") + '> Push new activity to my subscribed devices</label>' +
      '<p>' + (inbox.pushAvailable ? "Browser notifications require permission on each device. Your in-app inbox always works." : "Browser push is not configured. Your in-app inbox works without it.") + '</p>' +
      (inbox.pushAvailable ? '<button type="button" data-enable-browser>Enable on this device</button><button type="button" data-disable-browser>Disable on this device</button>' : "") +
      '<button type="submit">Save notification settings</button><button type="button" data-settings-back>Back to notifications</button></form>' :
      '<div class="notification-tools"><label>View<select data-notification-view aria-label="Notification view">' + [["unread","Unread"],["action","Action required"],["all","All"],["archived","Archived"]].map(([key,label]) => '<option value="' + key + '"' + (tab === key ? " selected" : "") + '>' + label + '</option>').join("") +
      '</select></label><label>Category<select data-notification-category aria-label="Notification category"><option value="all">All categories</option>' + Object.keys(inbox.categories).map((key) => '<option value="' + key + '"' + (category === key ? " selected" : "") + '>' + h(inbox.categories[key]) + '</option>').join("") +
      '</select></label></div><div class="notification-tools notification-dates"><label>From (UTC)<input type="date" data-notification-from aria-label="Notifications from date" value="' + h(from) + '"></label><label>Through (UTC)<input type="date" data-notification-to aria-label="Notifications through date" value="' + h(to) + '"></label><button type="button" data-apply-filters>Apply dates</button></div><div class="notification-toolbar"><button type="button" data-read-all>Mark all read</button><button type="button" data-open-settings>Settings</button></div>' +
      (items.length ? items.map((n) => '<article class="notification-item' + (n.read ? "" : " notification-unread") + '" data-notification-id="' + h(n.id) + '"><p class="notification-category">' + h(inbox.categories[n.category] || n.category) + (n.actionRequired ? " · Action required" : "") + '</p><h3>' + h(n.title) + '</h3><p>' + h(n.body) + '</p><small>' + h(new Date(n.updatedAt).toLocaleString()) + '</small>' + (n.incident ? '<p>' + h(n.incident.count) + ' occurrence(s) · ' + h(n.incident.status) + '<br>First: ' + h(new Date(n.incident.firstAt).toLocaleString()) + '<br>Latest: ' + h(new Date(n.incident.lastAt).toLocaleString()) + '</p>' : '') + '<div class="notification-row-actions"><a data-notification-review href="' + h(n.url) + '">' + h(n.linkLabel || (n.actionRequired ? "Review" : "View details")) + '</a>' +
      (!n.read ? '<button type="button" data-read>Mark read</button>' : "") +
      (!n.actionRequired ? '<button type="button" ' + (n.archived ? "data-restore" : "data-archive") + '>' + (n.archived ? "Restore" : "Archive") + '</button>' : "") + '</div></article>').join("") : '<p class="notification-empty">No notifications match these filters.</p>') + (!settings ? '<nav class="notification-pagination" aria-label="Notification history pages"><button type="button" data-page-previous' + (previous.length ? "" : " disabled") + '>Previous</button><span>' + h(String(inbox.page.total)) + ' matching</span><button type="button" data-page-next' + (inbox.page.nextCursor ? "" : " disabled") + '>Next</button></nav>' : "");
    const form = host.querySelector("form");
    if (form) {
      form.oninput = () => { editing = true; };
      form.onsubmit = async (event) => {
        event.preventDefault();
        const input = { action: "preferences", categories: {} };
        for (const key of Object.keys(inbox.preferences.categories)) if (form.elements[key]) input.categories[key] = form.elements[key].checked;
        for (const key of ["pushEnabled", "emailSecurity", "emailTransactions", "emailFallback", "usagePush", "expiryWarnings", "subscriptionUpdates"]) if (form.elements[key]) input[key] = form.elements[key].checked;
        if (!admin) input.usageThresholds = ["90", "low", "100"].filter((level) => form.elements["usage-" + level]?.checked);
        try { await runButton(form.querySelector('[type="submit"]'), "Saving…", async () => {
          inbox = await post(input); editing = false; badge(); render(); output.textContent = "Notification settings saved.";
        }, { controls: Array.from(form.elements) }); } catch (error) { output.textContent = error.message; }
      };
    }
    if (hadFocus) {
      const next = focusAttribute ? host.querySelector("[" + focusAttribute + "]") : focusName ? Array.from(host.querySelectorAll("[name]")).find((el) => el.name === focusName) : host.querySelector(form ? '[type="submit"]' : "[data-notification-view]");
      (next || panel.querySelector("[data-close-notifications]")).focus();
    }
  }
  async function refresh(force = false) {
    if (loading && !force || document.hidden) return;
    loading = true; const requestGeneration = generation, currentRequest = ++requestId;
    panel.setAttribute("aria-busy", "true");
    if (!inbox) host.textContent = "Loading notifications…";
    try { const result = await call(); if (requestGeneration !== generation || currentRequest !== requestId) return; inbox = result; badge(); render(); output.textContent = ""; }
    catch (error) { if (!panel.hidden && currentRequest === requestId) output.textContent = error.message + " Use Refresh notifications to try again."; }
    finally { if (currentRequest === requestId) { loading = false; panel.setAttribute("aria-busy", "false"); } }
  }
  function close() {
    generation++; dateEditing = false; panel.hidden = true; backdrop.hidden = true; delete panel.dataset.sensitiveOutput;
    document.body.classList.remove("notifications-open");
    bell.setAttribute("aria-expanded", "false"); (returnFocus?.isConnected ? returnFocus : bell).focus();
  }
  bell.onclick = () => {
    if (!panel.hidden) { close(); return; }
    returnFocus = bell;
    panel.hidden = false; backdrop.hidden = false; panel.dataset.sensitiveOutput = "true";
    document.body.classList.add("notifications-open");
    bell.setAttribute("aria-expanded", "true"); render(); panel.querySelector("[data-close-notifications]").focus(); void refresh();
  };
  backdrop.onclick = close; panel.querySelector("[data-close-notifications]").onclick = close;
  panel.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key !== "Tab") return;
    const elements = [...panel.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select')].filter((el) => el.getClientRects().length);
    const first = elements[0], last = elements[elements.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
  };
  document.addEventListener("keydown", (event) => { if (!panel.hidden && event.key === "Escape") { event.preventDefault(); close(); } });
  function changeFilters() { generation++; cursor = ""; previous = []; output.textContent = "Loading notifications…"; void refresh(true).then(() => { if (output.textContent === "Loading notifications…") output.textContent = ""; }); }
  panel.oninput = (event) => { if (event.target.matches("[data-notification-from],[data-notification-to]")) dateEditing = true; };
  panel.onchange = (event) => {
    if (event.target.matches("[data-notification-view]")) { tab = event.target.value; changeFilters(); }
    if (event.target.matches("[data-notification-category]")) { category = event.target.value; changeFilters(); }
  };
  panel.addEventListener("click", async (event) => {
    const button = event.target.closest("button"), row = event.target.closest("[data-notification-id]");
    if (event.target.closest("[data-notification-review]")) {
      const link = event.target.closest("[data-notification-review]"), sessions = link.hash === "#sessions";
      if (sessions && !event.ctrlKey && !event.metaKey && !event.shiftKey) event.preventDefault();
      if (row) { try { inbox = await post({ action: "read", id: row.dataset.notificationId }); badge(); } catch (_) {} }
      close(); if (sessions && event.defaultPrevented) location.assign(link.href); return;
    }
    if (!button) return;
    if (button.matches("[data-refresh-notifications]")) { void refresh(true); return; }
    if (button.matches("[data-apply-filters]")) {
      from = host.querySelector("[data-notification-from]").value; to = host.querySelector("[data-notification-to]").value;
      dateEditing = false; changeFilters(); return;
    }
    if (button.matches("[data-page-next],[data-page-previous]")) {
      if (button.matches("[data-page-next]")) { previous.push(cursor); cursor = inbox.page.nextCursor; }
      else cursor = previous.pop() || "";
      generation++; await refresh(true); panel.querySelector("[data-notification-view]")?.focus(); return;
    }
    if (button.matches("[data-open-settings]")) { settings = true; editing = false; render(); return; }
    if (button.matches("[data-settings-back]")) { settings = false; editing = false; render(); return; }
    const action = button.matches("[data-read-all]") ? "read-all" : button.matches("[data-read]") ? "read" : button.matches("[data-archive]") ? "archive" : button.matches("[data-restore]") ? "restore" : null;
    try {
      if (action) await runButton(button, "Saving…", async () => { inbox = await post({ action, id: row?.dataset.notificationId }); badge(); render(); if (!inbox.items.length && cursor) { cursor = ""; previous = []; await refresh(true); } });
      if (button.matches("[data-enable-browser],[data-disable-browser]")) {
        if (!navigator.serviceWorker || typeof PushManager === "undefined" || typeof Notification === "undefined") throw Error("Browser notifications are not supported here. Use the in-app inbox.");
        const enable = button.matches("[data-enable-browser]");
        if (enable && (Notification.permission === "denied" || Notification.permission !== "granted" && await Notification.requestPermission() !== "granted")) throw Error("Allow notifications in your browser settings, or keep using the in-app inbox.");
        await runButton(button, enable ? "Enabling…" : "Disabling…", async () => {
          const registration = await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" }); await navigator.serviceWorker.ready;
          let subscription = await registration.pushManager.getSubscription();
          if (enable) {
            const base64 = (inbox.publicKey + "=".repeat((4 - inbox.publicKey.length % 4) % 4)).replaceAll("-", "+").replaceAll("_", "/");
            subscription ||= await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)) });
            await post({ action: "subscribe", subscription: subscription.toJSON() });
            inbox = await post({ action: "preferences", pushEnabled: true });
          } else if (subscription) {
            await post({ action: "unsubscribe", endpoint: subscription.endpoint }); await subscription.unsubscribe();
          }
          editing = false; badge(); render(); output.textContent = enable ? "Browser notifications enabled on this device." : "Browser notifications disabled on this device.";
        });
      }
    } catch (error) { output.textContent = error.message || "The notification action failed."; }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void refresh(); });
  const startPolling = () => { clearInterval(timer); timer = setInterval(() => { if (!editing) void refresh(); }, 10000); void refresh(); };
  window.addEventListener("pageshow", startPolling);
  window.addEventListener("pagehide", () => clearInterval(timer));
  mounted = { refresh, close, open(filters = {}) {
    const opener = document.activeElement;
    category = filters.category || "all"; tab = filters.view || "all"; settings = filters.settings === true; editing = false; dateEditing = false;
    from = ""; to = ""; cursor = ""; previous = []; generation++;
    if (panel.hidden) bell.click();
    returnFocus = opener;
    void refresh(true);
  } }; startPolling(); return mounted;
}
