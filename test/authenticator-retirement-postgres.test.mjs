import test from 'node:test';
import assert from 'node:assert/strict';
import {readdir,readFile} from 'node:fs/promises';
import pg from 'pg';
import argon2 from 'argon2';
import {blank} from '../lib/api/state.mjs';
import {createPostgresStore} from '../lib/postgres-store.mjs';
import {authenticationReadiness,recordVerifiedMethod} from '../lib/authentication-migration.mjs';
import {runAuthenticatorRetirement} from '../scripts/authenticator-retirement.mjs';
const url=process.env.TEST_DATABASE_URL,skip=url?false:'TEST_DATABASE_URL is not set';
test('PostgreSQL cutover commits invalidation and version marker atomically and remains idempotent after reopen',{skip},async()=>{
 const schema=`ndahi_auth_retire_${process.pid}`,admin=new pg.Client({connectionString:url});await admin.connect();let pool;
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);pool=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
  const directory=new URL('../migrations/',import.meta.url);for(const file of(await readdir(directory)).filter(x=>/^\d+_.+\.sql$/.test(x)).sort())await pool.query(await readFile(new URL(file,directory),'utf8'));
  const store=createPostgresStore({pool,initialState:blank}),pepper='retirement-persistence-tests',now=new Date();
  await store.transaction(async s=>{
   const c={id:'retire-c',phone:'670000088',pinHash:await argon2.hash('2468'),totpSecret:'synthetic-legacy',accountBackupCodes:[{id:'preserved',hash:'synthetic'}]},a={id:'retire-a',username:'owner',active:true,role:'owner',passwordHash:await argon2.hash('a synthetic long password')};
   recordVerifiedMethod(c,'pin',null,pepper,now);recordVerifiedMethod(a,'password',null,pepper,now);s.customers.push(c);s.adminUsers.push(a);
   const report=authenticationReadiness(s,{pepper,now});s.zone.authenticationMigrationReview={version:1,digest:report.digest,rollbackRevision:'a'.repeat(40),evidenceReference:'SYNTHETIC-PG-RECOVERY-PILOT',supportRecoveryVerified:true,authenticationPilotVerified:true,at:now.toISOString()};
   s.otpChallenges.push({id:'retired-login',customerId:c.id,expiresAt:new Date(+now+300000).toISOString()});
  });
  const options={store,pepper,now:()=>now,apply:true,expectedDigest:authenticationReadiness(await store.snapshot(),{pepper,now}).digest};
  const original=store.transaction.bind(store);store.transaction=fn=>original(async s=>{await fn(s);throw Error('Synthetic commit failure');});
  await assert.rejects(runAuthenticatorRetirement(options));assert.equal((await store.snapshot()).customers[0].totpSecret,'synthetic-legacy');assert.equal((await store.snapshot()).zone.authenticatorRetirement,undefined);
  store.transaction=original;assert.equal((await runAuthenticatorRetirement(options)).applied,true);
  const reopened=createPostgresStore({pool,initialState:blank}),s=await reopened.snapshot();assert.equal(s.zone.authenticatorRetirement.version,1);assert.equal(s.customers[0].totpSecret,undefined);assert.equal(s.otpChallenges.length,0);assert.equal(s.customers[0].accountBackupCodes[0].id,'preserved');
  assert.equal((await runAuthenticatorRetirement({...options,store:reopened})).alreadyRetired,true);
 }finally{await pool?.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
});
