// Push/email destinations never carry account, checkout or approval credentials.
export function notificationTarget(value) {
  if (typeof value !== "string") return null;
  if (value === "/#home") return "/dashboard#home";
  return /^\/dashboard(?:#(?:home|bundles|vouchers|payments|account|devices|sessions|more))?$/.test(value) ? value : null;
}
