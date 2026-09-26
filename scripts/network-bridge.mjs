import https from "node:https";
import { readFile } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { pathToFileURL } from "node:url";
import { RouterHotspot } from "../lib/router-hotspot.mjs";

export function bridgeHandler({ router, username, password }) {
  if (!username || !password || password.length < 24) throw Error("Configure a bridge service username and password of at least 24 characters.");
  const expected = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  // Serial execution prevents concurrent upserts from creating duplicate users.
  let tail = Promise.resolve(), waiting = 0;
  return async (req, res) => {
    const reply = (status, value) => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(value)); };
    const actual = Buffer.from(String(req.headers.authorization || ""));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return reply(401, { error: "Unauthorized" });
    if (req.method !== "POST") return reply(405, { error: "POST required" });
    const action = req.url?.match(/^\/ndahi\/(syncVoucher|disconnectDevice|disconnectVoucher|readUsage|readState|markInactive)$/)?.[1];
    if (!action) return reply(404, { error: "Unknown bridge action" });
    if (waiting >= 25) return reply(429, { error: "Bridge busy; retry later" });
    let body = "";
    try {
      for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 16384) return reply(413, { error: "Request too large" }); }
      const input = JSON.parse(body || "{}");
      waiting++;
      const execute = () => action === "syncVoucher" ? router.syncPayload(input)
        : action === "disconnectDevice" ? router.disconnectDevice(input.deviceId)
        : action === "disconnectVoucher" ? router.disconnectVoucher(input.voucherId)
        : router[action]();
      const task = tail.then(execute); tail = task.catch(() => {});
      try { reply(200, await task); } finally { waiting--; }
    } catch { if (!res.headersSent) reply(502, { error: "Bridge operation failed. Check router connectivity and local service logs." }); }
  };
}
async function main() {
  const env = process.env, url = new URL(env.ROUTER_REST_URL || "");
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw Error("ROUTER_REST_URL must be an HTTPS origin.");
  if (!env.ROUTER_REST_USER || !env.ROUTER_REST_PASSWORD) throw Error("Router service credentials are required.");
  const router = new RouterHotspot({ url: url.origin, username: env.ROUTER_REST_USER, password: env.ROUTER_REST_PASSWORD });
  const server = https.createServer({ key: await readFile(env.BRIDGE_TLS_KEY), cert: await readFile(env.BRIDGE_TLS_CERT) }, bridgeHandler({ router, username: env.MIKROTIK_USER, password: env.MIKROTIK_PASSWORD }));
  server.requestTimeout = 20000; server.headersTimeout = 10000;
  server.listen(Number(env.BRIDGE_PORT || 8443), env.BRIDGE_HOST || "127.0.0.1", () => console.log("NDAHI management bridge listening on its configured private interface."));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error("Bridge startup failed. Check TLS files and required environment settings."); process.exitCode = 1; });
