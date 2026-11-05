import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { blank } from "../lib/api/state.mjs";
import { createPostgresStore } from "../lib/postgres-store.mjs";
import { applySchemaMigrations } from "../scripts/migrate-postgres.mjs";
import { reserveHomeLink, applyHomeUsage, queueHome } from "../lib/home.mjs";
import { inspectHomeDatabase } from "../lib/home-database-readiness.mjs";
import { applyHomeMigration } from "../scripts/apply-home-migration.mjs";

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

test("Home migration is repeatable and rollback preserves paid history and every Home collection", {skip}, async () => {
  await store.transaction(s => {
    const customer = s.customers[0];
    s.payments.push({ id: "home-paid-history", customerId: customer.id, status: "paid", amount: 1000,
      paidAt: now.toISOString(), providerReference: "synthetic-home-settlement" });
    Object.assign(s.vouchers[0], { paymentId: "home-paid-history", accessMode: "home",
      expiresAt: new Date(+now + 86400000).toISOString() });
    s.vouchers.push({ id: "existing-direct", code: "NC-OLD1-0001", customerId: customer.id,
      status: "active", usedBytes: 57, quotaBytes: 1000, expiresAt: new Date(+now + 86400000).toISOString() });
  });
  const before = await store.snapshot();
  const client = await pool.connect();
  try {
    await applySchemaMigrations(client);
    await applySchemaMigrations(client);
    assert.equal((await inspectHomeDatabase(client)).status, "ready");
  } finally { client.release(); }
  assert.deepEqual(await store.snapshot(), before, "DDL replay must not rewrite paid state");
  await assert.rejects(store.transaction(s => {
    s.payments.length = 0;
    s.vouchers[0].usedBytes = 0;
    s.homeConnections.length = 0;
    s.homeChallenges.length = 0;
    s.homeOperations.length = 0;
    s.homeUsageObservations.length = 0;
    throw Error("simulate failed migration/cutover");
  }), /simulate failed migration/);
  assert.deepEqual(await store.snapshot(), before);
  const direct = before.vouchers.find(v => v.id === "existing-direct");
  assert.equal(direct.accessMode || "direct", "direct");
  assert.equal(direct.usedBytes, 57);
});

test("Home readiness rejects a same-named index with a weakened predicate", {skip}, async () => {
  const client = await pool.connect();
  try {
    await client.query("DROP INDEX home_active_mac_unique");
    await client.query("CREATE UNIQUE INDEX home_active_mac_unique ON events ((payload->>'mac')) WHERE kind = 'home_connection' AND payload->>'status' = 'linked'");
    const report = await inspectHomeDatabase(client);
    assert.equal(report.status, "migration_required");
    assert.ok(report.checks.find(check => check.id === "home_active_mac_unique").reasons.includes("wrong_predicate"));
  } finally {
    await client.query("DROP INDEX home_active_mac_unique");
    await applySchemaMigrations(client);
    client.release();
  }
});

test("an isolated normalized-state restore retains paid Home history, direct balances and all Home records", {skip}, async () => {
  const before = await store.snapshot();
  const backup = JSON.parse(JSON.stringify(before));
  const target = `${schema}_restore`;
  await admin.query(`CREATE SCHEMA ${target}`);
  const restoredPool = new pg.Pool({ connectionString: url, options: `-c search_path=${target}`, max: 2 });
  try {
    const client = await restoredPool.connect();
    try { await applySchemaMigrations(client); } finally { client.release(); }
    const restoredStore = createPostgresStore({ pool: restoredPool, initialState: blank });
    await restoredStore.transaction(s => Object.assign(s, backup));
    const restored = await createPostgresStore({ pool: restoredPool, initialState: blank }).snapshot();
    assert.deepEqual(restored, before);
    assert.equal(restored.payments.find(p => p.id === "home-paid-history").status, "paid");
    assert.equal(restored.vouchers.find(v => v.id === "existing-direct").usedBytes, 57);
    assert.equal((await restoredStore.homeSchemaReadiness()).status, "ready");
    // A rollback of the additive indexes changes no entitlement or observation.
    await restoredPool.query("DROP INDEX home_active_mac_unique, home_linked_customer_unique, home_operations_due");
    assert.equal((await restoredStore.homeSchemaReadiness()).status, "migration_required");
    assert.deepEqual(await restoredStore.snapshot(), before);
    const replay = await restoredPool.connect();
    try { await applySchemaMigrations(replay); } finally { replay.release(); }
    assert.equal((await restoredStore.homeSchemaReadiness()).status, "ready");
    assert.deepEqual(await restoredStore.snapshot(), before);
  } finally {
    await restoredPool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${target} CASCADE`);
  }
});

test("the reviewed Home-only migration repairs missing indexes without importing state or replacing bad definitions", {skip}, async () => {
  const client = await pool.connect(), before = await store.snapshot();
  const authorization = { HOME_MIGRATION_CONFIRM: "apply-reviewed-additive-home-indexes", HOME_BACKUP_REFERENCE: "synthetic-isolated-backup" };
  try {
    await client.query("DROP INDEX home_operations_due");
    const applied = await applyHomeMigration(client, authorization);
    assert.equal(applied.status, "ready"); assert.equal(applied.applied, true);
    assert.equal((await applyHomeMigration(client, authorization)).applied, false);
    await client.query("DROP INDEX home_operations_due");
    await client.query("CREATE INDEX home_operations_due ON events ((payload->>'otherField')) WHERE kind='home_operation'");
    const refused = await applyHomeMigration(client, authorization);
    assert.equal(refused.code, "HOME_INDEX_DEFINITION_REVIEW_REQUIRED"); assert.equal(refused.applied, false);
    assert.deepEqual(await store.snapshot(), before);
  } finally {
    await client.query("DROP INDEX home_operations_due"); await applySchemaMigrations(client); client.release();
  }
});
