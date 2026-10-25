import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import * as translations from '../shared-app/i18n.js';
// Policy regression: sharing builders cannot return through another customer
// module while unrelated, generic WhatsApp support remains allowed.
test('customer modules contain no retired voucher/account WhatsApp builder or control',async()=>{
 for(const dir of ['customer-app','shared-app'])for(const name of await readdir(new URL('../'+dir+'/',import.meta.url))){if(!/\.(js|html)$/.test(name))continue;const source=await readFile(new URL('../'+dir+'/'+name,import.meta.url),'utf8');assert.doesNotMatch(source,/formatWhatsAppVoucherShare|data-share-whatsapp|whatsapp-share-btn/,dir+'/'+name);if(!['errors.js','help.js'].includes(name))assert.doesNotMatch(source,/wa\.me|whatsapp:\/\//i,dir+'/'+name);}
 assert.equal(translations.formatWhatsAppVoucherShare,undefined);assert.equal(translations.TRANSLATIONS.en.shareWhatsApp,undefined);assert.equal(translations.TRANSLATIONS.fr.shareWhatsApp,undefined);
});
test('support contact is generic and does not forward account, voucher or error payloads',async()=>{
 const source=await readFile(new URL('../customer-app/errors.js',import.meta.url),'utf8');assert.match(source,/WhatsApp support/);const body=source.slice(source.indexOf('export function whatsappSupportUrl'),source.indexOf('export function showError'));assert.doesNotMatch(body,/diagnostics|\$\{phone\}|\$\{voucher\}|\$\{mac\}|\$\{error\}/);assert.match(body,/wa\.me/);
});
