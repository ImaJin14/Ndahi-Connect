#!/usr/bin/env node
// Syntax check for `npm run check` (#428): runs `node --check` on every .js
// and .mjs file in the source folders, found automatically, so a new file
// needs no edit to package.json. It replaces the hand-kept list.
//
// Skipped: node_modules, folders starting with "." (.git, .claude, worktrees)
// and generated output (coverage, dist, build). The repository has no
// vendored scripts; the two the apps serve are read from node_modules.
//
//   node scripts/check-syntax.mjs              # the repository
//   node scripts/check-syntax.mjs --root DIR   # another tree (tests)
import { readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { availableParallelism } from "node:os";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_FOLDERS = ["lib", "scripts", "shared-app", "customer-app", "customer-app-v2", "admin-app", "admin-app-v2", "store-app", "public", "test", "backups"];
const SKIP = new Set(["node_modules", "coverage", "dist", "build"]);
const SCRIPT = /\.(?:js|mjs)$/;

// Every script under the source folders, plus the ones at the root
// (server.mjs, static-server.mjs), as paths relative to `root`, sorted.
export function sourceFiles(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP.has(entry.name)) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && SCRIPT.test(entry.name)) found.push(relative(root, path));
    }
  };
  for (const entry of readdirSync(root, { withFileTypes: true })) if (entry.isFile() && SCRIPT.test(entry.name)) found.push(entry.name);
  for (const folder of SOURCE_FOLDERS) walk(join(root, folder));
  return found.sort();
}

function check(root, file) {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--check", file], { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("close", (code) => done({ file, ok: code === 0, errors }));
  });
}

export async function checkSyntax(root) {
  const files = sourceFiles(root), failures = [];
  let next = 0;
  const worker = async () => {
    while (next < files.length) {
      const result = await check(root, files[next++]);
      if (!result.ok) failures.push(result);
    }
  };
  await Promise.all(Array.from({ length: Math.min(files.length, Math.max(2, availableParallelism())) }, worker));
  return { files, failures: failures.sort((a, b) => a.file.localeCompare(b.file)) };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--root");
  const root = resolve(at > 0 ? process.argv[at + 1] : join(dirname(fileURLToPath(import.meta.url)), ".."));
  const { files, failures } = await checkSyntax(root);
  for (const failure of failures) process.stderr.write(`\n${failure.file}\n${failure.errors.trim()}\n`);
  if (failures.length) {
    process.stderr.write(`\nSyntax check failed: ${failures.length} of ${files.length} files.\n`);
    process.exit(1);
  }
  console.log(`Syntax check: ${files.length} files.`);
}
