import test from 'node:test';
import assert from 'node:assert/strict';
import {pairingFixture} from './helpers/wifi-pairing-fixture.mjs';
import {totpSecret} from '../lib/security.mjs';
const root='/api/account/device-management';

test('effective public authentication policy is fresh and exposes no readiness or credential data',async t=>{
 const f=await pairingFixture();t.after(f.close);
 const read=()=>fetch(f.api+'/api/authentication-policy');
 let r=await read(),p=await r.json();assert.equal(r.headers.get('cache-control'),'no-store');assert.equal(p.authenticatorRetired,false);
 await f.store.transaction(s=>{s.zone.authenticatorRetirement={version:1,evidenceReference:'PRIVATE-CASE'};s.customers[0].totpSecret=totpSecret();});
 r=await read();p=await r.json();assert.equal(p.authenticatorRetired,true);assert.deepEqual(p.supportedCustomerMethods,['pin','passkey']);assert.deepEqual(p.supportedAdminMethods,['pin','passkey']);assert.doesNotMatch(JSON.stringify(p),/PRIVATE-CASE|670050001|digest|totpSecret/);
});

test('retirement keeps Wi-Fi control independent and requires fresh owner proof without leftover TOTP',async t=>{
 const f=await pairingFixture();t.after(f.close);
 await f.store.transaction(s=>{s.zone.authenticatorRetirement={version:1};s.customers[0].totpSecret=totpSecret();});
 const info=await f.call(root);assert.equal(info.body.authenticatorEnrolled,false);
 assert.equal((await f.call(root+'/main',{mac:'AA:BB:CC:DD:EE:01',pin:'2468',otp:'wrong-legacy'})).status,200);
 assert.equal((await f.call(root+'/disconnect',{mac:'AA:BB:CC:DD:EE:01',otp:'123456'},{session:'secondary'})).status,401);
 f.advance(2);
 assert.equal((await f.call(root+'/disconnect',{mac:'AA:BB:CC:DD:EE:01',pin:'2468'},{session:'secondary'})).status,202);
});
