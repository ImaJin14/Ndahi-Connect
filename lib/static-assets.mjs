import { readFile, readdir } from "node:fs/promises";
import { join, extname, posix } from "node:path";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { brotliCompress, gzip } from "node:zlib";
const br = promisify(brotliCompress), gz = promisify(gzip);
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".webp": "image/webp", ".svg": "image/svg+xml", ".woff2": "font/woff2" };
const digest = (data) => createHash("sha256").update(data).digest("hex").slice(0, 20);

export async function createAssetCatalog(root, { telemetry = false } = {}) {
  const sources = new Map();
  async function collect(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const path = join(dir, entry.name), key = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await collect(path, key);
      else if (entry.isFile() && types[extname(entry.name)]) sources.set(key, await readFile(path));
    }
  }
  await collect(root);
  await collect(join(process.cwd(), "shared-app"), "/shared");
  sources.set("/vendor/webauthn.js", await readFile(join(process.cwd(), "node_modules/@simplewebauthn/browser/dist/bundle/index.umd.min.js")));
  sources.set("/vendor/web-vitals.js", await readFile(join(process.cwd(), "node_modules/web-vitals/dist/web-vitals.js")));
  const revision = digest(Buffer.concat([...sources].sort(([a], [b]) => a.localeCompare(b)).flatMap(([key, data]) => [Buffer.from(key), data])));
  const versions = new Map([...sources.keys()].filter((key) => extname(key) !== ".html").map((key) => [key, `/static${key.slice(0, -extname(key).length)}.${revision}${extname(key)}`]));
  const catalog = new Map();
  await Promise.all([...sources].map(async ([key, bytes]) => {
    const extension = extname(key);
    let data = bytes;
    if ([".html", ".css", ".js"].includes(extension)) {
      const resolve = (ref) => {
        if (/^(?:[a-z]+:|\/\/|#)/i.test(ref)) return ref;
        const [path, suffix = ""] = ref.split(/(?=[?#])/s, 2);
        const absolute = path.startsWith("/") ? path : posix.join(posix.dirname(key), path);
        return versions.has(absolute) ? versions.get(absolute) + suffix : ref;
      };
      let text = bytes.toString();
      if (extension === ".html") {
        if (telemetry) text = text.replace("</body>", '<script type="module" src="/shared/performance.js"></script></body>');
        text = text.replace(/\b(src|href)=(['"])([^'"]+)\2/g, (_, attr, quote, ref) => `${attr}=${quote}${resolve(ref)}${quote}`);
      }
      if (extension === ".css") text = text.replace(/url\(\s*(['"]?)([^)'"\s]+)\1\s*\)/g, (_, quote, ref) => `url(${quote}${resolve(ref)}${quote})`);
      if (extension === ".js") text = text.replace(/\b(from\s+|import\s*)(['"])([^'"]+)\2/g, (_, prefix, quote, ref) => `${prefix}${quote}${resolve(ref)}${quote}`);
      data = Buffer.from(text);
    }
    const entry = { data, type: types[extension], etag: `"${digest(data)}"` };
    if ([".html", ".css", ".js", ".svg"].includes(extension) && data.length > 512) {
      [entry.br, entry.gzip] = await Promise.all([br(data), gz(data)]);
    }
    catalog.set(key, { ...entry, immutable: false });
    if (versions.has(key)) catalog.set(versions.get(key), { ...entry, immutable: true });
  }));
  return { catalog, revision };
}

export function sendAsset(req, res, entry, securityHeaders) {
  const encodings = new Map(String(req.headers["accept-encoding"] || "").split(",").map((part) => {
    const [name, weight] = part.trim().split(/;\s*q=/);
    return [name, weight === undefined ? 1 : Number(weight)];
  }));
  const encoding = ["br", "gzip"].find((name) => entry[name] && (encodings.get(name) ?? encodings.get("*") ?? 0) > 0);
  const data = encoding ? entry[encoding] : entry.data;
  const headers = { ...securityHeaders, "content-type": entry.type, vary: "Accept-Encoding", etag: entry.etag,
    "cache-control": entry.immutable ? "public, max-age=31536000, immutable" : "no-cache",
    ...(encoding ? { "content-encoding": encoding } : {}),
  };
  if (String(req.headers["if-none-match"] || "").split(/,\s*/).some((tag) => tag.replace(/^W\//, "") === entry.etag || tag === "*")) {
    res.writeHead(304, headers); return res.end();
  }
  res.writeHead(200, { ...headers, "content-length": data.length });
  res.end(req.method === "HEAD" ? undefined : data);
}
