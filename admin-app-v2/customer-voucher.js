// AdminVouchers: one existing customer, using the unchanged generate endpoint.
import { escapeHtml as h } from '/shared/safe-html.js';
import { format } from '/shared/i18n.js';
import { currentLanguage } from '/shared/ui/dom.js';
const L = (key, values = {}) => format(key, values, currentLanguage());
const mask = phone => { const digits = String(phone || '').replace(/\D/g, '').replace(/^237(?=\d{9}$)/, ''); return digits.length === 9 ? `+237 ${digits[0]}•• •• ${digits.slice(5, 7)} ${digits.slice(7)}` : phone || ''; };
export const voucherPlanDetail = p => { const hours = Number(p.validityHours); const time = hours >= 24 && hours % 24 === 0 ? L(hours === 24 ? 'adminOneDay' : 'adminDays', { count: hours / 24 }) : L(hours === 1 ? 'adminOneHour' : 'adminHours', { count: hours }); return [p.quotaGb == null ? L('adminBundleUnlimited') : L('adminGiveGb', { count: Number(p.quotaGb).toLocaleString(currentLanguage()) }), time].join(' · '); };
const active = customer => customer?.summary?.bundle?.status === 'active' ? customer.summary.bundle : null;
const date = value => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleDateString(currentLanguage(), { day: 'numeric', month: 'short' }) : '';

export function mountCustomerVoucher(host, { call: apiCall, plans, role, onReady, onMode = () => {} }) {
  if (!host || !['owner', 'operator'].includes(role)) return null;
  // A temporary read/write failure must retain consent and any uncertain receipt.
  const call = (path, options = {}) => apiCall(path, { ...options, preservePageOnUnavailable: true });
  let customer = null, planId = plans[0]?.id || '', kind = 'sold', confirmed = false, pending = false, uncertain = false, result = null;
  let mode = 'customer', generation = 0, timer;
  const modes = document.getElementById('voucherModes'), batch = document.getElementById('voucherBatch');
  const currentPlan = () => plans.find(p => p.id === planId);
  const canGive = () => Boolean(customer && currentPlan() && (!active(customer) || confirmed) && !pending && !uncertain);
  const label = () => L(kind === 'gift' ? 'adminGiveGift' : 'adminGiveSold', { plan: currentPlan()?.name || L('adminFieldBundle') });
  const remaining = bytes => Number.isFinite(bytes) ? bytes > 0 && bytes < 1000 ? L('adminGiveTiny') : L(bytes >= 1e9 ? 'adminGiveGb' : 'adminGiveMb', { count: (bytes / (bytes >= 1e9 ? 1e9 : 1e6)).toLocaleString(currentLanguage(), { maximumFractionDigits: 3 }) }) : null;
  const warningDetail = c => { const bundle = active(c), amount = remaining(bundle?.remainingBytes), ends = date(bundle?.expiresAt); return ends ? L(amount ? 'adminGiveRemainingEnds' : 'adminGiveEnds', { amount, date: ends }) : ''; };
  const line = c => [mask(c.phone), active(c) ? L('adminGiveActiveSummary', { plan: active(c).name || L('adminActiveBundle'), date: date(active(c).expiresAt) }) : L('adminGiveNoActive')].filter(Boolean).join(' · ');
  const person = (c, picked = false) => `<span class="nd-avatar" aria-hidden="true">${h((c.name || '?').trim().charAt(0).toUpperCase())}</span><span class="customer-voucher__person"><strong>${h(c.name || L('adminUnnamedCustomer'))}</strong><span class="nd-meta">${h(line(c))}</span></span>${picked ? `<button type="button" class="nd-btn nd-btn--compact nd-btn--quiet" data-give-change>${h(L('adminGiveChange'))}</button>` : ''}`;
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
      const replacement = unexpectedReplacement ? `<p class="nd-error customer-voucher__anomaly" role="alert">${h(L('adminGiveUnexpectedReplacement', { id: result.replacedVoucher?.id || L('adminGiveNoneReturned') }))}</p>` : result.replacedVoucher?.status === 'replaced' ? `<p class="nd-callout nd-callout--warning">${h(L('adminGiveReplacedPending'))}</p>` : '';
      host.innerHTML = `<div class="customer-voucher__success" role="status"><div class="customer-voucher__code"><p class="nd-eyebrow">${h(L(labelKey))} · ${h(p.name)} · ${h(voucherPlanDetail(p))}</p><p class="nd-code nd-code--xl">${h(v.code)}</p>${verified ? `<p>${h(L('adminGiveActiveNow', { name: customer.name || customer.phone }))}</p>` : ''}</div>${warning}${replacement}${verified && !unexpectedReplacement ? `<div class="customer-voucher__success-actions"><a class="nd-btn nd-btn--secondary" href="/dashboard#voucher-print">${h(L('adminGivePrint'))}</a><button type="button" class="nd-btn nd-btn--secondary" data-give-another>${h(L('adminGiveAnother'))}</button></div>` : `<button type="button" class="nd-btn nd-btn--secondary" data-give-review>${h(L('adminGiveReview'))}</button>`}</div>`;
      host.querySelector('[data-give-another]')?.addEventListener('click', () => { result = null; customer = null; kind = 'sold'; clearConsent(); draw(); host.querySelector('input')?.focus(); });
      host.querySelector('[data-give-review]')?.addEventListener('click', reviewRecent); return;
    }
    host.innerHTML = `<form id="customerVoucherForm" class="customer-voucher" autocomplete="off"><fieldset class="customer-voucher__fields" ${pending || uncertain ? 'disabled' : ''}><legend class="nd-visually-hidden">${h(L('adminGiveVoucher'))}</legend>
      ${customer ? `<div class="customer-voucher__picked">${person(customer, true)}</div><label class="nd-field"><span class="nd-label">${h(L('adminFieldBundle'))}</span><select class="nd-input" name="planId" required>${plans.map(p => `<option value="${h(p.id)}" ${p.id === planId ? 'selected' : ''}>${h(p.name)} · ${h(voucherPlanDetail(p))}</option>`).join('')}</select></label><fieldset class="customer-voucher__kinds"><legend class="nd-label">${h(L('adminGivePaidHow'))}</legend>${['sold', 'gift'].map(k => `<label class="customer-voucher__kind ${kind === k ? 'is-selected' : ''}" data-give-kind><input type="radio" name="saleType" value="${k}" ${kind === k ? 'checked' : ''}><span><strong>${h(L(k === 'sold' ? 'adminSaleSoldShort' : 'adminSaleGiftShort'))}</strong><span class="nd-meta">${h(L(k === 'sold' ? 'adminGiveSoldHint' : 'adminGiveGiftHint'))}</span></span></label>`).join('')}</fieldset>${active(customer) ? `<div class="nd-callout nd-callout--warning customer-voucher__warning"><p class="customer-voucher__warning-copy"><strong>${h(L('adminGiveActiveWarning', { name: customer.name || customer.phone, plan: active(customer).name || L('adminActiveBundle') }))}</strong> ${h(warningDetail(customer))} ${h(L('adminGiveReplaceWarning'))}</p><label class="admin-check"><input type="checkbox" name="replaceActive" ${confirmed ? 'checked' : ''}> ${h(L('adminGiveConfirmReplace'))}</label></div>` : ''}<button type="submit" class="nd-btn nd-btn--block" data-give-submit>${h(label())}</button><p class="nd-hint">${h(L('adminGiveStarts'))}</p>` : `<label class="nd-field"><span class="nd-label">${h(L('adminGiveSearch'))}</span><input class="nd-input" type="search" name="customerSearch" maxlength="100" placeholder="${h(L('adminGiveSearchHint'))}" aria-controls="giveCustomerMatches"></label><div id="giveCustomerMatches" class="customer-voucher__matches" aria-live="polite"></div>`}
      </fieldset><p class="nd-error" id="giveVoucherMessage" role="alert"></p></form>`;
    const form = host.querySelector('form'), search = form.elements.customerSearch;
    host.querySelector('[data-give-change]')?.addEventListener('click', () => { customer = null; generation++; clearConsent(); draw(); host.querySelector('input')?.focus(); });
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
      const total = Number.isInteger(found.total) ? found.total : items.length;
      const count = total > items.length ? L('adminGiveShowingMatches', { count: items.length, total }) : L(items.length === 1 ? 'adminGiveOneMatch' : 'adminGiveMatches', { count: items.length });
      matches.innerHTML = items.length ? `<p class="nd-hint">${h(count)}</p>` + items.map((c, i) => `<button type="button" class="customer-voucher__hit" data-give-pick="${i}">${person(c)}</button>`).join('') : `<p class="nd-hint">${h(L('adminGiveNoMatch'))}</p>`;
      matches.querySelectorAll('[data-give-pick]').forEach(button => { button.onclick = () => { if (pending) return; customer = items[Number(button.dataset.givePick)]; generation++; clearConsent(); draw(); host.querySelector('select')?.focus(); }; });
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
      // Re-read before mutation: a changed bundle needs a NEW explicit consent.
      const fresh = await call(`/api/admin/records?${new URLSearchParams({ collection: 'customers', pageSize: 20, q: customer.id })}`);
      const next = fresh.items?.find(c => c.id === customer.id);
      if (!next || next.status === 'suspended') throw Object.assign(Error(), { code: 'CUSTOMER_UNAVAILABLE' });
      if ((active(next)?.id || null) !== acceptedId) { customer = next; clearConsent(); pending = false; draw(); host.querySelector('#giveVoucherMessage').textContent = L('adminGiveChanged'); return; }
      const payload = { customerId: customer.id, planId, purpose: 'assigned', saleType: kind, replaceActive: Boolean(active(customer) && confirmed) };
      mutationStarted = true;
      const issued = await call('/api/admin/vouchers/generate', { method: 'POST', body: JSON.stringify(payload) });
      if (!issued.voucher?.code || !issued.plan) throw Error(L('adminGiveUnknownOutcome'));
      result = { ...issued,
        verified: issued.voucher.status === 'active' && issued.voucher.customerId === customer.id && issued.voucher.saleType === kind && issued.voucher.planId === planId,
        unexpectedReplacement: (issued.replacedVoucher?.id || null) !== acceptedId || Boolean(issued.replacedVoucher && issued.replacedVoucher.status !== 'replaced'),
      };
      draw(); host.querySelector('[data-give-another], [data-give-review]')?.focus();
      // Refresh/print preparation must never hide a known creation receipt.
      try { onReady(result.verified && !result.unexpectedReplacement ? issued : null); } catch (_) { /* The receipt remains visible. */ }
    } catch (error) {
      if (error.code === 'ACTIVE_BUNDLE_EXISTS' && error.activeBundle) {
        customer = { ...customer, summary: { ...customer.summary, bundle: { ...error.activeBundle, status: 'active' } } }; clearConsent(); pending = false; draw();
        host.querySelector('#giveVoucherMessage').textContent = L('adminGiveChanged');
      } else {
        uncertain = mutationStarted && (!error.status || error.status >= 500);
        const message = host.querySelector('#giveVoucherMessage');
        if (message) {
          message.textContent = uncertain ? L('adminGiveUnknownOutcome') : mutationStarted ? L('adminGiveRejected') : L(error.code === 'CUSTOMER_UNAVAILABLE' ? 'adminGiveCustomerUnavailable' : 'adminGivePreflightFailed');
          if (uncertain) {
            try {
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
    } customer = null; result = null; uncertain = false; clearConsent(); showMode('customer'); draw(); void find(id, ++generation, id); }, showMode };
}
