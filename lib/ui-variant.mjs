// Chooses which copy of the customer or admin front end a visitor sees while a
// redesign (v2) runs beside the current pages (v1). Both call the same API.
// Operating guide: docs/operations/ui-rollout.md.
export const uiVariantCookie = "ndahi_ui";
export const adminUiVariantCookie = "ndahi_admin_ui";
const maxAgeSeconds = 30 * 24 * 60 * 60;
const requested = { new: "v2", old: "v1" };

// Customer sampling stays off. Admin defaults to the owner-approved v2 interface.
export function uiRolloutErrors(env = {}) {
  const errors = [], percent = String(env.UI_V2_PERCENT ?? ""), off = String(env.UI_V2_OFF ?? "");
  if (percent !== "" && !/^(?:100|[1-9]?\d)$/.test(percent)) errors.push("UI_V2_PERCENT must be a whole number from 0 to 100");
  if (off !== "" && !["true", "false"].includes(off)) errors.push('UI_V2_OFF must be exactly "true" or "false"');
  if (env.ADMIN_UI_DEFAULT && !["v1", "v2"].includes(env.ADMIN_UI_DEFAULT)) errors.push('ADMIN_UI_DEFAULT must be exactly "v1" or "v2"');
  return errors;
}

export function uiRolloutConfig(env = {}) {
  const errors = uiRolloutErrors(env);
  if (errors.length) throw new Error(`${errors.join("; ")}.`);
  return { percent: Number(env.UI_V2_PERCENT || 0), off: String(env.UI_V2_OFF) === "true", adminDefault: env.ADMIN_UI_DEFAULT || "v2" };
}

// Precedence: kill switch, then ?ui=new|old, then the saved cookie, then sampling.
// Admin is not sampled. A separate preference migrates the automatically saved
// legacy v1 cookie without preventing a deliberate ?ui=old opt-out.
export function selectUiVariant({ kind, url, cookieHeader = "", config, random = Math.random }) {
  if (config.off) return { variant: "v1" };
  const choice = requested[url.searchParams.get("ui")];
  if (choice) {
    const params = new URLSearchParams(url.searchParams);
    params.delete("ui");
    const query = params.toString();
    // A single leading slash keeps the redirect on this site even for paths like //host.
    const path = `/${url.pathname.replace(/^[/\\]+/, "")}`;
    return { variant: choice, persist: true, requested: true, redirect: query ? `${path}?${query}` : path };
  }
  const cookies = String(cookieHeader);
  const saved = cookies.match(kind === "admin"
    ? /(?:^|;)\s*ndahi_admin_ui=(v1|v2)\s*(?:;|$)/
    : /(?:^|;)\s*ndahi_ui=(v1|v2)\s*(?:;|$)/)?.[1];
  if (saved) return { variant: saved };
  if (kind === "admin") {
    // Preserve legacy explicit v2 opt-ins, including preview/browser fixtures.
    const optedIn = /(?:^|;)\s*ndahi_ui=v2\s*(?:;|$)/.test(cookies);
    return { variant: optedIn ? "v2" : config.adminDefault, persist: true };
  }
  return { variant: kind === "customer" && random() * 100 < config.percent ? "v2" : "v1", persist: true };
}

// Host-only (no Domain), so the portal and admin choices stay separate.
export const uiVariantSetCookie = (variant, secure, kind = "customer") =>
  `${kind === "admin" ? adminUiVariantCookie : uiVariantCookie}=${variant}; Path=/; Max-Age=${maxAgeSeconds}; SameSite=Lax; HttpOnly${secure ? "; Secure" : ""}`;
