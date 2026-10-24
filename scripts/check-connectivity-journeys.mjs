import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir} from 'node:fs/promises';
import {createStaticServer} from '../static-server.mjs';
import {pairingFixture,mainMac} from '../test/helpers/wifi-pairing-fixture.mjs';
const web=http.createServer();await new Promise(r=>web.listen(0,'127.0.0.1',r));const portal=`http://127.0.0.1:${web.address().port}`;
const f=await pairingFixture({origin:portal,now:new Date(),liveClock:true}),api=f.api,assets=createStaticServer('customer',{apiUrl:api,hotspotLoginUrl:'https://connect.example.test/login'});web.on('request',(req,res)=>assets.emit('request',req,res));
const baseline=await f.store.snapshot(),screenshots='/tmp/ndahi-connectivity-checks';let browser,checks=0;
try{
 const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,...(process.env.PLAN_CHROME_PATH?{executablePath:process.env.PLAN_CHROME_PATH}:{})});await mkdir(screenshots,{recursive:true});
 async function scenario(name,work,{signedIn=true,inside=true,internet=true,width=390}={}){
  await f.store.transaction(s=>Object.assign(s,structuredClone(baseline)));const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(15000);
  let probes=0;
  await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin==='https://www.cloudflare.com'){probes++;return internet?route.fulfill({status:200,headers:{'access-control-allow-origin':'*','content-type':'text/plain'},body:'h=www.cloudflare.com\ncolo=CDG\n'}):route.abort();}return [portal,api].includes(url.origin)?route.continue({headers:{...route.request().headers(),'cf-connecting-ip':inside?'203.0.113.10':'198.51.100.7'}}):route.abort();});
  if(signedIn)await context.addCookies([{name:'customer_session',value:'main',domain:'127.0.0.1',path:'/api/account',httpOnly:true,sameSite:'Lax'}]);
  try{await work(page,()=>probes);assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);console.log('PASS '+name);checks++;}catch(e){await page.screenshot({path:screenshots+'/failure-'+checks+'.png',fullPage:true}).catch(()=>{});throw e;}finally{await context.close();}
 }
 for(const width of [320,1280])await scenario('unpaid captive presence offers sign-in without a join-Wi-Fi instruction at '+width+'px',async(page,probes)=>{
  await page.goto(portal+'/login');const banner=page.locator('#entryConnectivity');await banner.getByText('NDAHI network detected',{exact:true}).waitFor();assert.equal(await banner.getByRole('link',{name:'Sign in',exact:true}).getAttribute('href'),'/login');assert.doesNotMatch(await banner.textContent(),/Join Wi-Fi|Starlink Active|Connected & Active/);assert.equal(probes(),0);
 },{signedIn:false,width});
 await scenario('an active bundle alone cannot invent Connected or working internet',async(page,probes)=>{await page.goto(portal+'/dashboard');const banner=page.locator('.network-state-banner');await banner.getByText('NDAHI network detected',{exact:true}).waitFor();assert.match(await banner.textContent(),/authorization is still being checked/);assert.equal(probes(),0);});
 for(const internet of [true,false])await scenario('exact HotSpot authorization with browser internet '+(internet?'available':'unavailable')+' stays distinct',async(page,probes)=>{
  await f.call('/api/account/device-management/current/identify',{mac:mainMac,address:'10.20.0.1'});await page.goto(portal+'/dashboard');const banner=page.locator('.network-state-banner');await banner.getByText('Router connection confirmed',{exact:true}).waitFor();await banner.getByText(internet?/internet check passed/:/Internet availability is not confirmed/).waitFor();assert.equal(probes(),1);assert.equal(await banner.getByText('Join Wi-Fi',{exact:true}).count(),0);await page.screenshot({path:screenshots+'/router-internet-'+internet+'.png',fullPage:true});
 },{internet});
 await scenario('mobile-data or VPN ingress stays unconfirmed while account access remains usable',async(page,probes)=>{await page.goto(portal+'/dashboard#account');await page.getByRole('heading',{name:'PIN & passkeys',exact:true}).waitFor();await page.locator('.network-state-banner').getByText('NDAHI Wi-Fi not confirmed',{exact:true}).waitFor();assert.equal(probes(),0);},{inside:false});
 await scenario('expired subscription leads to eligible plans without asserting off-network',async page=>{await f.store.transaction(s=>{s.vouchers[0].status='expired';});await page.goto(portal+'/dashboard');await page.locator('.network-state-banner').getByRole('link',{name:'View bundles',exact:true}).waitFor();});
 await scenario('failed evidence read cannot use zone/account success to show Connected',async page=>{await page.route('**/api/account/connectivity',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));await page.goto(portal+'/dashboard');await page.locator('.network-state-banner').getByText('Connection not verified',{exact:true}).waitFor();assert.doesNotMatch(await page.locator('.network-state-banner').textContent(),/Connected & Active|Starlink Active/);});
 await scenario('onboarding network evidence does not redirect or discard a checkout',async page=>{await page.goto(portal+'/onboarding.html');assert.equal(await page.locator('#entryConnectivity').count(),1,'one connection banner per page');await page.locator('#entryConnectivity').getByText('NDAHI network detected',{exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/onboarding.html');});
 console.log(`PASS ${checks} connectivity browser journeys`);
}finally{await browser?.close();await f.close();await new Promise(r=>{web.close(r);web.closeAllConnections();});}
