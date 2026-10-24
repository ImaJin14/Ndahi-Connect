import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, createStore } from '../server.mjs';
import { createStaticServer } from '../static-server.mjs';
const store=createStore({persistent:false});let now=new Date();
const website=http.createServer();await new Promise(r=>website.listen(0,'127.0.0.1',r));const portal=`http://127.0.0.1:${website.address().port}`;
const server=createServer({store,now:()=>now,env:{NODE_ENV:'test',PAYMENT_MODE:'mock',EMAIL_MODE:'mock',MIKROTIK_MODE:'mock',OMADA_MODE:'mock',BILLING_WORKER_ENABLED:'false',SESSION_COOKIE_SECURE:'false',CUSTOMER_APP_URL:portal}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const api=`http://127.0.0.1:${server.address().port}`;
const assets=createStaticServer('customer',{apiUrl:api});website.on('request',(req,res)=>assets.emit('request',req,res));
const post=async(path,input={})=>{const response=await fetch(api+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)});const json=await response.json();assert.ok(response.ok,JSON.stringify(json));return {response,json};};
const key=()=>crypto.randomUUID().replaceAll('-','');
const seedSaved=(context,saved)=>context.addCookies([{name:'ndahi-checkout',value:encodeURIComponent(JSON.stringify(saved)),url:portal,sameSite:'Strict',expires:Math.floor(Date.now()/1000)+3600}]);
let browser;
try{
 const original=await post('/api/purchase',{phone:'670123456',name:'Account Owner',planId:'weekly',network:'mtn',requestKey:key()});
 const confirmed=await post(`/api/payments/${original.json.payment.id}/confirm`);
 const signed=await post('/api/account/setup/pin',{phone:'670123456',code:confirmed.json.access.code,pin:'2468',confirmPin:'2468'});
 const token=signed.response.headers.get('set-cookie').split(';')[0].split('=')[1];
 await store.transaction(s=>{s.vouchers[0].status='expired';s.vouchers[0].expiresAt=new Date(+now-1000).toISOString();});const baseline=await store.snapshot();
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,...(process.env.PLAN_CHROME_PATH?{executablePath:process.env.PLAN_CHROME_PATH}:{})});
 for(const width of [320,1280]){
  async function scenario(name,work,{account=false}={}){
   now=new Date();await store.transaction(s=>Object.assign(s,structuredClone(baseline)));
   const context=await browser.newContext({viewport:{width,height:950}});
   if(account)await context.addCookies([{name:'customer_session',value:token,domain:'127.0.0.1',path:'/api/account',httpOnly:true,sameSite:'Lax'}]);
   await context.route('**/*',route=>[portal,api].includes(new URL(route.request().url()).origin)?route.continue():route.abort('blockedbyclient'));
   const page=await context.newPage(),errors=[];page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));
   try{await work(page,context);assert.deepEqual(errors,[]);console.log('PASS '+name+' at '+width+'px');}finally{await context.close();}
  }
  const open=async(page,url='/onboarding.html')=>{await page.goto(portal+url);if(!new URL(url,portal).searchParams.has('plan'))await page.locator('[data-plan="weekly"]').click();await page.locator('#checkout').waitFor();await page.waitForFunction(()=>document.querySelector('#purchase').dataset.paymentNetworkReady==='true');};
  const details=async(page,phone)=>{await page.getByLabel('Your name',{exact:true}).fill('Network Guest');await page.getByLabel('Payment phone number',{exact:true}).fill(phone);};
  await scenario('MTN/Orange suggestions, formatting-safe manual choice and unknown prefixes never submit a charge',async page=>{
   await open(page);const phone=page.getByLabel('Payment phone number',{exact:true}),network=page.getByLabel('Mobile Money network',{exact:true});
   assert.equal(await network.inputValue(),'');await phone.fill('+237 (670) 123-459');await page.waitForFunction(()=>document.querySelector('[name=network]').value==='mtn');
   await network.selectOption('orange');await phone.fill('670 123 459');assert.equal(await network.inputValue(),'orange');await page.locator('#paymentNetworkHint').getByText(/selected by you/).waitFor();
   await page.locator('#closeCheckout').click();await page.locator('[data-plan="weekly"]').click();assert.equal(await network.inputValue(),'orange');
   await phone.fill('655123459');await page.waitForFunction(()=>document.querySelector('[name=network]').value==='orange');
   await phone.fill('680123459');await page.waitForFunction(()=>document.querySelector('[name=network]').value==='');await page.locator('#paymentNetworkHint').getByText(/could not be identified/).waitFor();
   await network.selectOption('mtn');await phone.fill('00237 680 123 459');assert.equal(await network.inputValue(),'mtn');
   assert.equal((await store.snapshot()).payments.length,baseline.payments.length);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  });
  await scenario('explicit guest confirmation and duplicate settlement keep one normalized payment and one voucher',async page=>{
   await open(page);await details(page,'+237 690 123 459');await page.waitForFunction(()=>document.querySelector('[name=network]').value==='orange');
   await page.locator('#requestPayment').dblclick();await page.locator('#confirm').waitFor();
   let s=await store.snapshot();const payment=s.payments.find(p=>p.payerPhone==='690123459');assert.equal(payment.network,'orange');assert.equal(s.payments.length,baseline.payments.length+1);
   await post(`/api/payments/${payment.id}/confirm`);await post(`/api/payments/${payment.id}/confirm`);
   await page.locator('#confirm').click();await page.waitForURL('**/verify.html?setup=checkout');s=await store.snapshot();assert.equal(s.vouchers.filter(v=>v.customerId===payment.customerId).length,1);
  });
  await scenario('lost creation response recovers the original manually corrected payer/provider without another charge',async page=>{
   await open(page);await details(page,'670123458');await page.getByLabel('Mobile Money network',{exact:true}).selectOption('orange');
   let submissions=0;await page.route('**/api/purchase',async route=>{submissions++;await route.fetch();await route.abort('failed');},{times:1});
   await page.locator('#requestPayment').click();await page.locator('#message .error-card').waitFor();
   await page.reload();await page.getByRole('button',{name:'Resume saved payment',exact:true}).click();await page.locator('#resumeRecheck').waitFor();
   const s=await store.snapshot(),p=s.payments.find(p=>p.payerPhone==='670123458');assert.equal(p.network,'orange');assert.equal(submissions,1);assert.equal(s.payments.length,baseline.payments.length+1);assert.equal(await page.locator('[name=network]').inputValue(),'orange');
  });
  await scenario('resumed pending payment freezes its original network through failure and permits a fresh checkout',async(page,context)=>{
   const requestKey=key(),created=await post('/api/purchase',{phone:'670123457',name:'Saved Guest',planId:'weekly',network:'orange',requestKey});
   await seedSaved(context,{requestKey,planId:'weekly',paymentId:created.json.payment.id});await page.goto(portal+'/onboarding.html');await page.getByRole('button',{name:'Resume saved payment',exact:true}).click();await page.locator('#resumeRecheck').waitFor();
   assert.equal(await page.locator('[name=network]').inputValue(),'orange');assert.equal(await page.locator('[name=network]').isDisabled(),true);await page.locator('#paymentNetworkHint').getByText(/original number and network/).waitFor();
   await store.transaction(s=>{const p=s.payments.find(p=>p.id===created.json.payment.id);p.status='failed';p.providerFailedAt=now.toISOString();p.failureReason='Synthetic decline';});
   await page.locator('#resumeRecheck').click();await page.locator('#message .error-card').waitFor();await page.locator('#closeCheckout').click();await page.locator('[data-plan="weekly"]').click();
   await page.getByLabel('Payment phone number',{exact:true}).fill('690123457');await page.waitForFunction(()=>document.querySelector('[name=network]').value==='orange');assert.equal(await page.locator('[name=network]').isDisabled(),false);
   assert.equal((await store.snapshot()).payments.length,baseline.payments.length+1);
  });
  await scenario('account suggestions use the alternate transaction payer and preserve the profile default',async page=>{
   await open(page,'/onboarding.html?action=renew&plan=weekly');const payer=page.locator('[name=payerPhone]'),network=page.getByLabel('Mobile Money network',{exact:true});
   assert.equal(await payer.inputValue(),'670123456');assert.equal(await network.inputValue(),'mtn');
   await payer.fill('+237 655 123 455');await page.waitForFunction(()=>document.querySelector('[name=network]').value==='orange');await network.selectOption('mtn');await payer.fill('655123455');assert.equal(await network.inputValue(),'mtn');
   const acknowledgement=page.locator('[name=acknowledge]');if(await acknowledgement.isVisible())await acknowledgement.check();
   await page.locator('#requestPayment').click();await page.locator('#confirm').waitFor();
   const s=await store.snapshot(),p=s.payments.find(p=>p.payerPhone==='655123455');assert.equal(p.network,'mtn');assert.equal(s.customers.find(c=>c.id===p.customerId).phone,'670123456');assert.equal(s.payments.length,baseline.payments.length+1);
  },{account:true});
 }
}finally{if(browser)await browser.close();for(const app of [server,website])await new Promise(r=>{app.close(r);app.closeAllConnections();});}
