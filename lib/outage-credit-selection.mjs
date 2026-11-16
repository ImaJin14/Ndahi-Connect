// Select at most one unambiguous voucher per customer. Ambiguous histories
// need an audited review; reviving a replaced voucher can create two active
// allocations or restore terms the customer has already replaced.
export function selectOutageCredits(state, outage, now) {
  const start = Date.parse(outage?.startedAt), end = Date.parse(outage?.fixedAt), at = +now;
  if (![start, end, at].every(Number.isFinite) || end < start) throw new RangeError("Invalid outage interval");
  const vouchers = state.vouchers || [], eligible = new Map(), byCustomer = new Map();
  for (const voucher of vouchers) {
    if (voucher.customerId) {
      const all = byCustomer.get(voucher.customerId) || [];
      all.push(voucher);
      byCustomer.set(voucher.customerId, all);
    }
    const activated = Date.parse(voucher.activatedAt), expiry = Date.parse(voucher.expiresAt);
    if (!voucher.customerId || !Number.isFinite(activated) || !Number.isFinite(expiry) ||
        activated > end || expiry <= start ||
        !(voucher.status === "active" || voucher.status === "expired" && expiry <= end)) continue;
    const group = eligible.get(voucher.customerId) || [];
    group.push(voucher);
    eligible.set(voucher.customerId, group);
  }
  const selected = [], reviewCustomerIds = [];
  for (const [customerId, candidates] of eligible) {
    const history = byCustomer.get(customerId), live = history.filter(v => v.status === "active");
    const candidate = candidates[0];
    const later = candidate && history.some(v => v.id !== candidate.id &&
      Number.isFinite(Date.parse(v.activatedAt)) && Date.parse(v.activatedAt) >= Date.parse(candidate.activatedAt));
    if (candidates.length !== 1 || live.length > 1 || (candidate.status === "expired" && (live.length || later)) ||
        (live.length && live[0].id !== candidate.id)) {
      reviewCustomerIds.push(customerId);
      continue;
    }
    selected.push(candidate);
  }
  return { vouchers: selected, reviewCustomerIds };
}
