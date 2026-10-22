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

export function formatExpiryCountdown(expiresAt, now = new Date()) {
  if (!expiresAt) return null;
  const target = Date.parse(expiresAt);
  if (!Number.isFinite(target)) return null;
  const diffMs = target - Number(now);
  if (diffMs <= 0) return "Expired";
  const totalHours = Math.floor(diffMs / 36e5);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  const mins = Math.floor((diffMs % 36e5) / 6e4);
  if (days > 0) return `${days}d ${hours}h left`;
  if (hours > 0) return `${hours}h ${mins}m left`;
  return `${Math.max(1, mins)}m left`;
}

export function fuelStatusClass(remainingBytes, quotaBytes) {
  if (quotaBytes === null) return "fuel-unlimited";
  if (!quotaBytes || Number(remainingBytes) <= 0) return "fuel-danger";
  const ratio = Number(remainingBytes) / Number(quotaBytes);
  if (ratio <= 0.10) return "fuel-danger";
  if (ratio <= 0.25) return "fuel-warning";
  return "fuel-good";
}

