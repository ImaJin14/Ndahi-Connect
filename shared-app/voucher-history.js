export function displayedVoucherStatus(voucher, now = Date.now()) {
  return voucher.status === "active" && Date.parse(voucher.expiresAt) <= +now ? "expired" : voucher.status;
}
export function voucherHistory(vouchers, { filter = "active", page = 1, pageSize = 6, activeId, now = Date.now() } = {}) {
  const allowed = ["active", "expired", "exhausted", "all"];
  if (!allowed.includes(filter)) filter = "active";
  pageSize = Number.isInteger(pageSize) ? Math.min(25, Math.max(1, pageSize)) : 6;
  const records = vouchers.map((v) => ({ ...v, displayStatus: displayedVoucherStatus(v, now) }));
  const current = records.find((v) => v.id === activeId && v.displayStatus === "active") || records.filter((v) => v.displayStatus === "active")
    .sort((a, b) => (Date.parse(b.activatedAt) || 0) - (Date.parse(a.activatedAt) || 0))[0];
  const matching = records.filter((v) => filter === "all" || (filter === "active" ? v.id === current?.id : v.displayStatus === filter))
    .sort((a, b) => Number(b.id === current?.id) - Number(a.id === current?.id) ||
      (Date.parse(b.activatedAt || b.createdAt) || 0) - (Date.parse(a.activatedAt || a.createdAt) || 0) || a.id.localeCompare(b.id));
  const pages = Math.max(1, Math.ceil(matching.length / pageSize)), currentPage = Math.min(pages, Math.max(1, Number.isInteger(page) ? page : 1));
  return { items: matching.slice((currentPage - 1) * pageSize, currentPage * pageSize), total: matching.length, page: currentPage, pages, currentId: current?.id || null };
}
