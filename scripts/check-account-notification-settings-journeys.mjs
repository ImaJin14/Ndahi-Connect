import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdir} from 'node:fs/promises';
import {createStaticServer} from '../static-server.mjs';
import {pairingFixture} from '../test/helpers/wifi-pairing-fixture.mjs';
const server=http.createServer();await new Promise(r=>server.listen(0,'127.0.0.1',r));const portal=`http://127.0.0.1:${server.address().port}`;
const f=await pairingFixture({origin:portal,now:new Date(),liveClock:true,env:{WEB_PUSH_PUBLIC_KEY:'B'.repeat(87),WEB_PUSH_PRIVATE_KEY:'fixture',WEB_PUSH_SUBJECT:'mailto:fixture@example.test'}});
const assets=createStaticServer('customer',{apiUrl:f.api});server.on('request',(req,res)=>assets.emit('request',req,res));let browser;
try{
 const{chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');browser=await chromium.launch({headless:true,...(process.env.PLAN_CHROME_PATH?{executablePath:process.env.PLAN_CHROME_PATH}:{})});await mkdir('/tmp/ndahi-notification-settings-checks',{recursive:true});
 for(const width of[320,1280]){
  await f.call('/api/account/notifications',{action:'preferences',usageThresholds:['90','low','100'],expiryWarnings:false,subscriptionUpdates:true});
  const context=await browser.newContext({viewport:{width,height:900}});await context.addCookies([{name:'customer_session',value:'main',domain:'127.0.0.1',path:'/api/account',httpOnly:true,sameSite:'Lax'}]);
  await context.route('**/*',route=>[portal,f.api].includes(new URL(route.request().url()).origin)?route.continue({headers:{...route.request().headers(),'cf-connecting-ip':'203.0.113.10'}}):route.abort('blockedbyclient'));
  await context.addInitScript(()=>{window.permissionCalls=0;Object.defineProperty(Notification,'permission',{get:()=> 'denied'});Notification.requestPermission=async()=>{window.permissionCalls++;return'denied';};});
  const page=await context.newPage();page.setDefaultTimeout(15000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(portal+'/dashboard');
  await page.locator('#dataBalance').waitFor();assert.equal(await page.locator('#usageAlerts,#manageUsageAlerts').count(),0);
  await page.goto(portal+'/dashboard#notificationSettings');await page.getByRole('button',{name:'Manage notification settings',exact:true}).waitFor();
  await page.getByRole('button',{name:'Manage notification settings',exact:true}).focus();await page.keyboard.press('Enter');
  const panel=page.getByRole('dialog',{name:'Notifications',exact:true});await panel.getByRole('heading',{name:'Notification settings',exact:true}).waitFor();
  await panel.getByLabel('90% of data used',{exact:true}).uncheck();await panel.getByLabel('Data exhausted',{exact:true}).uncheck();await panel.getByLabel('Warn within one hour of bundle expiry',{exact:true}).check();
  await page.route('**/api/account/notifications?**',route=>route.request().method()==='POST'?route.fulfill({status:503,json:{error:'Settings could not be saved. Try again.'}}):route.continue(),{times:1});
  await panel.getByRole('button',{name:'Save notification settings',exact:true}).click();await panel.getByText('Settings could not be saved. Try again.',{exact:true}).waitFor();assert.equal(await panel.getByRole('button',{name:'Save notification settings',exact:true}).isEnabled(),true);assert.equal(await panel.getByLabel('90% of data used',{exact:true}).isChecked(),false);
  let release;const held=new Promise(r=>{release=r;});await page.route('**/api/account/notifications?**',async route=>{if(route.request().method()==='POST')await held;await route.continue();},{times:1});
  await panel.getByRole('button',{name:'Save notification settings',exact:true}).click();await panel.getByRole('button',{name:'Saving…',exact:true}).waitFor();assert.equal(await panel.getByLabel('Low data (about 2 MB remaining)',{exact:true}).isDisabled(),true);release();await panel.getByText('Notification settings saved.',{exact:true}).waitFor();
  const prefs=(await f.call('/api/account/notifications',undefined,{session:'secondary'})).body.preferences;assert.deepEqual(prefs.usageThresholds,['low']);assert.equal(prefs.expiryWarnings,true);
  await panel.getByRole('button',{name:'Enable on this device',exact:true}).click();await panel.getByText('Allow notifications in your browser settings, or keep using the in-app inbox.',{exact:true}).waitFor();await panel.getByRole('button',{name:'Enable on this device',exact:true}).click();assert.equal(await page.evaluate(()=>permissionCalls),0);
  await page.evaluate(()=>Object.defineProperty(window,'PushManager',{configurable:true,value:undefined}));await panel.getByRole('button',{name:'Enable on this device',exact:true}).click();await panel.getByText('Browser notifications are not supported here. Use the in-app inbox.',{exact:true}).waitFor();
  await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Manage notification settings',exact:true}).evaluate(el=>el===document.activeElement),true);
  await page.reload();assert.equal(await page.locator('#usageAlerts,#manageUsageAlerts').count(),0);await page.getByRole('button',{name:'Manage notification settings',exact:true}).click();await panel.getByRole('heading',{name:'Notification settings',exact:true}).waitFor();assert.equal(await panel.getByLabel('90% of data used',{exact:true}).isChecked(),false);assert.equal(await panel.getByLabel('Warn within one hour of bundle expiry',{exact:true}).isChecked(),true);
  const second=await browser.newContext({viewport:{width,height:900}});await second.addCookies([{name:'customer_session',value:'secondary',domain:'127.0.0.1',path:'/api/account',httpOnly:true,sameSite:'Lax'}]);await second.route('**/*',route=>[portal,f.api].includes(new URL(route.request().url()).origin)?route.continue():route.abort());const other=await second.newPage();await other.goto(portal+'/dashboard#account');await other.getByRole('button',{name:'Manage notification settings',exact:true}).click();assert.equal(await other.getByLabel('90% of data used',{exact:true}).isChecked(),false);assert.equal(await other.getByLabel('Warn within one hour of bundle expiry',{exact:true}).isChecked(),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);assert.deepEqual(errors,[]);await page.screenshot({path:`/tmp/ndahi-notification-settings-checks/settings-${width}.png`,fullPage:true});await second.close();await context.close();console.log(`PASS Account settings, reload/cross-device persistence, pending/error recovery, denied/unsupported push and keyboard return at ${width}px`);
 }
}finally{await browser?.close();await f.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});}
