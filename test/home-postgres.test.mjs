import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { blank } from "../lib/api/state.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { applySchemaMigrations } from "../scripts/migrate-postgres.mjs";
import { reserveHomeLink, applyHomeUsage, queueHome } from "../lib/home.mjs";

const url=process.env.TEST_DATABASE_URL, skip=url?false:"TEST_DATABASE_URL is not set";
const schema=`ndahi_home_test_${process.pid}`, now=new Date("2030-01-01T12:00:00Z");
let admin,pool,store;
test.before(async()=>{
 if(skip)return;
 admin=new pg.Client({connectionString:url});await admin.connect();
 await admin.query(`CREATE SCHEMA ${schema}`);
 pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`,max:6});
 const client=await pool.connect();try{await applySchemaMigrations(client);}finally{client.release();}
 store=createPostgresStore({pool,initialState:blank});
});
test.after(async()=>{if(skip)return;await pool?.end();await admin?.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin?.end();});
test("PostgreSQL serializes competing Home claims and retains all four collections on reload",{skip},async()=>{
 await store.transaction(s=>{
  for(const id of ["c1","c2"]){
   s.customers.push({id,phone:id==="c1"?"670050001":"670050002"});
   s.homeChallenges.push({id,customerId:id,status:"ready",routerRevision:"r1",expiresAt:new Date(+now+120000).toISOString()});
  }
 });
 const results=await Promise.allSettled(["c1","c2"].map(customerId=>store.transaction(s=>reserveHomeLink(s,customerId,
  {challengeId:customerId,mac:"AA:BB:CC:DD:EE:90",address:"10.20.0.90",hostId:"*h",sessionId:"*s"},customerId,"Family router",now))));
 assert.equal(results.filter(r=>r.status==="fulfilled").length,1);
 const link=(await store.snapshot()).homeConnections[0];
 await store.transaction(s=>{
  const v={id:"hv1",customerId:link.customerId,homeGeneration:link.generation,status:"active",usedBytes:20,quotaBytes:1000,homeAccounting:{base:20,raw:0,epoch:"boot1"}};
  s.vouchers.push(v);applyHomeUsage(s,v,{bytes:80,epoch:"boot1",generation:link.generation},now);
  queueHome(s,"refresh",link.customerId,now,{voucherId:v.id});
 });
 const reloaded=await createPostgresStore({pool,initialState:blank}).snapshot();
 assert.equal(reloaded.homeConnections.length,1);assert.equal(reloaded.homeChallenges.length,2);
 assert.equal(reloaded.homeOperations.length,1);assert.equal(reloaded.homeUsageObservations.some(o=>o.type==="usage.high_water"&&o.usedBytes===100),true);
 assert.equal(reloaded.vouchers[0].usedBytes,100);
});
test("database Home uniqueness constraints reject bypassed claims without losing prior state",{skip},async()=>{
 const original=(await store.snapshot()).homeConnections[0];
 const other=original.customerId==="c1"?"c2":"c1";
 await assert.rejects(pool.query("INSERT INTO events (kind,id,ordinal,payload) VALUES ('home_connection','duplicate-mac',900,$1)",
  [JSON.stringify({...original,id:"duplicate-mac",customerId:other})]),{code:"23505"});
 await assert.rejects(pool.query("INSERT INTO events (kind,id,ordinal,payload) VALUES ('home_connection','duplicate-owner',901,$1)",
  [JSON.stringify({...original,id:"duplicate-owner",mac:"AA:BB:CC:DD:EE:91"})]),{code:"23505"});
 assert.equal((await store.snapshot()).homeConnections.length,1);
});
