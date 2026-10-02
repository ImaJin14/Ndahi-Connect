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
  await assert.rejects(checkDeployment(options), /expected HTTP 200/);
});
test('deployment rejects wrong payment provider', async t => {
  const options = await fixture(t, { '/api/plans': () => Response.json({ plans: [{}], paymentProvider: 'mock' }) });
  await assert.rejects(checkDeployment(options), /Unexpected payment provider/);
});
