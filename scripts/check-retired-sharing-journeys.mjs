import assert from 'node:assert/strict';
import http from 'node:http';
import {createStaticServer} from '../static-server.mjs';
import {pairingFixture} from '../test/helpers/wifi-pairing-fixture.mjs';
const site=http.createServer();await new Promise(r=>site.listen(0,'127.0.0.1',r));const portal=`http://127.0.0.1:${site.address().port}`;
const f=await pairingFixture({origin:portal,now:new Date(),liveClock:true,env:{NODE_ENV:'test',EMAIL_MODE:'mock',PAYMENT_MODE:'mock'}});
const assets=createStaticServer('customer',{apiUrl:f.api,supportPhone:'+237 670 123 456'});site.on('request',(req,res)=>assets.emit('request',req,res));let browser;
try{
 const{chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true});
 for(const width of [320,1280]){
  await f.store.transaction(s=>{s.customers[0].email='verified@example.test';s.customers[0].emailVerifiedAt=f.now().toISOString();s.payments=[{id:'p1',customerId:'c1',planId:'family',status:'paid',amount:500,currency:'XAF',confirmedAt:f.now().toISOString(),createdAt:f.now().toISOString()}];s.vouchers[0].paymentId='p1';s.vouchers=s.vouchers.slice(0,1);s.vouchers.push({...s.vouchers[0],id:'past',code:'NC-BBBB-2222',status:'expired',expiresAt:new Date(+f.now()-1000).toISOString()},{...s.vouchers[0],id:'used',code:'NC-CCCC-3333',status:'exhausted',usedBytes:1e9});});
  const context=await browser.newContext({viewport:{width,height:900},acceptDownloads:true});await context.addCookies([{name:'customer_session',value:'main',domain:'127.0.0.1',path:'/api/account',httpOnly:true,sameSite:'Lax'}]);await context.grantPermissions(['clipboard-read','clipboard-write']);await context.route('**/*',route=>[portal,f.api].includes(new URL(route.request().url()).origin)?route.continue():route.abort());
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(portal+'/dashboard#vouchers');
  const root=page.locator('#voucherHistory');
  for(const status of ['active','expired','exhausted','all']){
   await root.getByLabel('Voucher status',{exact:true}).selectOption(status);await root.locator('.voucher-card').first().waitFor();assert.equal(await root.locator('[data-share-whatsapp],.whatsapp-share-btn,a[href*="wa.me"],a[href*="whatsapp"]').count(),0);
   const card=root.locator('.voucher-card').first(),code=await card.locator('[data-voucher-code]').inputValue();await card.getByRole('button',{name:'Copy code',exact:true}).click();assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),code);
   const download=page.waitForEvent('download');await card.getByRole('button',{name:'Download PDF',exact:true}).click();assert.match((await download).suggestedFilename(),/^ndahi-voucher-.+\.pdf$/);
   await card.getByRole('button',{name:'Show QR',exact:true}).click();const dialog=page.getByRole('dialog',{name:'Voucher QR Code',exact:true});await dialog.waitFor();assert.equal(await dialog.locator('img').getAttribute('src').then(s=>s.startsWith('data:image/png;base64,')),true);assert.match(await dialog.textContent(),new RegExp(code));await dialog.getByRole('button',{name:'Close',exact:true}).click();
  }
  await page.reload();await root.locator('.voucher-card').first().waitFor();assert.equal(await root.locator('a[href*="wa.me"]').count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  const support=await page.evaluate(async()=>{const{whatsappSupportUrl}=await import('/errors.js');return whatsappSupportUrl({phone:'670050001',voucher:'NC-SECRET-1234',mac:'AA:BB:CC:DD:EE:FF',error:'private-key'});});assert.match(support,/^https:\/\/wa\.me\/237670123456\?text=/);assert.doesNotMatch(decodeURIComponent(support),/670050001|NC-SECRET|AA:BB|private-key/);
  await page.goto(portal+'/dashboard#payments');await page.getByRole('button',{name:'Email receipt',exact:true}).click();await page.getByText('Receipt sent to your account email.',{exact:true}).waitFor();
  await page.goto(portal+'/help');await page.getByRole('link',{name:/Chat with Support on WhatsApp/}).waitFor();assert.deepEqual(errors,[]);await context.close();console.log(`PASS no WhatsApp voucher sharing after status/reload; copy, PDF, QR, verified receipt email and generic support remain at ${width}px`);
 }
}finally{await browser?.close();await f.close();await new Promise(r=>{site.close(r);site.closeAllConnections();});}
