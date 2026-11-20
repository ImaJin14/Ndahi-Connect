import test from 'node:test';
import assert from 'node:assert/strict';
import { createStaticServer } from '../static-server.mjs';
import { checkDeployment } from '../scripts/check-deployment.mjs';

async function fixture(t, overrides = {}) {
  const apiUrl = 'http://127.0.0.1:9999';
  const servers = ['customer', 'admin'].map(kind => createStaticServer(kind, { apiUrl }));
  for (const server of servers) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  }
  const [customerUrl, adminUrl] = servers.map(server => `http://127.0.0.1:${server.address().port}`);
  const request = async (url, options) => {
    if (!url.startsWith(apiUrl)) return fetch(url, options);
    const path = new URL(url).pathname;
    if (overrides[path]) return overrides[path]();
    const origin = options.headers.origin;
    if (origin && (origin === 'https://untrusted.invalid' || (path.startsWith('/api/admin/') && origin === customerUrl))) return new Response('{}', { status: 403 });
    if (path.includes('dashboard')) return new Response('{}', { status: 401 });
    if (path === '/login') return new Response('{}', { status: 404 });
    return Response.json(path === '/api/health' ? { status: 'ready', database: 'postgresql' } : { plans: [{ id: 'daily' }], paymentProvider: 'mesomb' }, {
      headers: origin ? { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true' } : {},
    });
  };
  return { customerUrl, adminUrl, apiUrl, request };
}

test('deployment checks real frontend routing, configuration and revisioned caching', async t => {
  assert.equal((await checkDeployment(await fixture(t))).length, 5);
});
for (const [name, health] of [
  ['bootstrap', { status: 'bootstrap', database: 'ready' }],
  ['local database', { status: 'ready', database: 'local' }],
]) test(`deployment rejects ${name}`, async t => {
  const options = await fixture(t, { '/api/health': () => Response.json(health) });
  await assert.rejects(checkDeployment(options));
});
test('deployment rejects unavailable API', async t => {
  const options = await fixture(t, { '/api/health': () => new Response('{}', { status: 503 }) });
  // A 503 that lasts through the retries still fails the check.
  await assert.rejects(checkDeployment({ ...options, retryDelayMs: 0 }), /expected HTTP 200, received 503/);
});
test('deployment rejects wrong payment provider', async t => {
  const options = await fixture(t, { '/api/plans': () => Response.json({ plans: [{}], paymentProvider: 'mock' }) });
  await assert.rejects(checkDeployment(options), /Unexpected payment provider/);
});

test('retirement deployment smoke validates the effective runtime policy', async t => {
 const policy={authenticatorRetired:true,supportedCustomerMethods:['pin','passkey'],supportedAdminMethods:['password','passkey']};
 const options=await fixture(t,{'/api/authentication-policy':()=>Response.json(policy)});
 assert.equal((await checkDeployment({...options,expectAuthenticatorRetired:true})).length,6);
 policy.authenticatorRetired=false;
 await assert.rejects(checkDeployment({...options,expectAuthenticatorRetired:true}),/sign-in must be disabled/);
});

// A service still restarting during a deploy: connection errors and 502/503
// are retried, a wrong answer is not, and a lasting failure names the request.
test('deployment retries a service that is still restarting, never a wrong answer', async t => {
  let health = 0, plans = 0;
  const flaky = await fixture(t, {
    '/api/health': () => { if (++health < 3) throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }); return Response.json({ status: 'ready', database: 'postgresql' }); },
  });
  assert.equal((await checkDeployment({ ...flaky, retryDelayMs: 0 })).length, 5);
  assert.equal(health, 3);
  const starting = await fixture(t, { '/api/health': () => (++plans < 2 ? new Response('', { status: 503 }) : Response.json({ status: 'ready', database: 'postgresql' })) });
  assert.equal((await checkDeployment({ ...starting, retryDelayMs: 0 })).length, 5);
  const down = await fixture(t, { '/api/health': () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }); } });
  await assert.rejects(checkDeployment({ ...down, retryDelayMs: 0 }), /GET http:\/\/127\.0\.0\.1:9999\/api\/health failed after 4 attempts: ECONNREFUSED/);
  let wrong = 0;
  const unavailable = await fixture(t, { '/api/health': () => { wrong++; return new Response('{}', { status: 500 }); } });
  await assert.rejects(checkDeployment({ ...unavailable, retryDelayMs: 0 }), /expected HTTP 200, received 500/);
  assert.equal(wrong, 1, 'an error answer is reported at once');
});
