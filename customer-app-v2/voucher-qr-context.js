import { sessionStore, randomId } from "./compat.js";
const storageKey = "ndahi_voucher_scan";
export function savedVoucherScan() {
  try {
    const value = JSON.parse(sessionStore.get(storageKey) || "null");
    return value &&
      value.until > Date.now() &&
      (typeof value.qr === "string" || typeof value.legacyCode === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}
export function saveVoucherScan(value) {
  sessionStore.set(
    storageKey,
    JSON.stringify({ ...value, until: Date.now() + 600000 }),
  );
}
export function clearVoucherScan() {
  sessionStore.remove(storageKey);
}
export function redirectLegacyVoucherScan() {
  const query = new URLSearchParams(location.search);
  const code = query.get("code");
  if (query.get("action") !== "connect" || !code || code.length > 100)
    return false;
  const target = new URL("/voucher-connect.html", location.origin);
  for (const key of ["mac", "address"])
    if (query.has(key)) target.searchParams.set(key, query.get(key));
  target.hash = new URLSearchParams({ legacy: code }).toString();
  location.replace(target.href);
  return true;
}
export function resumeVoucherScanFromWifi(hint) {
  if (!hint || !savedVoucherScan()) return false;
  const target = new URL("/voucher-connect.html", location.origin);
  target.searchParams.set("mac", hint.mac);
  target.searchParams.set("address", hint.address);
  location.replace(target.href);
  return true;
}
export function voucherScanAttempt(selection, hint) {
  const current = savedVoucherScan();
  const same =
    current &&
    current.qr === selection.qr &&
    current.legacyCode === selection.legacyCode &&
    current.mac === (hint && hint.mac) &&
    current.address === (hint && hint.address);
  const value = {
    ...selection,
    ...(hint ? { mac: hint.mac, address: hint.address } : {}),
    key: same ? current.key : randomId(),
    ...(same && current.requestId ? { requestId: current.requestId } : {}),
  };
  saveVoucherScan(value);
  return value;
}
