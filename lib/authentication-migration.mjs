import { decodeCredentialPublicKey } from "@simplewebauthn/server/helpers";
import { hashSecret, safeEqual } from './security.mjs';

export const migrationVersion = 1;
// Historical credential destruction is distinct from the runtime sign-in policy.
// The marker also binds existing session/rollback migration contracts.
export const authenticatorRetired = s => Number(s.zone?.authenticatorRetirement?.version) >= 1;
export const authenticatorStateRetired = authenticatorRetired;
export const establishedCustomer = c => Boolean(c?.pinHash || c?.totpSecret || c?.passkeys?.length);
export function configuredPassword(hash) {
  if (typeof hash !== 'string') return false;
  const parts = hash.split('$');
  if (parts.length !== 6 || !/^argon2(?:id|i|d)$/.test(parts[1]) || parts[2] !== 'v=19') return false;
  const entries = parts[3].split(',').map(value => value.split('='));
  return entries.length === 3 && new Set(entries.map(([key]) => key)).size === 3 && entries.every(([key,value]) => ['m','t','p'].includes(key) && /^[1-9][0-9]*$/.test(value || '')) && /^[A-Za-z0-9+/]{16,}$/.test(parts[4]) && /^[A-Za-z0-9+/]{20,}$/.test(parts[5]);
}
export function configuredPasskey(key) {
  if (typeof key?.id !== 'string' || !/^[A-Za-z0-9_-]{1,2048}$/.test(key.id) || typeof key.publicKey !== 'string' || !/^[A-Za-z0-9_-]+$/.test(key.publicKey)) return false;
  try {
    const cose = decodeCredentialPublicKey(Buffer.from(key.publicKey, 'base64url'));
    const bytes = (value, min) => value instanceof Uint8Array && value.length >= min;
    return cose instanceof Map && typeof cose.get(3) === 'number' && (cose.get(1) === 2 ? bytes(cose.get(-2), 32) && bytes(cose.get(-3), 32) : cose.get(1) === 3 ? bytes(cose.get(-1), 256) && bytes(cose.get(-2), 1) : cose.get(1) === 1 && bytes(cose.get(-2), 32));
  } catch { return false; }
}
// Method tags are a closed set, never credential input or a fallback to PIN.
const canonicalMethod = value => value === 'pin' ? 'pin' : value === 'password' ? 'password' : value === 'passkey' ? 'passkey' : null;
export function credentialVersion(methodTag, person, credentialId, pepper) {
  const method = canonicalMethod(methodTag);
  if (!method) return null;
  const material = method === 'passkey' ? person.passkeys?.find(k => k.id === credentialId) : method === 'password' ? person.passwordHash : person.pinHash;
  if (method === 'passkey' ? !configuredPasskey(material) : !configuredPassword(material)) return null;
  return hashSecret(JSON.stringify(['auth-migration-v1',method,person.id,method === 'passkey' ? [material.id,material.publicKey] : material]),pepper);
}
export function recordVerifiedMethod(person, methodTag, credentialId, pepper, now) {
  const method = canonicalMethod(methodTag);
  const version = credentialVersion(method,person,credentialId,pepper);
  if (!version) throw Error('A usable verified credential is required.');
  const key = method === 'passkey' ? 'passkey:' + credentialId : method;
  person.authMigration = { version: migrationVersion, methods: { ...(person.authMigration?.methods || {}), [key]: { method, ...(credentialId ? {credentialId} : {}), version, verifiedAt: now.toISOString() } } };
}
export function verifiedMethods(person, pepper, admin = false) {
  return Object.values(person.authMigration?.version === migrationVersion ? person.authMigration.methods || {} : {}).filter(proof => {
    if (!(admin ? ['pin','password','passkey'] : ['pin','passkey']).includes(proof.method) || !Number.isFinite(Date.parse(proof.verifiedAt))) return false;
    if (admin && proof.method === 'pin' && person.passwordHash && person.pinHash !== person.passwordHash) return false;
    const version = credentialVersion(proof.method,person,proof.credentialId,pepper);
    return version && safeEqual(version,proof.version || '');
  }).map(proof => proof.method);
}
export function customerMigrationStatus(c, pepper) {
  const verified = verifiedMethods(c,pepper);
  return { authenticatorEnabled: Boolean(c.totpSecret), configured: { pin: configuredPassword(c.pinHash), passkey: (c.passkeys || []).some(configuredPasskey) }, verified: {pin:verified.includes('pin'),passkey:verified.includes('passkey')}, replacementVerified: verified.length > 0, pinEnrollmentRequired: !configuredPassword(c.pinHash) };
}
// PostgreSQL JSONB can reorder object keys. Readiness binds explicit proof
// fields in sorted tuples so a database round trip cannot invalidate review.
const proofEvidence = value => value ? [value.version || null, Object.entries(value.methods || {}).sort(([a],[b]) => a.localeCompare(b)).map(([key,p]) => [key,p.method,p.credentialId || null,p.version || null,p.verifiedAt || null])] : null;
export function readinessDigest(s,pepper) {
  const customer = (s.customers || []).map(c => [c.id,c.status || '',c.totpSecret ? hashSecret(c.totpSecret,pepper) : null,credentialVersion('pin',c,null,pepper),(c.passkeys || []).map(k=>credentialVersion('passkey',c,k.id,pepper)).sort(),proofEvidence(c.authMigration)]).sort((a,b)=>a[0].localeCompare(b[0]));
  const admin = (s.adminUsers || []).map(c => [c.id,c.active,c.role,[credentialVersion('password',c,null,pepper),credentialVersion('pin',c,null,pepper)],(c.passkeys || []).map(k=>credentialVersion('passkey',c,k.id,pepper)).sort(),proofEvidence(c.authMigration)]).sort((a,b)=>a[0].localeCompare(b[0]));
  return hashSecret(JSON.stringify([migrationVersion,customer,admin]),pepper);
}
export function authenticationReadiness(s,{pepper,now = new Date()} = {}) {
  if (!pepper) throw Error('Migration readiness requires the configured secret pepper.');
  const customers = { total: 0, suspended: 0, authenticatorAccounts: 0, pinConfigured: 0, passkeyConfigured: 0, replacementVerified: 0, missingReplacement: 0, authenticatorUnverified: 0 };
  for (const c of s.customers || []) {
    const r = customerMigrationStatus(c,pepper); customers.total++;if(c.status==='suspended')customers.suspended++;
    if(r.authenticatorEnabled)customers.authenticatorAccounts++;
    if(r.configured.pin)customers.pinConfigured++;if(r.configured.passkey)customers.passkeyConfigured++;if(r.replacementVerified)customers.replacementVerified++;
    if(!r.configured.pin&&!r.configured.passkey)customers.missingReplacement++;
    if(r.authenticatorEnabled&&!r.replacementVerified)customers.authenticatorUnverified++;
  }
  const administrators = { active:0,passwordConfigured:0,pinConfigured:0,passkeyConfigured:0,replacementVerified:0,unverified:0,activeOwners:0 };
  for(const c of s.adminUsers || [])if(c.active!==false){administrators.active++;if(c.role==='owner')administrators.activeOwners++;if(configuredPassword(c.passwordHash) || configuredPassword(c.pinHash)){administrators.passwordConfigured++;administrators.pinConfigured++;}if((c.passkeys||[]).some(configuredPasskey))administrators.passkeyConfigured++;if(verifiedMethods(c,pepper,true).length)administrators.replacementVerified++;else administrators.unverified++;}
  const digest=readinessDigest(s,pepper), review=s.zone?.authenticationMigrationReview;
  const recoveryReviewed=Boolean(review?.version===migrationVersion&&review.supportRecoveryVerified===true&&review.authenticationPilotVerified===true&&/^[a-f0-9]{40}$/.test(review.rollbackRevision||'')&&review.evidenceReference&&safeEqual(review.digest||'',digest)&&Date.parse(review.at)>+now-30*86400000&&Date.parse(review.at)<=+now+5000);
  const blockers=[];if(customers.missingReplacement)blockers.push('CUSTOMER_REPLACEMENT_MISSING');if(customers.authenticatorUnverified)blockers.push('AUTHENTICATOR_REPLACEMENT_UNVERIFIED');if(!administrators.activeOwners)blockers.push('ACTIVE_OWNER_REQUIRED');if(administrators.unverified)blockers.push('ADMIN_REPLACEMENT_UNVERIFIED');if(!recoveryReviewed)blockers.push('RECOVERY_AND_PILOT_REVIEW_REQUIRED');
  return {version:migrationVersion,customers,administrators,digest,recoveryReviewed,ready:blockers.length===0,blockers,retired:authenticatorStateRetired(s)};
}
