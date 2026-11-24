#!/usr/bin/env node
// Design-fidelity gate for pull requests (AGENTS.md, ground rule 10).
//
// A PR that changes a screen (customer-app-v2/, admin-app-v2/, store-app/ or
// shared-app/ui/) must carry a "## Design fidelity" section in its description:
//
//   ## Design fidelity
//   Screens: PhoneDevices, PhoneReplaceDevice
//   - [x] Every state of each screen captured next to its design at the same width
//   - [x] Layout, copy, order, components and states match the design
//   Differences: none
//   <img …> / ![…](…)   one design-vs-build capture per screen at least
//
// "Differences:" is either "none" or lists each difference with a link to the
// owner's approval (an issue comment URL). A PR that only changes behaviour
// with nothing visible writes "Screens: none — <reason>".
//
// Usage in CI: node scripts/check-design-fidelity.mjs
//   reads the PR body from $GITHUB_EVENT_PATH and the changed files from
//   `git diff --name-only <base>...HEAD` (base from the event).
// Local: node scripts/check-design-fidelity.mjs --body pr.md --files a.js,b.css

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SCREEN_DIRS = ["customer-app-v2/", "admin-app-v2/", "store-app/", "shared-app/ui/"];
const IGNORE = [/\.test\.m?js$/, /(^|\/)README\.md$/];

export function touchesScreens(files) {
  return files.some((f) => SCREEN_DIRS.some((d) => f.startsWith(d)) && !IGNORE.some((r) => r.test(f)));
}

export function knownScreens(dir = path.join(ROOT, "docs/redesign/screens")) {
  if (!existsSync(dir)) return new Set();
  return new Set(readdirSync(dir).filter((f) => f.endsWith(".dc.html")).map((f) => f.slice(0, -8)));
}

function section(body) {
  const m = /^##\s+Design fidelity\s*$/im.exec(body || "");
  if (!m) return null;
  const rest = body.slice(m.index + m[0].length);
  const next = /^##\s+/m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

// Returns a list of problems; empty means the PR passes.
export function checkFidelity({ body, files, screens = knownScreens() }) {
  if (!touchesScreens(files)) return [];
  const s = section(body);
  if (s == null) return ['Missing "## Design fidelity" section (see AGENTS.md, rule 10, and the PR template).'];
  const problems = [];
  const line = /^\s*Screens:\s*(.+)$/im.exec(s);
  if (!line) return ['Design fidelity: add a "Screens:" line naming the design screens this PR builds, or "Screens: none — <reason>".'];
  const value = line[1].trim();
  if (/^none\b/i.test(value)) {
    if (!/^none\s*[—–-]\s*\S.{9,}/i.test(value)) problems.push('Design fidelity: "Screens: none" needs a reason, e.g. "Screens: none — server field only, nothing visible changes".');
    return problems;
  }
  const names = value.split(/[,\s]+/).map((n) => n.replace(/[`*]/g, "")).filter(Boolean);
  const unknown = screens.size ? names.filter((n) => !screens.has(n)) : [];
  if (unknown.length) problems.push(`Design fidelity: not design screens in docs/redesign/screens/: ${unknown.join(", ")}.`);
  const boxes = [...s.matchAll(/^\s*[-*]\s+\[( |x|X)\]/gm)];
  if (boxes.length < 2) problems.push("Design fidelity: keep both checklist items from the PR template.");
  if (boxes.some((b) => b[1] === " ")) problems.push("Design fidelity: every checklist item must be ticked. If something doesn't match, fix it or get the owner's approval first.");
  const images = (s.match(/!\[[^\]]*\]\([^)]+\)|<img\s[^>]*src=/gi) || []).length;
  if (images < names.length) problems.push(`Design fidelity: attach at least one design-vs-build capture per screen (${names.length} screens, ${images} images).`);
  const diff = /^\s*Differences:\s*(.*)$/im.exec(s);
  if (!diff) problems.push('Design fidelity: add a "Differences:" line ("none", or each difference with the owner\'s approval link).');
  else {
    const d = diff[1].trim();
    const listed = s.slice(diff.index + diff[0].length).split("\n").filter((l) => /^\s*[-*]\s+(?!\[)/.test(l));
    if (!/^none\.?$/i.test(d)) {
      const items = [d, ...listed].filter((x) => x && x.trim());
      const unapproved = items.filter((x) => !/https:\/\/github\.com\/[^\s)]+\/(issues|pull)\/\d+#issuecomment-\d+/.test(x));
      if (unapproved.length) problems.push("Design fidelity: each difference needs a link to the owner's approving comment (…#issuecomment-…): " + unapproved.map((x) => x.trim()).join(" | "));
    }
  }
  return problems;
}

function changedFiles(base) {
  try { execFileSync("git", ["fetch", "--no-tags", "--depth=200", "origin", base], { stdio: "ignore" }); } catch {}
  return execFileSync("git", ["diff", "--name-only", `origin/${base}...HEAD`], { encoding: "utf8" }).split("\n").filter(Boolean);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  let body, files;
  if (arg("--body")) {
    body = readFileSync(arg("--body"), "utf8");
    files = (arg("--files") || "").split(",").filter(Boolean);
  } else {
    const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
    if (!event.pull_request) { console.log("Not a pull request; nothing to check."); process.exit(0); }
    body = event.pull_request.body || "";
    files = changedFiles(event.pull_request.base.ref);
  }
  const problems = checkFidelity({ body, files });
  if (!touchesScreens(files)) console.log("No screen files changed; design fidelity not required.");
  else if (!problems.length) console.log("Design fidelity section is complete.");
  for (const p of problems) console.error(`::error::${p}`);
  process.exit(problems.length ? 1 : 0);
}
