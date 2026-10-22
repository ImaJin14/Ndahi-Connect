import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import pg from 'pg';
import argon2 from 'argon2';
import {blank} from '../lib/api/state.mjs';
import {createPostgresStore} from '../lib/postgres-store.mjs';
import {authenticationReadiness,recordVerifiedMethod} from '../lib/authentication-migration.mjs';
const url=process.env.TEST_DATABASE_URL,skip=url?false:'TEST_DATABASE_URL is not set';
test('verified credential state and bound readiness review survive PostgreSQL reopen and rollback',{skip},async()=>{
 const schema=`ndahi_auth_migration_${process.pid}`,admin=new pg.Client({connectionString:url});await admin.connect();let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const directory=new URL('../migrations/',import.meta.url);for(const file of(await readdir(directory)).filter(x=>/^\d+_.+\.sql$/.test(x)).sort())await pool.query(await readFile(new URL(file,directory),'utf8'));
  const store=createPostgresStore({pool,initialState:blank}),pepper='migration-persistence-tests',now=new Date();
  await store.transaction(async s=>{
   const c={id:'migration-c',phone:'670000087',pinHash:await argon2.hash('2468'),totpSecret:'synthetic-legacy'},a={id:'migration-a',username:'owner',active:true,role:'owner',passwordHash:await argon2.hash('a synthetic long password')};
   recordVerifiedMethod(c,'pin',null,pepper,now);recordVerifiedMethod(a,'password',null,pepper,now);s.customers.push(c);s.adminUsers.push(a);
   const report=authenticationReadiness(s,{pepper,now});s.zone.authenticationMigrationReview={version:1,digest:report.digest,rollbackRevision:'a'.repeat(40),evidenceReference:'SYNTHETIC-RECOVERY-PILOT',supportRecoveryVerified:true,authenticationPilotVerified:true,at:now.toISOString()};
  });
  const reopened=createPostgresStore({pool,initialState:blank});assert.equal(authenticationReadiness(await reopened.snapshot(),{pepper,now}).ready,true);
  await assert.rejects(reopened.transaction(s=>{delete s.customers[0].pinHash;throw Error('Synthetic rollback');}));assert.equal(authenticationReadiness(await reopened.snapshot(),{pepper,now}).ready,true);
  await reopened.transaction(s=>{s.adminUsers[0].active=false;});assert.equal(authenticationReadiness(await reopened.snapshot(),{pepper,now}).ready,false);
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
