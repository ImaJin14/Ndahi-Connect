import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const appDirs = ["customer-app-v2", "customer-app", "admin-app-v2", "admin-app", "store-app", "shared-app"];
const htmlDirs = ["customer-app-v2", "customer-app", "admin-app-v2", "admin-app", "store-app"];
const staticRewrites = new Set(["/", "/login", "/dashboard", "/hotspot", "/pair", "/forgot-pin", "/help", "/config.js", "/version.json", "/healthz", "/favicon.ico"]);
const virtualAssets = new Set(["/vendor/webauthn.js", "/vendor/web-vitals.js"]);

function listFiles(dir, exts) {
  const out = [];
  const full = path.join(root, dir);
  if (!fs.existsSync(full)) return out;
  for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(rel, exts));
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(rel);
  }
  return out.sort();
}

// Known dynamic/prefix backend routes extracted from lib/api/*.mjs patterns.
const knownBackendMatchers = [
  /^\/api\/payments\/[^/]+\/(?:status|recover|confirm)$/,
  /^\/api\/account\/payments\/[^/]+\/(?:status|receipt|refund|receipt-email)$/,
  /^\/api\/account\/vouchers\/[^/]+\/(?:qr|download)$/,
  /^\/api\/account\/wifi-devices\/operations\/[^/]+$/,
  /^\/api\/account\/security\/actions\/[^/]+$/,
  /^\/api\/account\/security\/account-backup(?:\/(?:options|generate))?$/,
  /^\/api\/account\/push(?:\/[^/]+)?$/,
  /^\/api\/account\/qr-connect\/(?:begin|options|verify|rotate)$/,
  /^\/api\/account\/home(?:\/(?:register|enroll|confirm|mode|revoke|retry|options))?$/,
  /^\/api\/account\/device-management(?:\/(?:main|main\/options|disconnect|disconnect\/options|forget|forget\/options|current|current\/identify|current\/reset|nickname|connect|connect\/options|pairing|pairing\/request|pairing\/manual|pairing\/approve|pairing\/decline))?$/,
  /^\/api\/wifi\/pairing\/(?:config|request|status|cancel|redeem)$/,
  /^\/api\/account\/authentication-migration\/(?:options|confirm|pin\/start|pin\/confirm|pin\/cancel)$/,
  /^\/api\/admin\/authentication-migration\/(?:options|confirm|review)$/,
  /^\/api\/admin\/vouchers\/[^/]+\/details$/,
  // Store promotions (#302): lib/api/admin-store.mjs matches its actions after /api/admin/store/.
  /^\/api\/admin\/store\/promotions\/(?:save|end)$/,
  /^\/api\/admin\/network\/incidents\/[^/]+$/,
  // Bundle catalogue (#332, #338): lib/api/catalogue.mjs matches its actions after /api/admin/catalogue/.
  /^\/api\/admin\/catalogue\/(?:create|update|publish|unpublish|reorder|delete|mode)$/,
  /^\/api\/admin\/network\/setup\/(?:status|connection|discover|purchase-access|assisted-connections|preview|apply|confirm|rollback|refresh|recovery|resolve|activate|cancel)$/,
  // Order actions (ready, collect, cancel, contact, notes, rotate-link, refund,
  // refund-reference, verify) are an `action` sent to orders/update, not paths.
  /^\/api\/admin\/store(?:\/(?:receipt|photos|products\/save|products\/delete|categories\/save|categories\/delete|settings\/save|stock\/adjust|orders\/update))?$/,
  /^\/api\/admin\/resellers\/(?:ledger|commission|remittances|adjustments)$/,
  // Product photos by the SHA-256 of their bytes (lib/api/store.mjs).
  /^\/api\/store\/photos(?:\/[0-9a-f]{64})?\/?$/,
];

export async function checkApiSurface({ strict = false } = {}) {
  const apiFiles = listFiles("lib/api", [".mjs"]).filter((f) => f !== "lib/api/state.mjs");
  const backendLiterals = new Set();
  for (const file of apiFiles) {
    const src = fs.readFileSync(path.join(root, file), "utf8");
    for (const m of src.matchAll(/["'`](\/api\/[a-zA-Z0-9_\/:-]+)["'`]/g)) {
      backendLiterals.add(m[1].replace(/\/$/, ""));
    }
  }

  const stateMod = await import(pathToFileURL(path.join(root, "lib/api/state.mjs")).href);
  const csrfSet = new Set(Object.keys(stateMod.customerCsrfPaths || {}));
  const adminSrc = fs.readFileSync(path.join(root, "lib/api/admin.mjs"), "utf8");
  const selfServiceMatch = adminSrc.match(/const selfServicePaths\s*=\s*new Set\(\[([^\]]+)\]\)/);
  const selfServiceSet = new Set(
    selfServiceMatch ? [...selfServiceMatch[1].matchAll(/["']([^"']+)["']/g)].map((m) => m[1]) : [],
  );

  const frontendCalls = new Map();
  for (const dir of appDirs) {
    for (const file of listFiles(dir, [".js", ".html"])) {
      const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
      lines.forEach((line, idx) => {
        // Match full API paths including dynamic template interpolations normalized to :id
        for (const m of line.matchAll(/(?:["'`])(\/api\/[a-zA-Z0-9_\/${}.()-]+)(?:["'`?#])/g)) {
          let ep = m[1].replace(/\$\{[^}]+\}/g, ":id").replace(/\/+$/, "");
          if (!ep || ep === "/api") continue;
          // Handle string concatenations like "/api/account/vouchers/" + encodeURIComponent(id) + "/qr"
          if (line.includes(m[1] + '" +') && line.includes('"/qr"')) ep = "/api/account/vouchers/:id/qr";
          if (line.includes(m[1] + "' +") && line.includes("'/download'")) ep = "/api/account/vouchers/:id/download";
          if (line.includes("`/api/account/vouchers/${") && line.includes("/qr")) ep = "/api/account/vouchers/:id/qr";
          if (ep === "/api/account/vouchers" && (line.includes("'/download'") || line.includes('"/download"'))) ep = "/api/account/vouchers/:id/download";
          if (ep === "/api/account/vouchers" && (line.includes("'/qr'") || line.includes('"/qr"'))) ep = "/api/account/vouchers/:id/qr";
          if (line.includes("/api/admin/home/") && line.includes("hasAttribute")) continue;
          if (line.includes("/api/account/device-management/pairing/")) {
            for (const suffix of ["approve", "decline"]) {
              const full = `/api/account/device-management/pairing/${suffix}`;
              if (!frontendCalls.has(full)) frontendCalls.set(full, []);
              frontendCalls.get(full).push({ app: dir, file, line: idx + 1 });
            }
            continue;
          }
          if (line.includes("/api/wifi/pairing/") && line.includes("path")) continue;
          if (line.includes("/api/account/home/") && line.includes("${action}")) continue;
          if (line.includes("/api/admin/network/setup/") && line.includes("action")) continue;
          if (line.includes("/api/admin/store/") && line.includes("action")) continue;
          if (!frontendCalls.has(ep)) frontendCalls.set(ep, []);
          frontendCalls.get(ep).push({ app: dir, file, line: idx + 1 });
        }
      });
    }
  }

  const unmatchedApi = [];
  for (const [ep, refs] of [...frontendCalls.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const normalized = ep.replace(/\/:id/g, "/sample");
    const matched =
      backendLiterals.has(ep) ||
      knownBackendMatchers.some((re) => re.test(ep) || re.test(normalized));
    if (!matched) unmatchedApi.push({ ep, refs });
  }

  const brokenHtmlRefs = [];
  for (const app of htmlDirs) {
    for (const file of listFiles(app, [".html"])) {
      const src = fs.readFileSync(path.join(root, file), "utf8");
      for (const m of src.matchAll(/(?:src|href)="([^"]+)"/g)) {
        const ref = m[1];
        if (/^(?:https?:|data:|mailto:|tel:|#)/i.test(ref)) continue;
        const clean = ref.split("?")[0].split("#")[0];
        if (!clean || staticRewrites.has(clean) || virtualAssets.has(clean)) continue;
        const local = path.join(root, app, clean.replace(/^\//, ""));
        const shared = clean.startsWith("/shared/") ? path.join(root, "shared-app", clean.slice("/shared/".length)) : null;
        if (!fs.existsSync(local) && !(shared && fs.existsSync(shared))) {
          brokenHtmlRefs.push({ file, ref });
        }
      }
    }
  }

  const findings = [];
  // Check authenticated customer device-management mutations
  for (const ep of ["/api/account/device-management/current/reset", "/api/account/device-management/nickname"]) {
    if (!csrfSet.has(ep)) {
      findings.push(`CSRF gap: ${ep} uses dashboardSessions cookie auth but is missing from customerCsrfPaths (lib/api/state.mjs) and has no inline x-csrf-token check.`);
    }
  }
  // Check admin self-service password change vs admin-app-v2/profile.js
  for (const ep of ["/api/admin/profile/password", "/api/admin/profile/pin"]) {
    if (!selfServiceSet.has(ep)) {
      findings.push(`Role-gate mismatch: ${ep} is a self-service pin_change action (lib/admin-sensitive-actions.mjs) shown to all roles in admin-app-v2/profile.js, but missing from selfServicePaths in lib/api/admin.mjs (returns 403 for operator/reseller/auditor).`);
    }
  }

  return {
    summary: {
      htmlPages: Object.fromEntries(htmlDirs.map((d) => [d, listFiles(d, [".html"]).length])),
      frontendEndpoints: frontendCalls.size,
      backendLiterals: backendLiterals.size,
      customerCsrfPaths: csrfSet.size,
    },
    unmatchedApi,
    brokenHtmlRefs,
    findings,
    ok: unmatchedApi.length === 0 && brokenHtmlRefs.length === 0 && (!strict || findings.length === 0),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const strict = process.argv.includes("--strict");
  const result = await checkApiSurface({ strict });
  console.log("API Surface Summary:", JSON.stringify(result.summary));
  if (result.unmatchedApi.length) {
    console.error("Unmatched frontend API paths:");
    for (const item of result.unmatchedApi) console.error(`  - ${item.ep} (${item.refs.map((r) => `${r.file}:${r.line}`).join(", ")})`);
  }
  if (result.brokenHtmlRefs.length) {
    console.error("Broken HTML asset/page references:");
    for (const item of result.brokenHtmlRefs) console.error(`  - ${item.file} -> ${item.ref}`);
  }
  if (result.findings.length) {
    console.warn("Security / Contract Findings:");
    for (const f of result.findings) console.warn(`  ! ${f}`);
  }
  if (!result.ok) process.exitCode = 1;
}
