import { escapeHtml as h } from "/shared/safe-html.js";

// Paginated, server-filtered record table (PERF-003). Rows are rendered by the
// caller; action buttons keep using the dashboard's delegated click handler.
export function mountRecords(container, { call, collection, title, headers, row, empty = "No records found.", pageSize = 25, refreshMs = 0 }) {
  const state = { page: 1, q: "", status: "", from: "", to: "" };
  let timer, request = 0, loaded = false;
  container.innerHTML = `<div class="records-toolbar"><h3>${h(title)}</h3><form class="records-filter" role="search">
  <input type="search" name="q" aria-label="Search ${h(title.toLowerCase())}" placeholder="Search" maxlength="100">
  <select name="status" aria-label="Filter ${h(title.toLowerCase())} by status" hidden><option value="">All statuses</option></select>
  ${collection === "vouchers" ? '<label>Activated from (UTC)<input type="date" name="from" aria-label="Vouchers from date"></label><label>Activated through (UTC)<input type="date" name="to" aria-label="Vouchers through date"></label><button type="submit">Apply dates</button>' : ""}
</form></div><div class="table-scroll"><table><thead><tr>${headers.map((name) => `<th scope="col">${h(name)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
<nav class="records-pager" aria-label="${h(title)} pages"><button type="button" class="secondary-action" data-page="prev">Previous</button><span role="status" aria-live="polite"></span><button type="button" class="secondary-action" data-page="next">Next</button></nav>`;
  const form = container.querySelector("form"),
    status = form.elements.status,
    body = container.querySelector("tbody"),
    summary = container.querySelector(".records-pager span"),
    previous = container.querySelector('[data-page="prev"]'),
    next = container.querySelector('[data-page="next"]');
  function showLoading() {
    container.setAttribute("aria-busy", "true");
    previous.disabled = next.disabled = true;
    summary.textContent = "Loading records…";
    body.innerHTML = `<tr><td colspan="${headers.length}">Loading records…</td></tr>`;
  }
  async function load(background = false) {
    const current = ++request,
      params = new URLSearchParams({ collection, page: state.page, pageSize, q: state.q, status: state.status, ...(collection === "vouchers" ? { from: state.from, to: state.to } : {}) });
    if (!background || !loaded) showLoading();
    try {
      const result = await call(`/api/admin/records?${params}`);
      if (current !== request || !container.isConnected) return;
      if (status.options.length === 1 && result.statuses.length) {
        status.insertAdjacentHTML("beforeend", result.statuses.map((value) => `<option value="${h(value)}">${h(value.replaceAll("_", " "))}</option>`).join(""));
        status.hidden = false;
      }
      state.page = result.page;
      body.innerHTML = result.items.length
        ? result.items.map(row).join("")
        : `<tr><td colspan="${headers.length}">${h(empty)}</td></tr>`;
      summary.textContent = result.total
        ? `Page ${result.page} of ${result.pages} · ${result.total} total`
        : "No matching records";
      previous.disabled = result.page <= 1;
      next.disabled = result.page >= result.pages;
      loaded = true;
    } catch (error) {
      if (current !== request || !container.isConnected) return;
      if (!background || !loaded) body.innerHTML = `<tr><td colspan="${headers.length}">Records could not be loaded.</td></tr>`;
      summary.textContent = error.message || "Please try again.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary-action";
      retry.textContent = "Try again";
      retry.onclick = () => void load();
      summary.append(" ", retry);
    } finally {
      if (current === request) container.removeAttribute("aria-busy");
    }
  }
  form.onsubmit = (event) => {
    event.preventDefault();
    if (collection === "vouchers") { state.from = form.elements.from.value; state.to = form.elements.to.value; state.page = 1; void load(); }
  };
  form.elements.q.oninput = () => {
    clearTimeout(timer);
    state.q = form.elements.q.value.trim();
    state.page = 1;
    request++;
    showLoading();
    timer = setTimeout(() => {
      void load();
    }, 250);
  };
  status.onchange = () => {
    clearTimeout(timer);
    state.status = status.value;
    state.page = 1;
    void load();
  };
  previous.onclick = () => { if (!previous.disabled) { state.page--; void load(); } };
  next.onclick = () => { if (!next.disabled) { state.page++; void load(); } };
  if (refreshMs) {
    const refresh = async () => {
      if (!container.isConnected) return;
      if (!document.hidden && !container.closest("[hidden]") && !container.querySelector("input:focus, select:focus, textarea:focus, [aria-busy='true']")) await load(true);
      setTimeout(refresh, refreshMs);
    };
    setTimeout(refresh, refreshMs);
  }
  const ready = load();
  ready.refresh = () => load(true);
  return ready;
}

// Customer picker backed by server-side search instead of a full customer list.
export function mountCustomerPicker(input, select, call) {
  let timer, request = 0;
  function showLoading() {
    select.innerHTML = '<option value="">Searching customers…</option>';
    select.setAttribute("aria-busy", "true");
  }
  async function search() {
    const current = ++request,
      params = new URLSearchParams({ collection: "customers", pageSize: 20, q: input.value.trim(), status: "active" });
    showLoading();
    try {
      const result = await call(`/api/admin/records?${params}`);
      if (current !== request || !select.isConnected) return;
      select.innerHTML = result.items.length
        ? result.items.map((c) => `<option value="${h(c.id)}">${h(c.name)} — ${h(c.phone)}</option>`).join("")
        : '<option value="">No matching customers</option>';
    } catch {
      if (current === request && select.isConnected) select.innerHTML = '<option value="">Unable to load customers. Search again.</option>';
    } finally {
      if (current === request) select.removeAttribute("aria-busy");
    }
  }
  input.oninput = () => {
    clearTimeout(timer);
    request++;
    showLoading();
    timer = setTimeout(() => void search(), 250);
  };
  input.onkeydown = (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    clearTimeout(timer);
    void search();
  };
  return search();
}
