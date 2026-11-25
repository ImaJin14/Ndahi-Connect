// Insights (canvas: AdminInsights, #382; owner decisions 25 Nov), owners only.
// Everything comes from GET /api/admin/insights for the chosen 7, 30 or 90
// Douala days: the four figures beside the previous period, revenue per day
// (weekly bars for 90 days), devices online by hour with the busiest window,
// access-point load ("Not measured yet": the access points run standalone)
// with Starlink at peak from the Connections checks, and Wi-Fi page → paid by
// design. Each chart has a text alternative; nothing here is sample data.
import { escapeHtml as h } from "/shared/safe-html.js";
import { format } from "/shared/i18n.js";
import { currentLanguage } from "/shared/ui/dom.js";
import { fcfa } from "/payments.js";

const L = (key, values) => format(key, values || {}, currentLanguage());
const locale = () => (currentLanguage() === "fr" ? "fr-FR" : "en-GB"), ZONE = "Africa/Douala", DAY = 864e5, OFFSET = 36e5;
const PERIODS = [[7, "adminInsightsDays7"], [30, "adminInsightsDays30"], [90, "adminInsightsDays90"]];
const STEP_KEYS = { wifi_page: "adminInsightsStepWifi", signed_in: "adminInsightsStepSignedIn", payment_started: "adminInsightsStepPayment", paid: "adminInsightsStepPaid" };
// "Sat 7 Nov", "sam. 7 nov" (the sentence supplies the full stop).
const dayLabel = (iso, weekday = false) => new Date(iso + "T12:00:00Z").toLocaleDateString(locale(), { ...(weekday ? { weekday: "short" } : {}), day: "numeric", month: "short", timeZone: ZONE }).replace(",", "").replace(/\.$/, "");
const hour = (n) => `${String(n).padStart(2, "0")}:00`;

// The period ends at the next Douala midnight, so today is the last bar.
export function periodRange(days, now = Date.now()) {
  const to = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET + DAY;
  return { from: new Date(to - days * DAY).toISOString(), to: new Date(to).toISOString() };
}

// "▲ 12%" / "▼ 3 pts", or nothing when there is no previous period to compare.
function change(value, unit) {
  if (value === null || value === undefined) return "";
  const up = value >= 0, text = unit === "pts" ? L("adminInsightsPoints", { n: Math.abs(value) }) : `${Math.abs(value)}%`;
  return ` · <span class="admin-insights__${up ? "up" : "down"}"><span aria-hidden="true">${up ? "▲" : "▼"}</span><span class="nd-visually-hidden">${h(L(up ? "adminInsightsUp" : "adminInsightsDown"))}</span> ${h(text)}</span>`;
}
const metric = (value, label) => `<div class="admin-insights__metric"><b>${h(value)}</b><span>${label}</span></div>`;

// Revenue per day, or per week for 90 days, ending today.
export function revenueBars(days, period) {
  if (!days) return null;
  if (period !== 90) return days.map((d) => ({ start: d.date, value: d.net }));
  const weeks = [];
  for (let end = days.length; end > 0; end -= 7) {
    const slice = days.slice(Math.max(0, end - 7), end);
    weeks.unshift({ start: slice[0].date, value: slice.reduce((n, d) => n + d.net, 0) });
  }
  return weeks;
}

function revenuePanel(data, period) {
  const bars = revenueBars(data.collections.days, period), words = L(period === 90 ? "adminInsightsLast90" : "adminInsightsLastN", { n: period });
  if (!bars) return `<p class="admin-insights__sub">${h(L("adminInsightsRevenueReview"))}</p>`;
  const max = Math.max(...bars.map((b) => b.value), 0), top = max > 0 ? bars.find((b) => b.value === max) : null;
  const tallest = top ? L(period === 90 ? "adminInsightsTallestWeek" : "adminInsightsTallestDay", { day: dayLabel(top.start, period !== 90) }) : L("adminInsightsNoRevenue");
  const alt = top ? L("adminInsightsRevenueAlt", { period: words, total: fcfa(bars.reduce((n, b) => n + b.value, 0)), day: dayLabel(top.start, period !== 90), amount: fcfa(max) }) : L("adminInsightsRevenueAltNone", { period: words });
  return `<p class="admin-insights__sub">${h(L("adminInsightsRevenueSub", { period: words }))} ${h(tallest)}</p>
<div class="admin-insights__bars" role="img" aria-label="${h(alt)}">${bars.map((b, i) => {
    const pct = max > 0 ? Math.max(0, (b.value / max) * 100) : 0, tone = i === bars.length - 1 ? "today" : pct >= 85 ? "high" : "";
    return `<span class="admin-insights__bar${tone ? " admin-insights__bar--" + tone : ""}" data-height="${pct.toFixed(1)}" title="${h(`${dayLabel(b.start, period !== 90)} · ${fcfa(b.value)}`)}"></span>`;
  }).join("")}</div>
<div class="admin-insights__axis"><span>${h(dayLabel(bars[0].start))}</span><span>${h(L("adminInsightsToday"))}</span></div>`;
}

function hoursPanel(data) {
  const hours = data.devices.hours, busiest = data.summary.busiest, max = Math.max(...hours.map((x) => x.average || 0), 0);
  const sub = busiest ? L("adminInsightsHoursSub", { from: hour(busiest.from), to: hour(busiest.to) }) : L("adminInsightsHoursNone");
  const alt = busiest ? L("adminInsightsHoursAlt", { from: hour(busiest.from), to: hour(busiest.to) }) : L("adminInsightsHoursAltNone");
  return `<p class="admin-insights__sub">${h(sub)}</p>
<div class="admin-insights__heat" role="img" aria-label="${h(alt)}">${hours.map((x) => `<span data-alpha="${(0.08 + (max && x.average ? x.average / max : 0) * 0.92).toFixed(2)}" title="${h(x.average === null ? `${hour(x.hour)} · —` : L("adminInsightsHourTitle", { hour: hour(x.hour), count: x.average.toLocaleString(locale()) }))}"></span>`).join("")}</div>
<div class="admin-insights__axis"><span>00</span><span>06</span><span>12</span><span>18</span><span>23</span></div>`;
}

function funnelPanel(data, words) {
  const f = data.summary.funnel, bar = (pct, tone) => `<i class="admin-insights__fbar admin-insights__fbar--${tone}" data-width="${pct === null ? 0 : (pct * 0.85).toFixed(1)}"></i>`;
  const rows = f.steps.map((step, i) => `<div class="admin-insights__frow"><span class="admin-insights__fstep">${h(L(STEP_KEYS[step]))}</span><div class="admin-insights__fbars">
  <div>${bar(f.current ? f.current[i] : null, "current")}<span class="admin-insights__fpct">${h(f.current ? `${f.current[i]}%` : "—")}</span></div>
  <div>${bar(f.next ? f.next[i] : null, "new")}<span class="admin-insights__fpct admin-insights__fpct--new">${h(f.next ? `${f.next[i]}%` : "—")}</span></div></div></div>`).join("");
  const parts = [];
  if (f.paidPoints !== null) parts.push(L("adminInsightsFunnelPaid", { points: `<strong class="admin-insights__${f.paidPoints >= 0 ? "up" : "down"}">${h(L(f.paidPoints >= 0 ? "adminInsightsPlusPoints" : "adminInsightsMinusPoints", { n: Math.abs(f.paidPoints) }))}</strong>` }));
  if (f.biggestGain) parts.push(h(L("adminInsightsFunnelGain", { from: L("adminInsightsGain_" + f.biggestGain.from), to: L("adminInsightsGain_" + f.biggestGain.to) })));
  if (f.newShare !== null) parts.push(h(L("adminInsightsFunnelShare", { pct: f.newShare })));
  return `<p class="admin-insights__sub">${h(L("adminInsightsFunnelSub", { period: words }))}</p><div class="admin-insights__funnel">${rows}</div>${parts.length ? `<p class="admin-insights__fnote">${parts.join(" ")}</p>` : ""}`;
}

export function insightsMarkup(data, period) {
  const s = data.summary.figures, words = L(period === 90 ? "adminInsightsLast90" : "adminInsightsLastN", { n: period });
  const count = (n) => (n === null || n === undefined ? "—" : Number(n).toLocaleString(locale()));
  return `<div class="admin-insights__metrics">
${metric(s.revenue.value === null ? "—" : fcfa(s.revenue.value), h(L("adminInsightsRevenue")) + change(s.revenue.change) + (s.revenue.change !== null ? " " + h(L("adminInsightsVsPrevious")) : ""))}
${metric(count(s.bundlesSold.value), h(L("adminInsightsBundles")) + change(s.bundlesSold.change))}
${metric(count(s.payingCustomers.value), h(L("adminInsightsCustomers")) + change(s.payingCustomers.change))}
${metric(s.boughtAgain.value === null ? "—" : `${s.boughtAgain.value}%`, h(L("adminInsightsBoughtAgain")) + change(s.boughtAgain.changePoints, "pts"))}
</div>
<section class="admin-insights__panel" aria-labelledby="insightsRevenueTitle"><h2 class="admin-insights__h2" id="insightsRevenueTitle">${h(L("adminInsightsRevenueTitle"))}</h2>${revenuePanel(data, period)}</section>
<div class="admin-insights__row">
<section class="admin-insights__panel admin-insights__half" aria-labelledby="insightsHoursTitle"><h2 class="admin-insights__h2" id="insightsHoursTitle">${h(L("adminInsightsHoursTitle"))}</h2>${hoursPanel(data)}</section>
<section class="admin-insights__panel admin-insights__half admin-insights__aps" aria-labelledby="insightsApsTitle"><div><h2 class="admin-insights__h2" id="insightsApsTitle">${h(L("adminInsightsApsTitle"))}</h2><p class="admin-insights__sub admin-insights__sub--flush">${h(L("adminInsightsApsSub", data.summary.busiest ? { from: hour(data.summary.busiest.from), to: hour(data.summary.busiest.to) } : { from: "19:00", to: "22:00" }))}</p></div>
<p class="admin-insights__empty">${h(L("adminInsightsApsNone"))}</p>${data.summary.uplinkAtPeakMbps !== null ? `<p class="admin-insights__note">${h(L("adminInsightsUplinkPeak", { mbps: data.summary.uplinkAtPeakMbps.toLocaleString(locale()) }))}</p>` : ""}</section>
</div>
<section class="admin-insights__panel" aria-labelledby="insightsFunnelTitle"><div class="admin-insights__fhead"><h2 class="admin-insights__h2" id="insightsFunnelTitle">${h(L("adminInsightsFunnelTitle"))}</h2><span class="admin-insights__legend"><span><i class="admin-insights__swatch admin-insights__swatch--current"></i>${h(L("adminInsightsCurrentDesign"))}</span><span><i class="admin-insights__swatch admin-insights__swatch--new"></i>${h(L("adminInsightsNewDesign"))}</span></span></div>${funnelPanel(data, words)}</section>`;
}

// The page's CSP refuses style attributes, so bar heights, heat shades and
// funnel widths are set through the DOM once the markup is in place.
export function paint(host) {
  host.querySelectorAll("[data-height]").forEach((el) => { el.style.height = `${el.dataset.height}%`; });
  host.querySelectorAll("[data-alpha]").forEach((el) => { el.style.backgroundColor = `rgba(0, 59, 43, ${el.dataset.alpha})`; });
  host.querySelectorAll("[data-width]").forEach((el) => { el.style.width = `${el.dataset.width}%`; });
}

export function mountInsights(host, periodsHost, { call }) {
  if (!host) return { show() {} };
  let period = 30, request = 0, loaded = false;
  const renderPeriods = () => {
    if (!periodsHost) return;
    periodsHost.innerHTML = PERIODS.map(([days, key]) => `<button type="button" class="admin-period" data-insights-period="${days}" aria-pressed="${days === period}">${h(L(key))}</button>`).join("");
    periodsHost.querySelectorAll("[data-insights-period]").forEach((button) => { button.onclick = () => { period = Number(button.dataset.insightsPeriod); renderPeriods(); void load(); }; });
  };
  async function load() {
    const current = ++request, { from, to } = periodRange(period);
    host.setAttribute("aria-busy", "true");
    if (!loaded) host.innerHTML = `<p class="nd-meta">${h(L("adminLoading"))}</p>`;
    try {
      const data = await call(`/api/admin/insights?${new URLSearchParams({ from, to })}`);
      if (current !== request || !host.isConnected) return;
      host.innerHTML = insightsMarkup(data, period);
      paint(host);
      loaded = true;
    } catch (error) {
      if (current !== request) return;
      host.innerHTML = `<p class="nd-callout nd-callout--warning" role="status">${h(error.message || L("adminInsightsFailed"))}</p>`;
    } finally { if (current === request) host.removeAttribute("aria-busy"); }
  }
  renderPeriods();
  return { show: () => load() };
}
