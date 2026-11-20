// Home during an outage and after it (#259, canvas: PhoneOutage). Staff post
// the notice; the dashboard's `outage` says "down" (the notice) or, for a day
// after the fix, "restored" with the hours this customer's bundle got back.
import { escapeHtml as h } from '/shared/safe-html.js';
import { format } from '/shared/i18n.js';
import { currentLanguage } from '/shared/ui/dom.js';

const L = (key, values) => format(key, values || {}, currentLanguage());
const time = (at) => new Date(at).toLocaleTimeString(currentLanguage() === 'fr' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Africa/Douala' });
const WIFI_OFF = 'M2 9a15 15 0 0 1 20 0M5.5 12.5a10 10 0 0 1 13 0M9 16a5 5 0 0 1 6 0M12 19.5h.01M3 3l18 18', CHECK = 'm5 12 5 5 9-10';

export function outageBanner(outage) {
  if (!outage) return '';
  const down = outage.state === 'down', lang = currentLanguage() === 'fr' ? 'fr' : 'en';
  const hours = outage.addedHours === 1 ? L('homeOutageOneHour') : L('homeOutageHours', { count: outage.addedHours });
  const title = down ? L('homeOutageTitle', { area: outage.area }) : L('homeRestoredTitle');
  const body = down ? [outage.message[lang] || outage.message.en, outage.lastUpdate].filter(Boolean).join(' ')
    : outage.addedHours ? L('homeRestoredBody', { hours }) : L('homeRestoredBodyNone');
  const meta = down ? [L('homeOutageUpdated', { time: time(outage.updatedAt) }), outage.nextUpdateBy ? L('homeOutageNext', { time: time(outage.nextUpdateBy) }) : ''].filter(Boolean).join(' · ')
    : L('homeRestoredMeta', { from: time(outage.startedAt), to: time(outage.fixedAt) });
  return `<section class="home-outage home-outage--${down ? 'down' : 'restored'}" role="status" aria-label="${h(L(down ? 'homeOutageLabel' : 'homeRestoredLabel'))}">
    <span class="home-outage__icon"><svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${down ? WIFI_OFF : CHECK}"></path></svg></span>
    <span class="home-outage__text"><strong>${h(title)}</strong><span>${h(body)}</span><span class="home-outage__meta">${h(meta)}</span></span></section>`;
}

// The hero's one-line network status while it is down.
export function outageLine(outage) {
  return outage && outage.state === 'down' ? `<p class="home-outage-line"><span class="home-outage-line__dot" aria-hidden="true"></span>${h(L('homeOutageLine', { area: outage.area }))}</p>` : '';
}
