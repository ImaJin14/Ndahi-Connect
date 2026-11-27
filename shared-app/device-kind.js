// The kind of device a browser reports, for "Redeemed by J. Fon on an Android
// phone at AP-Market" (#344) and "This device · Android phone" (#372). A
// display hint only, never identity or proof. Screens translate the key.
export function deviceKind(userAgent) {
  const ua = String(userAgent || "");
  if (/iPhone/.test(ua)) return "iphone";
  if (/iPad/.test(ua)) return "ipad";
  if (/Android/i.test(ua)) return /Mobile/i.test(ua) ? "android_phone" : "android_tablet";
  if (/CrOS/.test(ua)) return "chromebook";
  if (/Windows/.test(ua)) return "windows";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Linux/.test(ua)) return "linux";
  return null;
}
