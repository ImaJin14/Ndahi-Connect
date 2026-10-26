// Push/email destinations never carry account, checkout or approval credentials.
export function notificationTarget(value) {
  if (typeof value !== "string") return null;
  if (value === "/#home") return "/dashboard#home";
  if (/^\/pair-review\.html\?request=[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value)) return value;
  return /^\/dashboard(?:#(?:home|bundles|vouchers|payments|account|devices|sessions|more))?$/.test(value) ? value : null;
}
