import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

export async function checkDeployment({ customerUrl, adminUrl, apiUrl, allowBootstrap = false, expectedProvider = 'mesomb', request = fetch }) {
  const bases = [customerUrl, adminUrl, apiUrl].map(value => {
    const url = new URL(value);
    assert.ok(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'Use service origins without credentials or paths');
    assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)), 'Services require HTTPS outside localhost');
    return url.origin;
  });
  assert.equal(new Set(bases).size, 3, 'Each service must have a distinct origin');
  const [customer, admin, api] = bases;
  const passed = [];
  const get = async (base, path, status = 200, headers = {}) => {
    const response = await request(`${base}${path}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, status, `${path}: expected HTTP ${status}, received ${response.status}`);
    return response;
  };
  const health = await (await get(api, '/api/health')).json();
  assert.ok(health.status === 'ready' || (allowBootstrap && health.status === 'bootstrap'), 'API must be ready; bootstrap requires explicit opt-in');
  assert.ok(['postgresql', 'ready'].includes(health.database), 'Deployment requires healthy PostgreSQL');
  passed.push('API/database readiness');
  const plans = await (await get(api, '/api/plans')).json();
  assert.ok(Array.isArray(plans.plans) && plans.plans.length > 0, 'Plan catalogue must not be empty');
  assert.equal(plans.paymentProvider, expectedProvider, 'Unexpected payment provider');
  passed.push('Catalogue and configured provider (live payment still requires acceptance testing)');
  for (const [base, kind] of [[customer, 'customer'], [admin, 'admin']]) {
    const root = await get(base, '/', 302);
    assert.equal(root.headers.get('location'), '/login');
    const page = await get(base, '/login');
    assert.match(page.headers.get('content-type') || '', /text\/html/);
    assert.ok(page.headers.get('content-security-policy'), 'Missing CSP');
    const html = await page.text();
    assert.match(html, /<form\b/i, 'Login form missing');
    const etag = page.headers.get('etag');
    assert.ok(etag, 'Missing page ETag');
    await get(base, '/login', 304, { 'if-none-match': etag });
    const assetPath = html.match(/(?:src|href)="(\/static\/[^"?]+)"/)?.[1];
    assert.ok(assetPath, 'Missing revisioned static asset');
    const asset = await get(base, assetPath);
    assert.match(asset.headers.get('cache-control') || '', /immutable/);
    await asset.arrayBuffer();
    const config = await (await get(base, '/config.js')).text();
    assert.ok(config.includes(JSON.stringify(api)), 'Frontend points at unexpected API');
    assert.ok(config.includes(JSON.stringify(kind)), 'Wrong frontend service');
    passed.push(`${kind} login, API configuration and cache revalidation`);
  }
  await get(customer, '/admin', 404);
  await get(api, '/login', 404);
  await get(api, '/api/account/dashboard', 401);
  await get(api, '/api/admin/dashboard', 401);
  for (const origin of [customer, admin]) {
    const response = await get(api, '/api/plans', 200, { origin });
    assert.equal(response.headers.get('access-control-allow-origin'), origin);
    assert.equal(response.headers.get('access-control-allow-credentials'), 'true');
    await response.arrayBuffer();
  }
  await get(api, '/api/plans', 403, { origin: 'https://untrusted.invalid' });
  await get(api, '/api/admin/dashboard', 403, { origin: customer });
  passed.push('Service separation, authentication gates and CORS');
  return passed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const checks = await checkDeployment({
      customerUrl: process.env.CUSTOMER_APP_URL || 'https://portal.ndahiconnect.net',
      adminUrl: process.env.ADMIN_APP_URL || 'https://admin.ndahiconnect.net',
      apiUrl: process.env.API_URL || 'https://api.ndahiconnect.net',
      allowBootstrap: process.env.SMOKE_ALLOW_BOOTSTRAP === 'true',
      expectedProvider: process.env.SMOKE_PAYMENT_PROVIDER || 'mesomb',
    });
    for (const check of checks) console.log(`PASS ${check}`);
  } catch (error) {
    console.error(`Deployment smoke check failed: ${error instanceof assert.AssertionError ? error.message : 'Request failed or service URL is invalid'}`);
    process.exitCode = 1;
  }
}
