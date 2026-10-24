// Navigation is presentation only. Every destination still authenticates and
// authorizes its own account, checkout, device and router actions on the server.
const views = ['home','bundles','vouchers','payments','account','devices','sessions','sessionActivity','accountSecurity','managePlan','billing'];
export function customerDestination(input, fallback = '/dashboard') {
  if (typeof input !== 'string' || input.length > 1500 || input[0] !== '/' || input.slice(0, 2) === '//') return fallback;
  let decoded = input;
  try {
    for (let i = 0; i < 3; i++) {
      if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.slice(0, 2) === '//') return fallback;
      const next = decodeURIComponent(decoded); if (next === decoded) break; decoded = next;
    }
    if (/[\\\x00-\x20\x7f]/.test(decoded) || decoded.slice(0, 2) === '//') return fallback;
    const url = new URL(input, 'https://portal.invalid');
    if (url.origin !== 'https://portal.invalid' || url.username || url.password) return fallback;
    const clean = new URL('/dashboard', url.origin);
    if (['/dashboard','/dashboard.html'].includes(url.pathname)) {
      if (url.hash && !views.includes(url.hash.slice(1))) return fallback;
      clean.hash = url.hash;
      // These open a verified setup panel; they never grant access.
      if (url.searchParams.get('setup') === 'passkey') clean.searchParams.set('setup', 'passkey');
      const main = url.searchParams.get('main-device');
      if (/^(?:[A-F0-9]{2}:){5}[A-F0-9]{2}$/i.test(main || '')) clean.searchParams.set('main-device', main.toUpperCase());
    } else if (['/onboarding','/onboarding.html'].includes(url.pathname) && ['renew','switch'].includes(url.searchParams.get('action'))) {
      clean.pathname = '/onboarding.html'; clean.searchParams.set('action', url.searchParams.get('action'));
      const plan = url.searchParams.get('plan');
      if (/^[A-Za-z0-9_-]{1,80}$/.test(plan || '')) clean.searchParams.set('plan', plan);
      if (url.searchParams.get('upgrade') === '1') clean.searchParams.set('upgrade', '1');
    } else return fallback;
    return clean.pathname + clean.search + clean.hash;
  } catch (_) { return fallback; }
}
export function customerEntry({ next, evidence, accountOnly, hasCandidate, hotspotEnabled, now = Date.now() }) {
  const target = customerDestination(next);
  const fresh = evidence && evidence.version === 1 && Number.isFinite(Date.parse(evidence.expiresAt)) && Date.parse(evidence.expiresAt) > now;
  if (!fresh || !evidence.account || !evidence.network || !evidence.subscription || !evidence.router || !evidence.hotspot || evidence.account.state !== 'authenticated') return target;
  const inside = evidence.network.state === 'confirmed';
  if (inside && ['expired','exhausted','none'].includes(evidence.subscription.state) && target === '/dashboard') return '/dashboard#bundles';
  if (!accountOnly && hotspotEnabled && hasCandidate && inside && evidence.subscription.state === 'active' && evidence.router.state === 'reachable' && evidence.hotspot.state !== 'authenticated') {
    return '/hotspot?next=' + encodeURIComponent(target);
  }
  return target;
}
