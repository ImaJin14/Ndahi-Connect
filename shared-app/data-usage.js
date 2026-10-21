export function formatDataBalance(bytes) {
  if (bytes === null) return "Unlimited";
  if (!Number.isFinite(Number(bytes))) return "Unavailable";
  const value = Math.max(0, Number(bytes));
  if (value >= 1e9) return (value / 1e9).toFixed(2) + " GB";
  if (value > 0 && value < 1000) return "<0.001 MB";
  return (value / 1e6).toLocaleString("en", { minimumFractionDigits: 0, maximumFractionDigits: 3 }) + " MB";
}
export function dataWarning(v) {
  if (!v || v.quotaBytes === null || !(v.quotaBytes > 0) || !Number.isFinite(v.usedBytes)) return null;
  const remaining = Math.max(0, v.quotaBytes - v.usedBytes);
  return remaining === 0 ? "100" : remaining <= 2000000 ? "low" : v.usedBytes / v.quotaBytes >= 0.9 ? "90" : null;
}
export const usageNotificationId = (v, level, cycle = v.usageAlertCycle) => "usage:" + v.id + ":" + (cycle ? cycle + ":" : "") + level;
