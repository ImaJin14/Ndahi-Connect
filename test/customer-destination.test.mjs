import test from 'node:test';
import assert from 'node:assert/strict';
import { customerDestination, customerEntry } from '../customer-app/customer-destination.js';
import { customerDestination as v2Destination } from '../customer-app-v2/customer-destination.js';
const now = Date.now();
const evidence = () => ({ version: 1, expiresAt: new Date(now + 45000).toISOString(), account: { state: 'authenticated' }, network: { state: 'confirmed' }, subscription: { state: 'active' }, router: { state: 'reachable' }, hotspot: { state: 'authenticated' } });
test('default landing is Dashboard and validated necessary destinations retain only supported intent', () => {
  for (const input of [null, '', '/login', '/verify.html?setup=checkout', '/pair', '/hotspot?next=/login', '/unknown']) assert.equal(customerDestination(input), '/dashboard');
  for (const input of ['/dashboard#payments', '/dashboard#devices', '/dashboard#account', '/dashboard#sessions', '/onboarding.html', '/onboarding.html?plan=weekly', '/onboarding.html?action=renew&plan=weekly']) assert.equal(customerDestination(input), input);
  assert.equal(customerDestination('/dashboard.html?next=https://evil.test&phone=670000000#account'), '/dashboard#account');
  assert.equal(customerDestination('/onboarding.html?action=switch&plan=weekly&quick=1&key=secret'), '/onboarding.html?action=switch&plan=weekly');
  assert.equal(customerDestination('/onboarding?plan=weekly&quick=1&phone=670000000&next=https://evil.test'), '/onboarding.html?plan=weekly');
  assert.equal(customerDestination('/onboarding.html?action=unsupported'), '/dashboard');
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

test('request-review intent survives login without a connection detour or untrusted parameters',()=>{
 const id='11111111-2222-4333-8444-555555555555',url='/pair-review.html?request='+id;
 assert.equal(customerDestination(url+'&key=secret#steal'),url);
 for(const input of ['/pair-review.html','/pair-review.html?request=bad','//evil.test'+url])assert.equal(customerDestination(input),'/dashboard');
 const e=evidence();e.hotspot.state='unauthenticated';
 assert.equal(customerEntry({next:url,evidence:e,hasCandidate:true,hotspotEnabled:true,now}),url);
});

// A purchase started from a scan with no bundle comes back to the scan (#412).
test("v2 sign-in can return to the scan page, with only a valid device hint", () => {
  assert.equal(v2Destination("/voucher-connect.html"), "/voucher-connect.html");
  assert.equal(v2Destination("/voucher-connect.html?mac=aa:bb:cc:dd:ee:31&address=10.20.0.31"), "/voucher-connect.html?mac=AA%3ABB%3ACC%3ADD%3AEE%3A31&address=10.20.0.31");
  // Anything else on the address is dropped; the scan itself never travels in it.
  assert.equal(v2Destination("/voucher-connect.html?mac=bad&address=10.20.0.31&qr=secret#legacy=NC-AAAA-1111"), "/voucher-connect.html");
  assert.equal(v2Destination("//evil.test/voucher-connect.html"), "/dashboard");
  // The frozen v1 portal has no such page to return to.
  assert.equal(customerDestination("/voucher-connect.html"), "/dashboard");
});

test("v2 sign-in returns to a saved voucher opened from Saved vouchers (#356), with only a valid id", () => {
  assert.equal(v2Destination("/voucher-ready.html?voucher=v-new"), "/voucher-ready.html?voucher=v-new");
  assert.equal(v2Destination("/voucher-ready.html?voucher=v-new&code=NC-AAAA-1111&mac=AA:BB:CC:DD:EE:FF"), "/voucher-ready.html?voucher=v-new");
  assert.equal(v2Destination("/voucher-ready.html?voucher=%3Cscript%3E"), "/dashboard");
  assert.equal(v2Destination("/voucher-ready.html?payment=p1&voucher=v-new"), "/voucher-ready.html?payment=p1");
});
