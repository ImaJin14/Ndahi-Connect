import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

export function createStaticServer(
  kind = "customer",
  { apiUrl = process.env.API_URL || "http://localhost:8082" } = {},
) {
  const root = join(process.cwd(), kind === "admin" ? "admin-app" : "customer-app");
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === "/config.js") {
      res.writeHead(200, {
        "content-type": "text/javascript",
        "cache-control": "no-store",
      });
      return res.end(`window.NDAHI_CONFIG=${JSON.stringify({ apiUrl, app: kind })}`);
    }
    if (url.pathname === "/vendor/webauthn.js") {
      const data = await readFile(join(
        process.cwd(),
        "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js",
      ));
      res.writeHead(200, {
        "content-type": "text/javascript; charset=utf-8",
        "cache-control": "public, max-age=86400",
        "x-content-type-options": "nosniff",
      });
      return res.end(data);
    }
    let path = url.pathname;
    if (path === "/") path = "/index.html";
    if (path === "/login") path = "/login.html";
    if (path === "/admin" && kind === "customer") {
      res.writeHead(404);
      return res.end("Not found");
    }
    path = normalize(path).replace(/^(\.\.(\/|\\|$))+/, "");
    const file = join(root, path);
    if (!file.startsWith(root)) {
      res.writeHead(403);
      return res.end("Forbidden");
    }
    try {
      const data = await readFile(file),
        types = {
          ".html": "text/html; charset=utf-8",
          ".css": "text/css; charset=utf-8",
          ".js": "text/javascript; charset=utf-8",
        };
      res.writeHead(200, {
        "content-type": types[extname(file)] || "application/octet-stream",
        "x-content-type-options": "nosniff",
        "content-security-policy": `default-src 'self'; connect-src 'self' ${apiUrl}; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'`,
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  });
}

const main = process.argv[1] &&
  fileURLToPath(import.meta.url) === normalize(process.argv[1]);
if (main) {
  const kind = process.env.APP_KIND || "customer",
    port = Number(process.env.PORT ||
      (kind === "admin" ? process.env.ADMIN_PORT || 8081 : process.env.CUSTOMER_PORT || 8080));
  createStaticServer(kind).listen(
    port,
    process.env.HOST || "0.0.0.0",
    () => console.log(`NDAHI ${kind} app running on http://localhost:${port}`),
  );
}
