// AdminVouchers (canvas: AdminVouchers, #343; owner 26 Nov): one customer or a
// number with no account yet, a catalogue bundle or (owners) a custom gift,
// with atomic active-bundle consent.
import { escapeHtml as h } from '/shared/safe-html.js';
import { format } from '/shared/i18n.js';
import { currentLanguage } from '/shared/ui/dom.js';
const L = (key, values = {}) => format(key, values, currentLanguage());
const nine = phone => String(phone || '').replace(/\D/g, '').replace(/^237(?=\d{9}$)/, '');
// "6•• •• 12 45" in the search results; "+237 6•• •• 12 45" once picked.
const short = phone => { const d = nine(phone); return d.length === 9 ? `${d[0]}•• •• ${d.slice(5, 7)} ${d.slice(7)}` : phone || ''; };
const validNumber = value => /^6\d{8}$/.test(nine(value));
const mask = phone => { const digits = String(phone || '').replace(/\D/g, '').replace(/^237(?=\d{9}$)/, ''); return digits.length === 9 ? `+237 ${digits[0]}•• •• ${digits.slice(5, 7)} ${digits.slice(7)}` : phone || ''; };
export const voucherPlanDetail = p => { const hours = Number(p.validityHours); const time = hours >= 24 && hours % 24 === 0 ? L(hours === 24 ? 'adminOneDay' : 'adminDays', { count: hours / 24 }) : L(hours === 1 ? 'adminOneHour' : 'adminHours', { count: hours }); const slots = Number(p.deviceSlots ?? p.deviceLimit), devices = p.accessType === 'personal_unlimited' && Number.isInteger(slots) && slots > 0 ? L(slots === 1 ? 'adminGiveOneDevice' : 'adminGiveDevices', { count: slots }) : ''; return [p.quotaGb == null ? L('adminBundleUnlimited') : L('adminGiveGb', { count: Number(p.quotaGb).toLocaleString(currentLanguage()) }), time, devices].filter(Boolean).join(' · '); };
const active = customer => customer?.summary?.bundle?.status === 'active' ? customer.summary.bundle : null;
// "25 Nov", as drawn.
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(currentLanguage() === 'fr' ? 'fr' : 'en-GB', { day: 'numeric', month: 'short', timeZone: 'Africa/Douala' }) : '';

export function mountCustomerVoucher(host, { call: apiCall, plans, role, onReady, onMode = () => {} }) {
  if (!host || !['owner', 'operator'].includes(role)) return null;
  // A temporary read/write failure must retain consent and any uncertain receipt.
  const call = (path, options = {}) => apiCall(path, { ...options, preservePageOnUnavailable: true });
  let customer = null, reserved = null, planId = plans[0]?.id || '', kind = 'sold', confirmed = false, pending = false, uncertain = false, result = null;
  // The bundle: from the catalogue, or (owners only) a custom gift with its terms.
  const owner = role === 'owner';
  let source = 'catalogue', custom = { access: 'personal_unlimited', value: '', unit: 'days', slots: '', reason: '' };
  let mode = 'customer', generation = 0, timer;
  const modes = document.getElementById('voucherModes'), batch = document.getElementById('voucherBatch');
  const currentPlan = () => plans.find(p => p.id === planId);
  const isCustom = () => owner && source === 'custom';
  const customHours = () => { const n = Number(custom.value); return Number.isSafeInteger(n) && n > 0 ? n * (custom.unit === 'days' ? 24 : 1) : 0; };
  const customSlots = () => custom.access === 'home_wisp_unlimited' ? 1 : Number(custom.slots);
  const customValid = () => customHours() >= 1 && customHours() <= 365 * 24 && Number.isSafeInteger(customSlots()) && customSlots() >= 1 && customSlots() <= 10 && custom.reason.trim().length > 0 && custom.reason.trim().length <= 300;
  // "Gift from NDAHI · Unlimited · 10 days · 3 devices", as the customer sees it.
  const customTerms = () => { const n = Number(custom.value) || 0, length = L(custom.unit === 'days' ? (n === 1 ? 'adminGiveOneDayWord' : 'adminGiveDaysWord') : (n === 1 ? 'adminGiveOneHourWord' : 'adminGiveHoursWord'), { count: n });
    return custom.access === 'home_wisp_unlimited' ? `${L('adminGiveWisp')} · ${length}` : [L('adminBundleUnlimited'), length, customSlots() > 0 ? L(customSlots() === 1 ? 'adminGiveOneDevice' : 'adminGiveDevices', { count: customSlots() }) : ''].filter(Boolean).join(' · '); };
  const target = () => customer || reserved;
  const canGive = () => Boolean(target() && (isCustom() ? customValid() : currentPlan()) && (!active(customer) || confirmed) && !pending && !uncertain);
  const label = () => reserved
    ? (isCustom() ? L('adminGiveReserveCustom') : L('adminGiveReserve', { plan: currentPlan()?.name || L('adminFieldBundle') }))
    : isCustom() ? L('adminGiveCustomGift') : L(kind === 'gift' ? 'adminGiveGift' : 'adminGiveSold', { plan: currentPlan()?.name || L('adminFieldBundle') });
  const remaining = bytes => Number.isFinite(bytes) ? bytes > 0 && bytes < 1000 ? L('adminGiveTiny') : L(bytes >= 1e9 ? 'adminGiveGb' : 'adminGiveMb', { count: (bytes / (bytes >= 1e9 ? 1e9 : 1e6)).toLocaleString(currentLanguage(), { maximumFractionDigits: 3 }) }) : null;
  // An Unlimited bundle never shows data left: only when it ends.
  const warningDetail = c => { const bundle = active(c), amount = bundle?.accessType || bundle?.quotaBytes == null ? null : remaining(bundle?.remainingBytes), ends = date(bundle?.expiresAt); return ends ? L(amount ? 'adminGiveRemainingEnds' : 'adminGiveEnds', { amount, date: ends }) : ''; };
  const line = (c, picked) => picked
    ? [mask(c.phone), active(c) ? L('adminGiveActiveSummary', { plan: active(c).name || L('adminActiveBundle'), date: date(active(c).expiresAt) }) : L('adminGiveNoActive')].filter(Boolean).join(' · ')
    : [short(c.phone), active(c) ? L('adminGiveHitActive', { plan: active(c).name || L('adminActiveBundle') }) : L('adminGiveHitNone')].filter(Boolean).join(' · ');
  const person = (c, picked = false) => `<span class="nd-avatar" aria-hidden="true">${h((c.name || '?').trim().charAt(0).toUpperCase())}</span><span class="customer-voucher__person"><strong>${h(c.name || L('adminUnnamedCustomer'))}</strong><span class="nd-meta">${h(line(c, picked))}</span></span>${picked ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" data-give-change>${h(L('adminGiveChange'))}</button>` : ''}`;
  // Who it's for, the bundle (catalogue or custom), how it was paid, the replace warning and the button.
  function givingMarkup() {
    const who = customer ? `<div class="customer-voucher__picked">${person(customer, true)}</div>`
      : `<div class="customer-voucher__picked customer-voucher__picked--unknown"><span class="nd-avatar nd-avatar--unknown" aria-hidden="true">?</span><span class="customer-voucher__person"><strong>${h(mask(reserved))}</strong><span class="nd-meta">${h(L('adminGiveNoAccountYet'))}</span></span><button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" data-give-change>${h(L('adminGiveChange'))}</button></div>
        <p class="customer-voucher__reserved">${h(L('adminGiveReservedIntro', { reserved: '\u0001', and: '\u0002' })).replace('\u0001', `<strong>${h(L('adminGiveReservedStrong'))}</strong>`).replace('\u0002', `<em>${h(L('adminGiveReservedAnd'))}</em>`)}</p>`;
    const tabs = owner ? `<div class="customer-voucher__source" role="tablist" aria-label="${h(L('adminGiveSourceLabel'))}">${[['catalogue', 'adminGiveFromCatalogue'], ['custom', 'adminGiveCustomBundle']].map(([id, key]) => `<button type="button" role="tab" data-give-source="${id}" aria-selected="${source === id}" tabindex="${source === id ? 0 : -1}">${h(L(key))}</button>`).join('')}</div>` : '';
    const catalogue = `<select class="nd-input" name="planId" aria-label="${h(L('adminGiveCatalogueBundle'))}" required>${plans.map(p => `<option value="${h(p.id)}" ${p.id === planId ? 'selected' : ''}>${h(p.name)} · ${h(voucherPlanDetail(p))}</option>`).join('')}</select>`;
    const kinds = isCustom() ? '' : `<fieldset class="customer-voucher__kinds"><legend class="nd-label">${h(L('adminGivePaidHow'))}</legend>${['sold', 'gift'].map(k => `<label class="customer-voucher__kind ${kind === k ? 'is-selected' : ''}" data-give-kind><input type="radio" name="saleType" value="${k}" ${kind === k ? 'checked' : ''}><span><strong>${h(L(k === 'sold' ? 'adminSaleSoldShort' : 'adminSaleGiftShort'))}</strong><span class="nd-meta">${h(L(k === 'sold' ? 'adminGiveSoldHint' : 'adminGiveGiftHint'))}</span></span></label>`).join('')}</fieldset>`;
    const devices = Number(active(customer)?.slotsUsed ?? active(customer)?.activeDevices);
    const warning = active(customer) ? `<div class="nd-callout nd-callout--warning customer-voucher__warning"><p class="customer-voucher__warning-copy"><strong>${h(L('adminGiveActiveWarning', { name: customer.name || customer.phone, plan: active(customer).name || L('adminActiveBundle') }))}</strong> ${h(warningDetail(customer))} ${h(L(devices > 0 ? (devices === 1 ? 'adminGiveReplaceWarningOne' : 'adminGiveReplaceWarningCount') : 'adminGiveReplaceWarning', { count: devices }))}</p><label class="admin-check"><input type="checkbox" name="replaceActive" ${confirmed ? 'checked' : ''}> ${h(L('adminGiveConfirmReplace'))}</label></div>` : '';
    return `${who}<div class="customer-voucher__bundle"><span class="nd-label">${h(L('adminFieldBundle'))}</span>${tabs}${isCustom() ? customMarkup() : catalogue}</div>${kinds}${warning}<button type="submit" class="nd-btn nd-btn--block" data-give-submit>${h(label())}</button><p class="nd-hint">${h(L(reserved ? 'adminGiveReserveNote' : 'adminGiveStarts'))}</p>`;
  }
  // A custom gift (owners only, #421): access type, validity, device slots, the reason and what they'll see.
  function customMarkup() {
    const wisp = custom.access === 'home_wisp_unlimited';
    return `<div class="customer-voucher__custom"><fieldset class="customer-voucher__access"><legend class="nd-label">${h(L('adminGiveAccessType'))}</legend>${[['personal_unlimited', 'adminGivePersonal', 'adminGivePersonalHint'], ['home_wisp_unlimited', 'adminGiveWisp', 'adminGiveWispHint']].map(([id, name, hint]) => `<label class="customer-voucher__choice ${custom.access === id ? 'is-selected' : ''}"><input type="radio" name="customAccess" value="${id}" ${custom.access === id ? 'checked' : ''}><span><strong>${h(L(name))}</strong><span class="nd-meta">${h(L(hint))}</span></span></label>`).join('')}</fieldset>
      <div><label class="nd-label" for="giveValidity">${h(L('adminGiveValidity'))}</label><div class="customer-voucher__validity"><input class="nd-input" id="giveValidity" name="customValue" type="number" min="1" max="8760" inputmode="numeric" value="${h(custom.value)}" required><div class="customer-voucher__unit" role="radiogroup" aria-label="${h(L('adminGiveUnit'))}">${['hours', 'days'].map(u => `<label class="${custom.unit === u ? 'is-selected' : ''}"><input type="radio" name="customUnit" value="${u}" ${custom.unit === u ? 'checked' : ''}><span>${h(L(u === 'days' ? 'adminGiveUnitDays' : 'adminGiveUnitHours'))}</span></label>`).join('')}</div></div><p class="nd-hint">${h(L('adminGiveValidityHint'))}</p></div>
      ${wisp ? `<p class="customer-voucher__wisp">${h(L('adminGiveWispLine'))}</p>` : `<div><span class="nd-label" id="giveSlotsLabel">${h(L('adminGiveSlots'))}</span><div class="customer-voucher__slots" role="group" aria-labelledby="giveSlotsLabel">${[1, 2, 4, 6].map(n => `<button type="button" data-give-slots="${n}" aria-pressed="${String(custom.slots) === String(n)}">${n}</button>`).join('')}<span>${h(L('adminGiveOr'))}</span><input class="nd-input" name="customSlots" type="number" min="1" max="10" inputmode="numeric" aria-label="${h(L('adminGiveSlotsCustom'))}" value="${h(custom.slots)}"></div></div>`}
      <div class="customer-voucher__data"><span>${h(L('adminGiveData'))}</span><strong>${h(L('adminBundleUnlimited'))}</strong></div>
      <div><label class="nd-label" for="giveReason">${h(L('adminGiveReason'))}</label><input class="nd-input" id="giveReason" name="customReason" maxlength="300" value="${h(custom.reason)}" required></div>
      <p class="customer-voucher__preview"><span>${h(L('adminGiveTheySee'))}</span> <span data-give-preview>${h(L('adminGiveGiftFrom', { terms: customTerms() }))}</span></p>
      <p class="customer-voucher__owners"><strong>${h(L('adminGiveOwnersOnly'))}</strong> ${h(L('adminGiveOwnersOnlyText'))}</p></div>`;
  }
  function sync() {
    host.querySelector('form')?.setAttribute('aria-busy', String(pending));
    const submit = host.querySelector('[data-give-submit]');
    if (submit) { submit.textContent = pending ? L('adminGiveWorking') : label(); submit.disabled = !canGive(); }
    host.querySelectorAll('[data-give-kind]').forEach(n => n.classList.toggle('is-selected', n.querySelector('input').checked));
    modes?.querySelectorAll('button').forEach(n => { n.disabled = pending; });
  }
  function clearConsent() {
    confirmed = false; const check = host.querySelector('[name="replaceActive"]'); if (check) check.checked = false;
  }
  function draw() {
    if (!host.isConnected) return;
    if (result) {
      const v = result.voucher, p = result.plan;
      const verified = result.verified, unexpectedReplacement = result.unexpectedReplacement;
      const labelKey = v.saleType === 'gift' ? 'adminSaleGiftShort' : v.saleType === 'sold' ? 'adminSaleSoldShort' : 'adminSaleUnclassified';
      const warning = verified ? '' : `<p class="nd-error customer-voucher__anomaly" role="alert">${h(L('adminGiveUnexpectedResult'))}</p>`;
      const replacement = unexpectedReplacement ? `<p class="nd-error customer-voucher__anomaly" role="alert">${h(L('adminGiveUnexpectedReplacement', { id: result.replacedVoucher?.id || L('adminGiveNoneReturned') }))}</p>` : result.replacedVoucher?.status === 'replaced' ? `<p class="nd-callout nd-callout--warning">${h(L('adminGiveReplacedDone', { plan: result.replacedName || L('adminActiveBundle') }))}</p>` : '';
      // "Gift · Custom · Unlimited · 10 days · 3 devices" or "Sold · [PLAN 2] · Unlimited · 7 days · 2 devices".
      const tag = result.gift ? `${L('adminSaleGiftShort')} · ${L('adminGiveCustomShort')} · ${String(p.name || '').replace(/^Gift from NDAHI · /, '')}` : `${L(labelKey)} · ${p.name} · ${voucherPlanDetail(p)}`;
      const reservation = v.reservation?.expiresAt ? new Date(v.reservation.expiresAt).toLocaleDateString(currentLanguage() === 'fr' ? 'fr' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Africa/Douala' }) : '';
      const done = result.reservedPhone ? L('adminGiveReservedDone', { number: mask(result.reservedPhone), date: reservation })
        : L(v.status === 'available' ? 'adminGiveSavedNow' : 'adminGiveActiveNow', { name: customer?.name || customer?.phone || '' });
      host.innerHTML = `<div class="customer-voucher__success" role="status"><div class="customer-voucher__code"><p class="nd-eyebrow">${h(tag)}</p><p class="nd-code nd-code--xl">${h(v.code)}</p>${verified ? `<p>${h(done)}</p>` : ''}</div>${warning}${replacement}${verified && !unexpectedReplacement ? `<div class="customer-voucher__success-actions"><a class="nd-btn nd-btn--secondary" href="/dashboard#voucher-print">${h(L('adminGivePrint'))}</a><button type="button" class="nd-btn nd-btn--secondary" data-give-another>${h(L('adminGiveAnother'))}</button></div>` : `<button type="button" class="nd-btn nd-btn--secondary" data-give-review>${h(L('adminGiveReview'))}</button>`}</div>`;
      host.querySelector('[data-give-another]')?.addEventListener('click', () => { result = null; customer = null; reserved = null; kind = 'sold'; source = 'catalogue'; custom = { access: 'personal_unlimited', value: '', unit: 'days', slots: '', reason: '' }; clearConsent(); draw(); host.querySelector('input')?.focus(); });
      host.querySelector('[data-give-review]')?.addEventListener('click', reviewRecent); return;
    }
    host.innerHTML = `<form id="customerVoucherForm" class="customer-voucher" autocomplete="off"><fieldset class="customer-voucher__fields" ${pending || uncertain ? 'disabled' : ''}><legend class="nd-visually-hidden">${h(L('adminGiveVoucher'))}</legend>
      ${target() ? givingMarkup() : `<label class="nd-field"><span class="nd-label">${h(L('adminGiveSearch'))}</span><input class="nd-input" type="search" name="customerSearch" maxlength="100" placeholder="${h(L('adminGiveSearchPlaceholder'))}" aria-controls="giveCustomerMatches"></label><div id="giveCustomerMatches" class="customer-voucher__matches" aria-live="polite"></div>`}
      </fieldset><p class="nd-error" id="giveVoucherMessage" role="alert"></p></form>`;
    const form = host.querySelector('form'), search = form.elements.customerSearch;
    host.querySelector('[data-give-change]')?.addEventListener('click', () => { customer = null; reserved = null; generation++; clearConsent(); draw(); host.querySelector('input')?.focus(); });
    // The bundle source tabs (owners): From the catalogue, Custom bundle.
    const tabs = [...host.querySelectorAll('[data-give-source]')];
    tabs.forEach(tab => {
      tab.onclick = () => { if (pending || source === tab.dataset.giveSource) return; source = tab.dataset.giveSource; draw(); host.querySelector(`[data-give-source="${source}"]`)?.focus(); };
      tab.onkeydown = e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const next = e.key === 'Home' ? tabs[0] : e.key === 'End' ? tabs.at(-1) : tabs.find(t => t !== tab); next.click(); };
    });
    // The custom form keeps what was typed; the preview and the button follow it.
    const syncCustom = () => { const preview = host.querySelector('[data-give-preview]'); if (preview) preview.textContent = L('adminGiveGiftFrom', { terms: customTerms() }); sync(); };
    host.querySelectorAll('[name="customAccess"]').forEach(n => { n.onchange = () => { custom.access = n.value; draw(); host.querySelector(`[name="customAccess"][value="${n.value}"]`)?.focus(); }; });
    const value = form.elements.customValue; if (value) value.oninput = () => { custom.value = value.value.trim(); syncCustom(); };
    host.querySelectorAll('[name="customUnit"]').forEach(n => { n.onchange = () => { custom.unit = n.value; host.querySelectorAll('.customer-voucher__unit label').forEach(l => l.classList.toggle('is-selected', l.querySelector('input').checked)); syncCustom(); }; });
    const slotInput = form.elements.customSlots, pressSlots = () => host.querySelectorAll('[data-give-slots]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.giveSlots === String(custom.slots))));
    host.querySelectorAll('[data-give-slots]').forEach(b => { b.onclick = () => { custom.slots = b.dataset.giveSlots; if (slotInput) slotInput.value = custom.slots; pressSlots(); syncCustom(); }; });
    if (slotInput) slotInput.oninput = () => { custom.slots = slotInput.value.trim(); pressSlots(); syncCustom(); };
    const reason = form.elements.customReason; if (reason) reason.oninput = () => { custom.reason = reason.value; syncCustom(); };
    if (search) {
      search.oninput = () => { clearTimeout(timer); const token = ++generation; host.querySelector('#giveCustomerMatches').textContent = L('adminGiveSearching'); timer = setTimeout(() => void find(search.value, token), 250); };
      search.onkeydown = e => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(timer); void find(search.value, ++generation); } };
      void find('', ++generation);
    }
    if (form.elements.planId) form.elements.planId.onchange = e => { planId = e.target.value; clearConsent(); sync(); };
    host.querySelectorAll('[name="saleType"]').forEach(n => { n.onchange = () => { kind = n.value; clearConsent(); sync(); }; });
    if (form.elements.replaceActive) form.elements.replaceActive.onchange = e => { confirmed = e.target.checked; sync(); };
    form.onsubmit = submit; sync();
  }
  async function find(query, token, id) {
    try {
      const found = await call(`/api/admin/records?${new URLSearchParams({ collection: 'customers', pageSize: 20, q: query.trim(), status: 'active' })}`);
      if (token !== generation || !host.isConnected) return;
      const items = (found.items || []).filter(c => c.status !== 'suspended');
      if (id) {
        const selected = items.find(c => c.id === id);
        if (!selected) throw Object.assign(Error(), { code: 'CUSTOMER_UNAVAILABLE' });
        customer = selected; clearConsent(); draw(); host.querySelector('select')?.focus(); return;
      }
      const matches = host.querySelector('#giveCustomerMatches'); if (!matches) return;
      // A full number with no account: the voucher can be reserved for it (#254).
      const number = validNumber(query) && !items.some(c => nine(c.phone) === nine(query)) && !(found.items || []).some(c => nine(c.phone) === nine(query)) ? nine(query) : null;
      const shown = items.length + (number ? 1 : 0), total = Math.max(Number.isInteger(found.total) ? found.total : items.length, items.length) + (number ? 1 : 0);
      const count = total > shown ? L('adminGiveShowingMatches', { count: shown, total }) : L(shown === 1 ? 'adminGiveOneMatch' : 'adminGiveMatches', { count: shown });
      const unknown = number ? `<button type="button" class="customer-voucher__hit customer-voucher__hit--unknown" data-give-number="${h(number)}"><span class="nd-avatar nd-avatar--unknown" aria-hidden="true">?</span><span class="customer-voucher__person"><strong>${h(short(number))}</strong><span class="nd-meta">${h(L('adminGiveNoAccount'))}</span></span></button>` : '';
      matches.innerHTML = shown ? `<p class="nd-hint">${h(count)}</p>` + items.map((c, i) => `<button type="button" class="customer-voucher__hit" data-give-pick="${i}">${person(c)}</button>`).join('') + unknown : `<p class="nd-hint">${h(L('adminGiveNoMatch'))}</p>`;
      matches.querySelectorAll('[data-give-pick]').forEach(button => { button.onclick = () => { if (pending) return; customer = items[Number(button.dataset.givePick)]; reserved = null; generation++; clearConsent(); draw(); host.querySelector('select, [name="customValue"]')?.focus(); }; });
      matches.querySelector('[data-give-number]')?.addEventListener('click', event => { if (pending) return; reserved = event.currentTarget.dataset.giveNumber; customer = null; generation++; clearConsent(); draw(); host.querySelector('select, [name="customValue"]')?.focus(); });
    } catch (error) {
      if (token === generation && host.isConnected) {
        const target = host.querySelector('#giveCustomerMatches') || host.querySelector('#giveVoucherMessage');
        if (target) target.textContent = L(error.code === 'CUSTOMER_UNAVAILABLE' ? 'adminGiveCustomerUnavailable' : 'adminGiveSearchFailed');
      }
    }
  }
  async function submit(e) {
    e.preventDefault(); if (!canGive()) return;
    const acceptedId = active(customer)?.id || null;
    pending = true; sync(); host.querySelector('.customer-voucher__fields').disabled = true;
    let mutationStarted = false;
    try {
      if (customer) {
        // Re-read before mutation: a changed bundle needs a NEW explicit consent.
        const fresh = await call(`/api/admin/records?${new URLSearchParams({ collection: 'customers', pageSize: 20, q: customer.id })}`);
        const next = fresh.items?.find(c => c.id === customer.id);
        if (!next || next.status === 'suspended') throw Object.assign(Error(), { code: 'CUSTOMER_UNAVAILABLE' });
        if ((active(next)?.id || null) !== acceptedId) { customer = next; clearConsent(); pending = false; draw(); host.querySelector('#giveVoucherMessage').textContent = L('adminGiveChanged'); return; }
      }
      // Custom gifts are always gifts (#421); a number with no account is reserved (#254).
      const gift = isCustom(), saleType = gift ? 'gift' : kind, replacedName = active(customer)?.name || '';
      const payload = { purpose: 'assigned', saleType,
        ...(customer ? { customerId: customer.id, replaceActive: Boolean(active(customer) && confirmed), expectedActiveVoucherId: acceptedId } : { reservedPhone: reserved }),
        ...(gift ? { planMode: 'customGift', reason: custom.reason.trim(), customTerms: { accessType: custom.access, validityValue: Number(custom.value), validityUnit: custom.unit, deviceSlots: customSlots() } } : { planId }) };
      mutationStarted = true;
      const issued = await call('/api/admin/vouchers/generate', { method: 'POST', body: JSON.stringify(payload) });
      if (!issued.voucher?.code || !issued.plan) throw Error(L('adminGiveUnknownOutcome'));
      const v = issued.voucher, rightPlan = gift ? issued.plan.catalogue === 'custom_gift' : v.planId === planId;
      result = { ...issued, gift, reservedPhone: reserved, replacedName,
        verified: v.saleType === saleType && rightPlan && (customer
          // A Personal Unlimited bundle waits for its first connection (#334), so it comes back "available".
          ? v.customerId === customer.id && (v.status === 'active' || (v.status === 'available' && (v.startsOnFirstConnection === true || issued.plan.accessType === 'personal_unlimited')))
          : v.status === 'available' && !v.customerId && nine(v.reservation?.phone) === reserved),
        unexpectedReplacement: (issued.replacedVoucher?.id || null) !== acceptedId || Boolean(issued.replacedVoucher && issued.replacedVoucher.status !== 'replaced'),
      };
      draw(); host.querySelector('[data-give-another], [data-give-review]')?.focus();
      // Refresh/print preparation must never hide a known creation receipt.
      try { onReady(result.verified && !result.unexpectedReplacement ? issued : null); } catch (_) { /* The receipt remains visible. */ }
    } catch (error) {
      if (error.code === 'ACTIVE_BUNDLE_CHANGED' || (error.code === 'ACTIVE_BUNDLE_EXISTS' && error.activeBundle)) {
        customer = { ...customer, summary: { ...customer.summary, bundle: error.activeBundle ? { ...error.activeBundle, status: 'active' } : null } }; clearConsent(); pending = false; draw();
        host.querySelector('#giveVoucherMessage').textContent = L('adminGiveChanged');
      } else {
        uncertain = mutationStarted && (!error.status || error.status >= 500);
        const message = host.querySelector('#giveVoucherMessage');
        if (message) {
          message.textContent = uncertain ? L('adminGiveUnknownOutcome') : error.code === 'ACCOUNT_EXISTS' ? L('adminGiveAccountExists') : mutationStarted ? (isCustom() && error.status === 400 && error.message ? error.message : L('adminGiveRejected')) : L(error.code === 'CUSTOMER_UNAVAILABLE' ? 'adminGiveCustomerUnavailable' : 'adminGivePreflightFailed');
          if (uncertain) {
            if (customer) try {
              const fresh = await call(`/api/admin/records?${new URLSearchParams({ collection: 'customers', pageSize: 20, q: customer.id })}`);
              const observed = active(fresh.items?.find(c => c.id === customer.id));
              if (observed && observed.id !== acceptedId) message.append(' ', L('adminGiveObservedAfterLostReply', { plan: observed.name || L('adminActiveBundle'), date: date(observed.expiresAt) }));
            } catch (_) { /* An unavailable read never permits an automatic retry. */ }
            const review = document.createElement('button'); review.type = 'button'; review.className = 'nd-btn nd-btn--secondary'; review.textContent = L('adminGiveReview'); review.onclick = reviewRecent; message.after(review);
          }
        }
      }
    } finally {
      pending = false; const field = host.querySelector('.customer-voucher__fields'); if (field) field.disabled = uncertain; sync();
    }
  }
  function reviewRecent() { const recent = document.getElementById('voucherRecords'); recent?.scrollIntoView({ block: 'start' }); const title = recent?.querySelector('h2'); if (title) { title.tabIndex = -1; title.focus({ preventScroll: true }); } }
  function showMode(value) {
    if (pending) return;
    mode = value === 'batch' ? 'batch' : 'customer'; host.hidden = mode !== 'customer'; if (batch) batch.hidden = mode !== 'batch';
    modes?.querySelectorAll('[data-voucher-mode]').forEach(button => { const selected = button.dataset.voucherMode === mode; button.setAttribute('aria-selected', String(selected)); button.tabIndex = selected ? 0 : -1; });
    onMode(mode);
  }
  modes?.querySelectorAll('[data-voucher-mode]').forEach(button => {
    button.onclick = () => showMode(button.dataset.voucherMode);
    button.onkeydown = e => { if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return; e.preventDefault(); const buttons = [...modes.querySelectorAll('button')]; const next = e.key === 'Home' ? buttons[0] : e.key === 'End' ? buttons[1] : buttons.find(b => b !== button); showMode(next.dataset.voucherMode); next.focus(); };
  });
  draw(); showMode(location.hash === '#voucher-create' ? 'batch' : 'customer');
  return { open(id) {
    if (pending) return;
    if (uncertain) {
      showMode('customer'); const message = host.querySelector('#giveVoucherMessage');
      if (message && !message.dataset.reviewFirst) { message.append(' ', L('adminGiveReviewFirst')); message.dataset.reviewFirst = 'true'; }
      return;
    } customer = null; reserved = null; result = null; uncertain = false; clearConsent(); showMode('customer'); draw(); void find(id, ++generation, id); }, showMode };
}
