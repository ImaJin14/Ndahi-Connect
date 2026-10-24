import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, createStore } from '../server.mjs';
import { hashSecret } from '../lib/security.mjs';
import { phone, phoneOk } from '../lib/api/state.mjs';
import { normalizeCameroonPhone, validCameroonPhone, suggestedPaymentNetwork, paymentNetworkSelection } from '../shared-app/cameroon-phone.js';

test('shared normalization accepts local/international formatting and rejects malformed numbers', () => {
  for (const value of ['670123456', '670 123 456', '(670)-123-456', '+237 670123456', '237670123456', '00237 670123456']) {
    assert.equal(normalizeCameroonPhone(value), '670123456');assert.equal(phone(value), '670123456');assert.equal(phoneOk(value), true);
  }
  for (const value of ['', null, '67012345', '6701234567', '+236670123456', '670abc123456', '670/123/456', '++237670123456', { phone:'670123456' }]) {
    assert.equal(validCameroonPhone(value), false);assert.equal(phoneOk(value), false);assert.equal(suggestedPaymentNetwork(value), null);
  }
});
test('only verified numbering blocks suggest a supported operator, including exact boundaries', () => {
  for (const prefix of ['650','651','652','653','654','670','679']) for(const suffix of ['000000','999999']) assert.equal(suggestedPaymentNetwork(prefix+suffix),'mtn');
  for (const prefix of ['655','656','657','658','659','690','699']) for(const suffix of ['000000','999999']) assert.equal(suggestedPaymentNetwork('+237'+prefix+suffix),'orange');
  for (const prefix of ['600','649','660','669','680','689']) assert.equal(suggestedPaymentNetwork(prefix+'123456'),null);
});
test('manual selection survives formatting and revisiting the same payer; saved payments remain locked', () => {
  const select=paymentNetworkSelection();
  assert.equal(select({number:'670123456'}).network,'mtn');
  assert.equal(select({number:'670123456',network:'orange',manual:true}).network,'orange');
  assert.equal(select({number:'+237 (670) 123-456',network:'mtn'}).network,'orange');
  assert.equal(select({number:'690123456'}).network,'orange');
  assert.equal(select({number:'670123456'}).network,'orange');
  assert.equal(select({number:'680123456'}).network,'');
  assert.equal(select({number:'680123456',network:'mtn',manual:true}).network,'mtn');
  assert.equal(select({number:'655123456',network:'mtn',locked:true}).network,'mtn');
  assert.equal(select({number:'655123456'}).network,'mtn');
});

async function fixture(t) {
  const store=createStore({persistent:false}),sent=[],secret='payment-network-fixture';
  const adapter={async createPayment(p){sent.push(structuredClone(p));return {providerReference:'test-'+p.id};},
    async verifyPayment(p){return {status:'pending',providerReference:p.providerReference,transactionReference:p.id,amount:p.amount,currency:p.currency};}};
  const server=createServer({store,payments:{mesomb:adapter},env:{NODE_ENV:'test',PAYMENT_MODE:'mesomb',EMAIL_MODE:'mock',MIKROTIK_MODE:'mock',OMADA_MODE:'mock',BILLING_WORKER_ENABLED:'false',SESSION_COOKIE_SECURE:'false',CUSTOMER_SESSION_SECRET:secret,SECRET_PEPPER:secret}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const call=async(path,input,{session=false}={})=>{const response=await fetch(`http://127.0.0.1:${server.address().port}`+path,{method:'POST',headers:{'content-type':'application/json',...(session?{cookie:'customer_session=owner','x-csrf-token':'csrf'}:{})},body:JSON.stringify(input)});return {status:response.status,body:await response.json()};};
  const owner=async()=>store.transaction(s=>{s.customers.push({id:'c1',name:'Owner',phone:'670123456',createdAt:new Date().toISOString()});s.dashboardSessions.push({id:'owner',customerId:'c1',tokenHash:hashSecret('owner',secret),csrfToken:'csrf',expiresAt:new Date(Date.now()+3600000).toISOString()});});
  return {store,sent,call,owner};
}
const input=(extra={})=>({phone:'690123456',name:'Network Guest',planId:'weekly',network:'orange',requestKey:'network-selection-test',...extra});
test('invalid or malicious provider inputs are rejected before reservation or a charge',async t=>{
  const f=await fixture(t);
  for(const network of [undefined,null,'MTN','nexttel','<script>',{service:'MTN'}]){const r=await f.call('/api/purchase',input({network}));assert.equal(r.status,400);}
  assert.equal(f.sent.length,0);assert.equal((await f.store.snapshot()).payments.length,0);
  assert.equal((await f.call('/api/purchase',input({phone:'690abc123456'}))).status,400);
});
test('normalized guest payer and manually corrected provider reach the gateway unchanged on replay',async t=>{
  const f=await fixture(t),r=await f.call('/api/purchase',input({phone:'00237 (690) 123-456',network:'mtn'}));
  assert.equal(r.status,201);assert.equal(f.sent[0].payerPhone,'690123456');assert.equal(f.sent[0].network,'mtn');
  const replay=await f.call('/api/purchase',input({phone:'+237690123456',network:'orange'}));
  assert.equal(replay.status,200);assert.equal(replay.body.payment.id,r.body.payment.id);assert.equal(replay.body.payment.network,'mtn');assert.equal(f.sent.length,1);
});
test('account alternate payer is transaction-only and retries cannot change payer/provider',async t=>{
  const f=await fixture(t);await f.owner();
  const value={action:'switch',planId:'weekly',payerPhone:'+237 655 123 456',network:'mtn',requestKey:'account-network-test'};
  const r=await f.call('/api/account/plan/purchase',value,{session:true});assert.equal(r.status,201);
  assert.equal(f.sent[0].payerPhone,'655123456');assert.equal(f.sent[0].network,'mtn');
  assert.equal((await f.store.snapshot()).customers[0].phone,'670123456');
  assert.equal((await f.call('/api/account/plan/purchase',{...value,payerPhone:'690123456'},{session:true})).status,409);
  assert.equal((await f.call('/api/account/plan/purchase',{...value,network:'orange'},{session:true})).status,409);
  assert.equal((await f.call('/api/account/plan/purchase',{...value,payerPhone:'655123456'},{session:true})).status,200);assert.equal(f.sent.length,1);
});
