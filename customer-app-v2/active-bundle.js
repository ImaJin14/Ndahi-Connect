// The Home bundle card (redesign): plan, status, data left with a meter, expiry
// countdown and devices, then consumed / allowance / expiry; in a renewal moment
// (renewal.js) the PhoneRenew card instead. data-balance.js
// re-renders it in place, so it stays an HTML string and holds no links or
// buttons (those sit beside #dataBalance). The data-* hooks and the English
// wording match v1, which the browser journeys check.
import { escapeHtml as h } from '/shared/safe-html.js';
import { formatDataBalance, formatExpiryCountdown, fuelStatusClass, dataWarning } from '/shared/data-usage.js';
import { format } from '/shared/i18n.js';
import { currentLanguage } from '/shared/ui/dom.js';

const L = (key, values) => format(key, values || {}, currentLanguage());
// Preserve the established English hooks while formatting French values without
// changing the underlying API evidence or byte units (decimal, like v1).
function fmt(bytes) {
  if (currentLanguage() !== 'fr') return formatDataBalance(bytes);
  if (bytes === null) return L('homeDataUnlimited');
  if (!Number.isFinite(bytes)) return L('homeValueUnavailable');
  const value = Math.max(0, bytes);
  if (value > 0 && value < 1000) return L('homeDataTiny');
  const gb = value >= 1e9;
  const amount = (value / (gb ? 1e9 : 1e6)).toLocaleString('fr', { maximumFractionDigits: gb ? 2 : 3 });
  return L(gb ? 'homeDataGb' : 'homeDataMb', { amount });
}
export function homeExpiryCountdown(expiresAt, now = Date.now()) {
  if (currentLanguage() !== 'fr') return formatExpiryCountdown(expiresAt, now);
  const target = Date.parse(expiresAt);
  if (!Number.isFinite(target)) return null;
  const diff = target - Number(now);
  if (diff <= 0) return L('homeStatusExpired');
  const hours = Math.floor(diff / 36e5), days = Math.floor(hours / 24);
  if (days > 0) return L(days === 1 ? 'homeEndsDay' : 'homeEndsDays', { count: days });
  const minutes = Math.floor((diff % 36e5) / 6e4);
  return hours ? L('homeEndsHours', { count: hours, minutes }) : L('homeEndsMinutes', { count: Math.max(1, minutes) });
}
const STATUS = { active: ['homeStatusActive', 'success'], expired: ['homeStatusExpired', ''], exhausted: ['homeStatusExhausted', 'danger'], suspended: ['homeStatusSuspended', 'danger'] };
const METER_TONE = { 'fuel-warning': ' nd-meter-bar--warning', 'fuel-danger': ' nd-meter-bar--danger' };

function heading(title) {
  return `<p class="nd-eyebrow">${h(L('activeBundle'))}</p><h2 class="home-card__plan">${h(title)}</h2>`;
}

// Renewal moments (#252, canvas: PhoneRenew). Home changes when four fifths of
// a bundle's data is gone, on the last day of a bundle that lasts longer than a
// day and a half (a Daily bundle is always on its last day), and once the last
// bundle has ended. null is an ordinary Home.
export function renewalMoment(snapshot, now = Date.now()) {
  const v = snapshot && snapshot.bundle;
  if (!v || v.accessMode === 'home') return null;
  if (!snapshot.activeId) return v.status === 'expired' || v.status === 'exhausted' ? 'ended' : null;
  const ends = Date.parse(v.expiresAt), started = Date.parse(v.activatedAt);
  // Past its end the card is confirming expiry, not counting down.
  if (v.status !== 'active' || !(ends > now)) return null;
  if (v.quotaBytes > 0 && Number.isFinite(v.usedBytes) && v.usedBytes >= 0.8 * v.quotaBytes && v.usedBytes < v.quotaBytes) return 'lowData';
  if (ends <= now + 864e5 && !(ends - started <= 1.5 * 864e5)) return 'endsSoon';
  return null;
}

// Times and dates as the canvas writes them: "18:03", "15 Nov".
const locale = () => (currentLanguage() === 'fr' ? 'fr-FR' : 'en-GB');
const timeOf = (at) => new Date(at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
const dateOf = (at) => new Date(at).toLocaleDateString(locale(), { day: 'numeric', month: 'short' });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
// "1.0 GB" in the figure and "1 GB" in the pill; under a gigabyte both read as MB.
const figure = (bytes) => (bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : fmt(bytes));
const short = (bytes) => (bytes >= 1e9 ? +(bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB');
// "18:03 tomorrow" / "18:03 today" (a moment only ever ends today or tomorrow).
const whenOf = (at, now) => L(sameDay(at, now) ? 'homeRenewWhenToday' : 'homeRenewWhenTomorrow', { time: timeOf(at) });
function endedPhrase(at, now) {
  if (!Number.isFinite(Date.parse(at))) return L('homeRenewEndedUnknown');
  const time = timeOf(at);
  return sameDay(at, now) ? L('homeRenewEndedToday', { time }) : sameDay(Date.parse(at) + 864e5, now) ? L('homeRenewEndedYesterday', { time }) : L('homeRenewEndedOn', { date: dateOf(at), time });
}

// The moment's card: plan, pill, the figure and its meter, and one line on what
// happens next. Freshness shows only when the balance is not current (the
// canvas has no line for the usual case) and from 90% used the data warning;
// unlimited bundles show data used.
function momentContent(snapshot, moment, { now, unavailable, paused }) {
  const v = snapshot.bundle, unlimited = v.quotaBytes === null, known = Number.isFinite(v.usedBytes);
  const remaining = !unlimited && known && v.quotaBytes > 0 ? Math.max(0, v.quotaBytes - v.usedBytes) : undefined;
  const ended = moment === 'ended', today = !ended && sameDay(v.expiresAt, now);
  const [pill, tone] = ended ? [v.status === 'exhausted' ? L('homeStatusExhausted') : L('homeRenewPillEnded'), '']
    : moment === 'lowData' ? [L('homeRenewPillLeft', { amount: short(remaining) }), 'warning']
    : [L(today ? 'homeRenewPillToday' : 'homeRenewPillTomorrow'), 'warning'];
  const used = `<span data-used-data>${h(known ? figure(v.usedBytes) : L('homeValueUnavailable'))}</span>`;
  const big = ended
    ? unlimited ? `${used} <span class="nd-figure__unit">${h(L('homeRenewUsed', { when: endedPhrase(v.endedAt, now) }))}</span>`
      : `<span data-remaining-data>${h(v.status === 'exhausted' ? fmt(0) : L('homeRenewNone'))}</span> <span class="nd-figure__unit">${h(endedPhrase(v.endedAt, now))}</span>`
    : unlimited ? `${used} <span class="nd-figure__unit">${h(L('homeRenewUsed', { when: L('homeRenewEnds', { when: whenOf(v.expiresAt, now) }) }))}</span>`
    : `<span data-remaining-data>${h(remaining === undefined ? L('homeValueUnavailable') : figure(remaining))}</span> <span class="nd-figure__unit">${h(moment === 'lowData' ? L('homeRenewOfLeft', { quota: short(v.quotaBytes) }) : L('homeRenewLeft', { when: L('homeRenewEnds', { when: whenOf(v.expiresAt, now) }) }))}</span>`;
  const meter = unlimited || (!ended && remaining === undefined) ? ''
    : `<progress class="nd-meter-bar home-renew__meter" max="100" value="${ended ? 0 : (remaining / v.quotaBytes * 100).toFixed(1)}" aria-hidden="true"></progress>`;
  const note = ended ? L('homeRenewNoteEnded') : moment === 'lowData' ? L('homeRenewNoteLow', { date: dateOf(v.expiresAt) })
    : L(unlimited ? 'homeRenewNoteSoonUnlimited' : 'homeRenewNoteSoon', { when: whenOf(v.expiresAt, now) });
  const evidenceExpired = Number.isFinite(Date.parse(snapshot.expiresAt)) && Date.parse(snapshot.expiresAt) <= now;
  const fresh = unavailable ? 'homeFreshUnavailable' : paused ? 'homeFreshPaused' : ended ? ''
    : evidenceExpired ? 'homeFreshExpired' : v.usage.state === 'stale' ? 'homeFreshStale' : v.usage.state === 'unavailable' ? 'homeFreshNone' : '';
  // From 90% used the warning the notification also gives stays on the card,
  // as on the ordinary card; at the canvas's 80% there is none.
  const warning = moment === 'lowData' ? dataWarning(v) : null;
  // A bundle that ran out of data says so, as the "data used up" notice does.
  const message = [fresh ? L(fresh) : '', ended && v.status === 'exhausted' ? L('homeDataUsedUp') : '', warning === 'low' ? L('homeLowData', { amount: fmt(remaining) }) : warning === '90' ? L('homeOver90') : ''].filter(Boolean).join(' ');
  const provisioning = ended ? '' : v.provisioning === 'dead_letter' ? `<p class="nd-error" role="alert">${h(L('homeProvisionFailed'))}</p>` : v.provisioning === 'pending' ? `<p class="nd-meta">${h(L('homeProvisionPending'))}</p>` : '';
  return `<div class="home-card__top"><div><p class="nd-eyebrow">${h(L(ended ? 'homeRenewLastBundle' : 'activeBundle'))}</p><h2 class="home-card__plan">${h(v.plan.name)}</h2></div><p class="nd-pill${tone ? ' nd-pill--' + tone : ''}" data-bundle-status role="status">${h(pill)}</p></div>
    <p class="nd-figure home-card__figure">${big}</p>${meter}
    <p class="home-renew__note">${h(note)}</p>
    <p id="dataBalanceMessage" class="nd-meta home-card__message" role="status">${h(message)}</p>${provisioning}`;
}

export function activeBundleContent(snapshot, { now = Date.now(), unavailable = false, paused = false } = {}) {
  const v = snapshot && snapshot.bundle;
  if (!v) return unavailable
    ? `${heading(L('homeStatusUnavailableTitle'))}<p class="nd-meta" role="status">${h(L('homeStatusUnavailableBody'))}</p>`
    : `${heading(L('noActiveBundle'))}<p class="nd-meta">${h(L('homeNoBundleBody'))}</p>`;
  const moment = renewalMoment(snapshot, now);
  if (moment) return momentContent(snapshot, moment, { now, unavailable, paused });
  if (v.status === 'expired' && !snapshot.activeId && !unavailable && !paused) {
    return `<div class="home-card__top"><div>${heading(L('noActiveBundle'))}</div><p class="nd-pill" data-bundle-status role="status">${h(L('homeStatusExpired'))}</p></div><p class="nd-meta">${h(L('homeNoBundleBody'))}</p><p class="nd-meta">${h(L('homeExpiredBody'))}</p>`;
  }
  const awaiting = v.status === 'active' && Number.isFinite(Date.parse(v.expiresAt)) && Date.parse(v.expiresAt) <= now;
  const [statusKey, tone] = awaiting ? ['homeStatusConfirming', 'warning'] : STATUS[v.status] || ['unavailable', ''];
  const known = Number.isFinite(v.usedBytes), limited = Number.isFinite(v.quotaBytes);
  const percent = limited && known && v.quotaBytes > 0 ? Math.min(100, v.usedBytes / v.quotaBytes * 100) : null;
  const evidenceExpired = Number.isFinite(Date.parse(snapshot.expiresAt)) && Date.parse(snapshot.expiresAt) <= now;
  const freshness = L(unavailable ? 'homeFreshUnavailable' : paused ? 'homeFreshPaused' : evidenceExpired ? 'homeFreshExpired'
    : v.usage.state === 'stale' ? 'homeFreshStale' : v.usage.state === 'unavailable' ? 'homeFreshNone' : v.usage.state === 'recorded' ? 'homeFreshRecorded' : 'homeFreshConfirmed');
  const warning = dataWarning(v), unlimited = v.quotaBytes === null;
  const quotaLabel = unlimited ? fmt(null) : fmt(v.quotaBytes);
  const remaining = unlimited ? null : known && limited ? Math.max(0, v.quotaBytes - v.usedBytes) : undefined;
  const meterTone = remaining === undefined ? '' : METER_TONE[fuelStatusClass(remaining, v.quotaBytes)] || '';
  const provisioning = v.provisioning === 'dead_letter' ? `<p class="nd-error" role="alert">${h(L('homeProvisionFailed'))}</p>` : v.provisioning === 'pending' ? `<p class="nd-meta">${h(L('homeProvisionPending'))}</p>` : '';
  const fresh = !unavailable && !paused && !evidenceExpired;
  const limit = v.devices.limit === null ? L('homeDevicesUnknown') : v.devices.limit;
  const counted = fresh && v.devices.state === 'fresh';
  const devices = counted ? L('homeDevicesCount', { count: v.devices.count, limit })
    : fresh && v.devices.source === 'account-sessions' ? L(currentLanguage() === 'fr' && v.devices.count === 1 ? 'homeDevicesSession' : 'homeDevicesSessions', { count: v.devices.count, limit })
    : L('homeDevicesUnavailable') + (v.devices.limit === null ? '' : ' ' + L('homeDevicesLimit', { limit: v.devices.limit }));
  const message = [freshness,
    warning === 'low' ? L('homeLowData', { amount: fmt(remaining) }) : warning === '90' ? L('homeOver90') : '',
    v.status === 'exhausted' ? L('homeDataUsedUp') : '',
    awaiting ? L('homeAwaitingExpiry') : ''].filter(Boolean).join(' ');
  // Short day, month and time ("18 Nov, 00:16"); the full instant stays in datetime.
  const expires = Number.isFinite(Date.parse(v.expiresAt)) ? `<time datetime="${h(v.expiresAt)}">${h(new Date(v.expiresAt).toLocaleString(currentLanguage(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</time>` : h(L('homeValueUnavailable'));
  return `<div class="home-card__top"><div>${heading(v.plan.name)}</div><p class="nd-pill${tone ? ' nd-pill--' + tone : ''}" data-bundle-status role="status">${h(L(statusKey))}</p></div>
    <p class="nd-figure home-card__figure"><span data-remaining-data>${h(fmt(remaining))}</span> <span class="nd-figure__unit">${h(unlimited ? L('homeUnlimitedData') : L('homeLeftOf', { quota: quotaLabel }))}</span></p>
    ${percent === null ? '' : `<progress class="nd-meter-bar${meterTone}" max="100" value="${(100 - percent).toFixed(1)}" aria-hidden="true"></progress>`}
    <div class="nd-meter-legend"><span data-expiry-countdown>${h(homeExpiryCountdown(v.expiresAt, now) || L('homeExpiryUnavailable'))}</span>${v.accessMode === 'home' ? `<span>${h(L('homeHomeAccessValue'))}</span>` : `<span><span data-bundle-devices>${h(devices)}</span>${counted ? ' ' + h(L('homeDevicesSuffix')) : ''}</span>`}</div>
    <dl class="home-card__facts"><div><dt>${h(L('homeConsumed'))}</dt><dd data-used-data>${h(known ? fmt(v.usedBytes) : L('homeValueUnavailable'))}${percent === null ? '' : ` (${h(percent.toFixed(1))}%)`}</dd></div><div><dt>${h(L('homeAllowance'))}</dt><dd>${h(quotaLabel)}</dd></div><div><dt>${h(L('homeExpires'))}</dt><dd>${expires}</dd></div></dl>
    <p id="dataBalanceMessage" class="nd-meta home-card__message" role="status">${h(message)}</p>${v.usage.observedAt ? `<p class="nd-meta home-card__recorded">${h(L('homeUsageRecorded', { time: new Date(v.usage.observedAt).toLocaleTimeString(currentLanguage()) }))}</p>` : ''}${provisioning}`;
}

export function bundlePurchaseContent(snapshot) {
  if (snapshot && snapshot.bundle && snapshot.bundle.accessMode === 'home') return `<a class="nd-btn" href="/home-router.html">${h(L('homeHomeRouterAccess'))}</a>`;
  // An active bundle cannot be topped up, so Home offers no purchase links then.
  if (snapshot && snapshot.activeId) return '';
  if (!snapshot || snapshot.purchase.allowed !== true) {
    return `<a class="nd-btn nd-btn--sm nd-btn--secondary" href="/dashboard#bundles">${h(L('homeAllPlans'))}</a><a class="nd-btn nd-btn--sm nd-btn--secondary" href="/dashboard#vouchers">${h(L('homeViewVoucher'))}</a>`;
  }
  const plan = snapshot.bundle && snapshot.bundle.plan;
  return `${plan && !plan.discontinued ? `<button type="button" class="nd-btn" data-quick-renew="${h(plan.id)}">${h(L('homeQuickRenew', { plan: plan.name }))}</button>` : ''}<a class="nd-btn nd-btn--secondary" href="/dashboard#bundles">${h(L('homeChooseBundle'))}</a><a class="nd-btn nd-btn--secondary" href="/dashboard#vouchers">${h(L('homeViewVoucher'))}</a>`;
}
