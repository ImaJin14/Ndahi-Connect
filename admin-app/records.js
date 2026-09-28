import { escapeHtml as h } from "/shared/safe-html.js";

// Paginated, server-filtered record table (PERF-003). Rows are rendered by the
// caller; action buttons keep using the dashboard's delegated click handler.
export function mountRecords(container, { call, collection, title, headers, row, empty = "No records found.", pageSize = 25 }) {
  const state = { page: 1, q: "", status: "" };
  let timer, request = 0;
  container.innerHTML = `<div class="records-toolbar"><h3>${h(title)}</h3><form class="records-filter" role="search">
  <input type="search" name="q" aria-label="Search ${h(title.toLowerCase())}" placeholder="Search" maxlength="100">
  <select name="status" aria-label="Filter ${h(title.toLowerCase())} by status" hidden><option value="">All statuses</option></select>
</form></div><div class="table-scroll"><table><thead><tr>${headers.map((name) => `<th scope="col">${h(name)}</th>`).join("")}</tr></thead><tbody></tbody></table></div>
<nav class="records-pager" aria-label="${h(title)} pages"><button type="button" class="secondary-action" data-page="prev">Previous</button><span role="status" aria-live="polite"></span><button type="button" class="secondary-action" data-page="next">Next</button></nav>`;
  const form = container.querySelector("form"),
    status = form.elements.status,
    body = container.querySelector("tbody"),
    summary = container.querySelector(".records-pager span"),
    previous = container.querySelector('[data-page="prev"]'),
    next = container.querySelector('[data-page="next"]');
  async function load() {
    const current = ++request,
      params = new URLSearchParams({ collection, page: state.page, pageSize, q: state.q, status: state.status });
    container.setAttribute("aria-busy", "true");
    try {
      const result = await call(`/api/admin/records?${params}`);
      if (current !== request) return;
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
    } finally {
      if (current === request) container.removeAttribute("aria-busy");
    }
  }
  form.onsubmit = (event) => event.preventDefault();
  form.elements.q.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.q = form.elements.q.value.trim();
      state.page = 1;
      void load();
    }, 250);
  };
  status.onchange = () => {
    state.status = status.value;
    state.page = 1;
    void load();
  };
  previous.onclick = () => { state.page--; void load(); };
  next.onclick = () => { state.page++; void load(); };
  return load();
}

// Customer picker backed by server-side search instead of a full customer list.
export function mountCustomerPicker(input, select, call) {
  let timer, request = 0;
  async function search() {
    const current = ++request,
      params = new URLSearchParams({ collection: "customers", pageSize: 20, q: input.value.trim(), status: "active" }),
      result = await call(`/api/admin/records?${params}`);
    if (current !== request) return;
    select.innerHTML = result.items.length
      ? result.items.map((c) => `<option value="${h(c.id)}">${h(c.name)} — ${h(c.phone)}</option>`).join("")
      : '<option value="">No matching customers</option>';
  }
  input.oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void search(), 250);
  };
  return search();
}
