// Destinations come only from deployment configuration and this portal's origin.
// Never forward the pairing page's query, fragment, credentials, or `next` URL.
export function routerLoginUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/login" && !url.username && !url.password && !url.search && !url.hash ? url : null;
  } catch (_) { return null; }
}

export function wifiCompletionUrl(login, portalOrigin) {
  const target = routerLoginUrl(login);
  if (!target) return null;
  const destination = new URL("/wifi-connected.html", portalOrigin);
  target.searchParams.set("dst", destination.href);
  target.searchParams.set("popup", "false");
  return target.href;
}
