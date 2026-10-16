// Opt-in data-usage notifications for this device (Web Push).
const supported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const applicationServerKey = (value) => {
  const base64 = (value + "=".repeat((4 - value.length % 4) % 4)).replaceAll("-", "+").replaceAll("_", "/");
  return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
};
const currentSubscription = async () =>
  (await navigator.serviceWorker.getRegistration("/"))?.pushManager.getSubscription() ?? null;

export async function usageAlertStatus(server) {
  if (!server?.available) return "unavailable";
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "blocked";
  return (await currentSubscription()) && Notification.permission === "granted" ? "on" : "off";
}

// Ask for permission first, while the tap still counts as a user gesture.
export async function enableUsageAlerts(call, publicKey) {
  if (await Notification.requestPermission() !== "granted") {
    throw Error("Notifications are blocked for this site. Allow them in your browser settings, then try again.");
  }
  const registration = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription() ||
    await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) });
  await call("/api/account/push/subscribe", { method: "POST", body: JSON.stringify(subscription.toJSON()) });
}

export async function disableUsageAlerts(call) {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await call("/api/account/push/unsubscribe", { method: "POST", body: JSON.stringify({ endpoint: subscription.endpoint }) });
  await subscription.unsubscribe();
}

export const usageAlertCopy = {
  unsupported: "This browser can't show notifications. Open NDAHI Connect in Chrome, or on iPhone add it to your Home Screen and open it from there, to turn on alerts.",
  blocked: "Notifications are blocked for this site. Allow them in your browser's site settings to get usage alerts.",
  off: "Get a notification on this device at 50%, 75% and 100% of your bundle's data.",
  on: "Alerts are on for this device at 50%, 75% and 100% of your bundle's data.",
};
