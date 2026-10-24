import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {readFile,readdir} from 'node:fs/promises';
import pg from 'pg';
import {createHandler,blank} from '../server.mjs';
import {createPostgresStore} from '../lib/postgres-store.mjs';
import {pairingFixture} from './helpers/wifi-pairing-fixture.mjs';
const url=process.env.TEST_DATABASE_URL;
test('PostgreSQL preferences survive independent sessions and store reopen; concurrent partial updates and rollback remain atomic',{skip:url?false:'TEST_DATABASE_URL is not set'},async()=>{
 const schema=`ndahi_notifications137_${process.pid}`,admin=new pg.Client({connectionString:url});await admin.connect();let pool,server;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const dir=new URL('../migrations/',import.meta.url);for(const file of(await readdir(dir)).filter(x=>/^\d+_.+\.sql$/.test(x)).sort())await pool.query(await readFile(new URL(file,dir),'utf8'));
  const store=createPostgresStore({pool,initialState:blank}),f=await pairingFixture();try{await store.transaction(async s=>Object.assign(s,await f.store.snapshot()));}finally{await f.close();}
  const handler=createHandler({store,now:()=>new Date('2030-01-01T12:00:00Z'),validateConfig:false,env:{NODE_ENV:'production',CUSTOMER_SESSION_SECRET:'pairing-tests',SECRET_PEPPER:'pairing-tests',SESSION_COOKIE_SECURE:'false',CUSTOMER_APP_URL:'http://customer.test',LOG_LEVEL:'warn',BILLING_WORKER_ENABLED:'false',SECURITY_ALERTS_ENABLED:'false'}});
  server=http.createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));
  async function call(body,session='main'){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/account/notifications`,{method:body?'POST':'GET',headers:{origin:'http://customer.test','content-type':'application/json','x-csrf-token':'csrf',cookie:`customer_session=${session}`},...(body?{body:JSON.stringify({action:'preferences',...body})}:{})});return{status:r.status,body:await r.json()};}
  const results=await Promise.all([call({usageThresholds:['low'],expiryWarnings:true}),call({categories:{service:false},subscriptionUpdates:false},'secondary')]);assert.deepEqual(results.map(r=>r.status),[200,200]);
  const prefs=(await call(undefined,'secondary')).body.preferences;assert.deepEqual(prefs.usageThresholds,['low']);assert.equal(prefs.expiryWarnings,true);assert.equal(prefs.subscriptionUpdates,false);assert.equal(prefs.categories.service,false);
  assert.equal((await call(undefined,'other')).body.preferences.expiryWarnings,false);
  const original=store.transaction.bind(store);store.transaction=(fn,options)=>original(async s=>{const value=await fn(s);throw Error('Synthetic preference rollback');},options);
  assert.notEqual((await call({usageThresholds:[]})).status,200);store.transaction=original;
  const reopened=createPostgresStore({pool,initialState:blank});assert.deepEqual((await reopened.snapshot()).notificationStates.find(n=>n.id==='preferences:customer:c1').usageThresholds,['low']);
  assert.deepEqual((await call()).body.preferences,prefs);
 }finally{if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
