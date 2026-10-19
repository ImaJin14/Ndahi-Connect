async function requestJson(path, options, timeoutMs) {
  const controller = typeof AbortController === "function" ? new AbortController() : null;
  let timer;
  try {
    return await Promise.race([
      (async () => { const response = await fetch(path, { ...options, ...(controller ? { signal: controller.signal } : {}) }); return { response, body: await response.json() }; })(),
      new Promise((_, reject) => { timer = setTimeout(() => { controller?.abort(); reject(Error("Release check timed out")); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

// Compare releases without caching account data or interrupting unfinished work.
export function startUpdates({ isBusy = () => false, intervalMs = 60000, reload = () => location.reload() } = {}) {
  const release = document.querySelector('meta[name="ndahi-release"]');
  if (!release) return;
  const baseline = release.content, dirty = new Set();
  let available = false, checking = false, refreshing = false;
  const notice = document.createElement("aside");
  notice.className = "update-notice";
  notice.hidden = true;
  notice.setAttribute("role", "status");
  notice.innerHTML = '<span>A new version is ready. It will load when your current task is finished.</span><button type="button">Refresh app</button>';
  document.body.appendChild(notice);
  const flowBusy = () => isBusy() || Boolean(document.querySelector('[aria-busy="true"], dialog[open]'));
  const hasEdits = () => {
    dirty.forEach((form) => { if (!form.isConnected) dirty.delete(form); });
    return dirty.size > 0;
  };
  function apply(manual = false) {
    if (!available || refreshing || document.hidden) return;
    const busy = flowBusy(), edits = hasEdits();
    notice.hidden = false;
    document.body.classList.add("has-update-notice");
    notice.querySelector("button").disabled = busy;
    if (busy || (edits && (!manual || !window.confirm("Refresh the app and discard unsaved form changes?")))) return;
    refreshing = true;
    reload();
  }
  notice.querySelector("button").onclick = () => apply(true);
  document.addEventListener("input", (event) => { if (event.target.form) dirty.add(event.target.form); });
  document.addEventListener("reset", (event) => { dirty.delete(event.target); setTimeout(() => apply(), 0); });
  async function check() {
    if (checking || refreshing || document.hidden) return;
    checking = true;
    try {
      const { response, body: version } = await requestJson("/version.json", { cache: "no-store" }, 10000);
      if (response.ok) {
        if (typeof version.revision === "string" && version.revision !== baseline) available = true;
      }
      apply();
    } catch (_) { /* Offline devices check again when they reconnect. */ }
    finally { checking = false; }
  }
  window.addEventListener("pageshow", check);
  window.addEventListener("online", check);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) void check(); });
  // A release already detected while busy can apply after a task finishes,
  // even if a subsequent version check temporarily fails.
  setInterval(() => { apply(); void check(); }, intervalMs);
  void check();
}
