// Wi-Fi page → paid funnel (#262, Insights). A visit starts when the Wi-Fi
// page opens for someone who is not signed in; its later steps (signed in or
// signed up, payment started, paid) count once each, and only within a visit
// that started there. The visit lives in this tab's sessionStorage and ends
// after six hours. The API receives only the step and the design variant: no
// identifier, account, phone, URL or time of its own.
const KEY = "ndahi-funnel-visit";
const STEPS = ["wifi_page", "signed_in", "payment_started", "paid"];
const VISIT_MS = 6 * 3600000;
const variant = document.documentElement.dataset.uiVariant === "v2" ? "v2" : "v1";

function send(step) {
  const apiUrl = window.NDAHI_CONFIG?.apiUrl;
  if (!apiUrl) return;
  void fetch(`${apiUrl.replace(/\/$/, "")}/api/telemetry/funnel`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ step, variant }),
    credentials: "omit",
    keepalive: true,
  }).catch(() => {});
}

export function funnelStep(step) {
  if (!STEPS.includes(step)) return;
  let visit;
  try {
    visit = JSON.parse(sessionStorage.getItem(KEY) || "null");
    if (visit && !(Date.now() - visit.at < VISIT_MS)) visit = null;
    if (step === "wifi_page") {
      if (visit) return;
      visit = { at: Date.now(), done: [] };
    } else if (!visit || visit.done.includes(step)) return;
    visit.done.push(step);
    sessionStorage.setItem(KEY, JSON.stringify(visit));
  } catch {
    // Without storage a visit cannot be followed; nothing is counted.
    return;
  }
  send(step);
}
