import test from 'node:test';
import assert from 'node:assert/strict';
import { customerDestination, customerEntry } from '../customer-app/customer-destination.js';
const now = Date.now();
const evidence = () => ({ version: 1, expiresAt: new Date(now + 45000).toISOString(), account: { state: 'authenticated' }, network: { state: 'confirmed' }, subscription: { state: 'active' }, router: { state: 'reachable' }, hotspot: { state: 'authenticated' } });
test('default landing is Dashboard and validated necessary destinations retain only supported intent', () => {
  for (const input of [null, '', '/login', '/verify.html?setup=checkout', '/pair', '/hotspot?next=/login', '/onboarding.html', '/unknown']) assert.equal(customerDestination(input), '/dashboard');
  for (const input of ['/dashboard#payments', '/dashboard#devices', '/dashboard#account', '/dashboard#sessions', '/onboarding.html?action=renew&plan=weekly']) assert.equal(customerDestination(input), input);
  assert.equal(customerDestination('/dashboard.html?next=https://evil.test&phone=670000000#account'), '/dashboard#account');
  assert.equal(customerDestination('/onboarding.html?action=switch&plan=weekly&quick=1&key=secret'), '/onboarding.html?action=switch&plan=weekly');
});
test('external, protocol-relative, encoded, malformed and loop destinations cannot leave safe routes', () => {
  for (const input of ['https://evil.test', '//evil.test', '/\\evil.test', '/%5cevil.test', '/%255cevil.test', '/%25255cevil.test', '/%0aLocation:evil', '/dashboard%zz', '/dashboard#unrecognised', '/dashboard/../login', '/login?next=/dashboard', '/verify', '/dashboard\t#account']) assert.equal(customerDestination(input), '/dashboard', input);
});
test('server evidence controls connection completion independently from the default account destination', () => {
  assert.equal(customerEntry({ evidence: evidence(), now }), '/dashboard');
  assert.equal(customerEntry({ evidence: { version: 1, expiresAt: evidence().expiresAt }, now }), '/dashboard');
  const e = evidence(); e.hotspot.state = 'unauthenticated';
  const args = { evidence: e, now, hasCandidate: true, hotspotEnabled: true };
  assert.equal(customerEntry(args), '/hotspot?next=%2Fdashboard');
  assert.equal(customerEntry({ ...args, accountOnly: true }), '/dashboard');
  assert.equal(customerEntry({ ...args, hasCandidate: false }), '/dashboard');
  e.network.state = 'unconfirmed'; assert.equal(customerEntry(args), '/dashboard');
  e.network.state = 'confirmed'; e.router.state = 'unavailable'; assert.equal(customerEntry(args), '/dashboard');
  e.router.state = 'reachable'; e.account.state = 'signed-out'; assert.equal(customerEntry(args), '/dashboard');
  e.account.state = 'authenticated'; e.expiresAt = new Date(now - 1).toISOString(); assert.equal(customerEntry(args), '/dashboard');
});
test('confirmed exhausted bundles show plans without replacing explicit payment/security intent', () => {
  for (const state of ['expired','exhausted','none']) {
    const e = evidence(); e.subscription.state = state;
    assert.equal(customerEntry({ evidence: e, now }), '/dashboard#bundles');
    assert.equal(customerEntry({ evidence: e, now, next: '/dashboard#payments' }), '/dashboard#payments');
    e.network.state = 'unconfirmed'; assert.equal(customerEntry({ evidence: e, now }), '/dashboard');
  }
});
