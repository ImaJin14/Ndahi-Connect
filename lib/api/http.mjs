import { isIP } from "node:net";
function resolveClientIp(req, env = process.env) {
  const peer = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
  if (env.TRUST_PROXY !== "render") return peer;
  const forwarded = String(req.headers?.["cf-connecting-ip"] || "").trim();
  return isIP(forwarded) ? forwarded.replace(/^::ffff:/, "") : peer;
}
// Path template for logs: identifier-like segments become ":id"; query strings are never logged.
const routeLabel = (pathname) =>
  String(pathname)
    .split("/")
    .map((part) => (part === "" || (part.length <= 40 && /^[a-z]+(?:-[a-z]+)*$/.test(part)) ? part : ":id"))
    .join("/")
    .slice(0, 160);
const ip = (req) => req.clientIp || String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
const cookies = (req) =>
  Object.fromEntries(
    String(req.headers.cookie || "")
      .split(";")
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const i = x.indexOf("=");
        return [decodeURIComponent(x.slice(0, i)), decodeURIComponent(x.slice(i + 1))];
      }),
  );
const cookie = (name, value, maxAge, secure = true) =>
  `${name}=${encodeURIComponent(value)}; Path=${
    name === "admin_session" ? "/api/admin" : "/api/account"
  }; HttpOnly; SameSite=${name === "admin_session" ? "Strict" : "Lax"}; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
function json(res, status, data, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "strict-transport-security": "max-age=31536000; includeSubDomains; preload",
    "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "referrer-policy": "no-referrer",
    "permissions-policy":
      "camera=(), microphone=(), geolocation=(), payment=(), publickey-credentials-get=()",
    "x-frame-options": "DENY",
    ...headers,
  });
  res.end(JSON.stringify(data));
}
async function body(req, raw = false, limit = 1e6) {
  let x = "";
  for await (const p of req) {
    x += p;
    if (x.length > limit) throw Error("Request too large");
  }
  if (raw) return x;
  try {
    return JSON.parse(x || "{}");
  } catch {
    throw Error("Invalid JSON");
  }
}
// Records header and body writes made inside a transaction callback so they are
// sent only after commit, and can be discarded if the callback is retried.
function deferResponse(res) {
  const methods = ["setHeader", "writeHead", "end"],
    own = Object.fromEntries(methods.map((name) => [name, Object.getOwnPropertyDescriptor(res, name)])),
    original = Object.fromEntries(methods.map((name) => [name, res[name]]));
  let calls = [];
  for (const name of methods) {
    res[name] = (...args) => {
      calls.push([name, args]);
      return res;
    };
  }
  const restore = () => {
    for (const name of methods) {
      if (own[name]) Object.defineProperty(res, name, own[name]);
      else delete res[name];
    }
  };
  return {
    reset() {
      calls = [];
    },
    discard() {
      calls = [];
      restore();
    },
    flush() {
      restore();
      for (const [name, args] of calls) original[name].apply(res, args);
      calls = [];
    },
  };
}
const bearer = (req) => String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");

export { resolveClientIp, ip, cookies, cookie, json, body, bearer, deferResponse, routeLabel };
