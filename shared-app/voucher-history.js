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
// Saved vouchers on desktop (#356, canvas DesktopInternet; owner 27 Nov): codes
// not used yet, then the one in use, then the latest used, five in all.
export function savedVoucherRows(vouchers, now = Date.now()) {
  const records = (vouchers || []).filter((v) => v.code).map((v) => ({ ...v, displayStatus: displayedVoucherStatus(v, now) }));
  const newest = (key) => (a, b) => (Date.parse(b[key] || b.createdAt) || 0) - (Date.parse(a[key] || a.createdAt) || 0);
  const unused = records.filter((v) => v.displayStatus === "available").sort(newest("createdAt"));
  const inUse = records.filter((v) => v.displayStatus === "active").sort(newest("activatedAt"));
  const used = records.filter((v) => v.activatedAt && v.displayStatus !== "available" && v.displayStatus !== "active").sort(newest("activatedAt"));
  return [...unused, ...inUse, ...used.slice(0, Math.max(0, 5 - unused.length - inUse.length))];
}
