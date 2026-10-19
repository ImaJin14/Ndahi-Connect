import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const portal = new URL(process.argv[2] || ""), output = process.argv[3];
if (portal.protocol !== "https:" || portal.pathname !== "/" || portal.username || portal.password || portal.search || portal.hash || !output) {
  throw new Error("Usage: node scripts/prepare-hotspot-pages.mjs https://portal.example.com /path/to/output");
}
const login = `${portal.origin}/onboarding.html?mac=$(mac)&address=$(ip)`, retry = `${portal.origin}/hotspot?router-error=1&mac=$(mac)&address=$(ip)`,
  escape = (value) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
  page = (target) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta http-equiv="refresh" content="0;url=${escape(target)}"><title>NDAHI Connect</title></head><body><p><a href="${escape(target)}">Open NDAHI Connect</a></p></body></html>
`;
await mkdir(output, { recursive: true });
await writeFile(resolve(output, "login.html"), `$(if error)\n${page(retry)}$(else)\n${page(login)}$(endif)\n`);
await writeFile(resolve(output, "flogin.html"), page(retry));
await writeFile(resolve(output, "rlogin.html"), page(login));
console.log(`Prepared login.html, flogin.html and rlogin.html in ${resolve(output)}. Back up the router's existing files before installing these after the portal/API deployment.`);
