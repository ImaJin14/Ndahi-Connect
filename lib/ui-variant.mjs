// Chooses which copy of the customer or admin front end a visitor sees while a
// redesign (v2) runs beside the current pages (v1). Both call the same API.
// Operating guide: docs/operations/ui-rollout.md.
// Legacy cookie: automatically saved samples and the earlier ?ui= opt-ins.
export const uiVariantCookie = "ndahi_ui";
// Deliberate ?ui=new|old choices, one per app.
export const adminUiVariantCookie = "ndahi_admin_ui";
export const portalUiVariantCookie = "ndahi_portal_ui";
const choiceCookies = { customer: portalUiVariantCookie, admin: adminUiVariantCookie };
const defaultKeys = { customer: "CUSTOMER_UI_DEFAULT", admin: "ADMIN_UI_DEFAULT" };
const maxAgeSeconds = 30 * 24 * 60 * 60;
const requested = { new: "v2", old: "v1" };

// Both apps default to the owner-approved v2 interface. CUSTOMER_UI_DEFAULT=v1
// or ADMIN_UI_DEFAULT=v1 keeps the earlier v1 default for that app.
export function uiRolloutErrors(env = {}, kind = "customer") {
  const errors = [], percent = String(env.UI_V2_PERCENT ?? ""), off = String(env.UI_V2_OFF ?? "");
  if (percent !== "" && !/^(?:100|[1-9]?\d)$/.test(percent)) errors.push("UI_V2_PERCENT must be a whole number from 0 to 100");
  if (off !== "" && !["true", "false"].includes(off)) errors.push('UI_V2_OFF must be exactly "true" or "false"');
  const key = defaultKeys[kind];
  if (key && env[key] && !["v1", "v2"].includes(env[key])) errors.push(`${key} must be exactly "v1" or "v2"`);
  return errors;
}

export function uiRolloutConfig(env = {}, kind = "customer") {
  const errors = uiRolloutErrors(env, kind);
  if (errors.length) throw new Error(`${errors.join("; ")}.`);
  return { percent: Number(env.UI_V2_PERCENT || 0), off: String(env.UI_V2_OFF) === "true", defaultVariant: env[defaultKeys[kind]] || "v2" };
}

const cookieValue = (cookies, name) => cookies.match(new RegExp(`(?:^|;)\\s*${name}=(v1|v2)\\s*(?:;|$)`))?.[1];

// Precedence: kill switch, ?ui=new|old, the app's saved choice, a legacy v2
// opt-in, then the app's default. Only deliberate ?ui= choices are saved under
// v2, so the automatically saved legacy v1 cookie no longer pins anyone to v1
// and a later default change applies on the next navigation.
export function selectUiVariant({ kind, url, cookieHeader = "", config, random = Math.random }) {
  if (config.off) return { variant: "v1" };
  const choice = requested[url.searchParams.get("ui")];
  if (choice) {
    const params = new URLSearchParams(url.searchParams);
    params.delete("ui");
    const query = params.toString();
    // A single leading slash keeps the redirect on this site even for paths like //host.
    const path = `/${url.pathname.replace(/^[/\\]+/, "")}`;
    return { variant: choice, persist: choiceCookies[kind], requested: true, redirect: query ? `${path}?${query}` : path };
  }
  const cookies = String(cookieHeader);
  const chosen = cookieValue(cookies, choiceCookies[kind]);
  if (chosen) return { variant: chosen };
  const legacy = cookieValue(cookies, uiVariantCookie);
  if (legacy === "v2" || config.defaultVariant === "v2") return { variant: "v2" };
  // The v1 default keeps the earlier behaviour: admin is never sampled; a
  // customer keeps their saved result, and a new one is sampled at
  // UI_V2_PERCENT and saved.
  if (kind !== "customer") return { variant: "v1" };
  if (legacy) return { variant: legacy };
  return { variant: random() * 100 < config.percent ? "v2" : "v1", persist: uiVariantCookie };
}

// Host-only (no Domain), so the portal and admin choices stay separate.
export const uiVariantSetCookie = (variant, secure, name = uiVariantCookie) =>
  `${name}=${variant}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
