#!/usr/bin/env node
// Merge batches: every issue is done in batches of 5 (docs/redesign/merge-batches.json).
// The owner merges a batch only when all of its PRs are correct, then work moves on.
//
// For each batch item this finds its PR (the item itself if it is a PR, otherwise the PR
// whose description says "Closes #<issue>") and checks it is correct:
//   - open, marked ready for review (not draft), no merge conflicts;
//   - every check run on its latest commit finished green (the design-fidelity check included);
//   - no reviewer's latest review asks for changes.
// It prints a report and can rewrite the tracking issue with it.
//
//   node scripts/batch-status.mjs                 # report to stdout
//   node scripts/batch-status.mjs --update-issue  # also rewrite the tracking issue
//   node scripts/batch-status.mjs --strict        # exit 1 if a PR is open too early
//
// Auth: GITHUB_TOKEN inside GitHub Actions; elsewhere the `gh` CLI (and its login).

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PLAN_FILE = path.join(ROOT, "docs/redesign/merge-batches.json");
const SELF_CHECK = /^merge batches/i; // this workflow's own job; never counted

// ---------- pure logic (unit-tested) ----------

export function linkedIssues(body) {
  return [...String(body || "").matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi)].map((m) => Number(m[1]));
}

// Latest run per check name; green when every one completed successfully.
export function checksState(runs) {
  const latest = new Map();
  for (const r of runs || []) {
    if (SELF_CHECK.test(r.name)) continue;
    const prev = latest.get(r.name);
    if (!prev || Date.parse(r.started_at || 0) >= Date.parse(prev.started_at || 0)) latest.set(r.name, r);
  }
  const all = [...latest.values()];
  if (!all.length) return { state: "pending", failing: [] };
  const failing = all.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(r.conclusion)).map((r) => r.name);
  if (failing.length) return { state: "failing", failing };
  if (all.some((r) => r.status !== "completed")) return { state: "pending", failing: [] };
  return { state: "green", failing: [] };
}

export function changesRequested(reviews) {
  const last = new Map();
  for (const r of reviews || []) if (["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state)) last.set(r.user?.login, r.state);
  return [...last.values()].includes("CHANGES_REQUESTED");
}

// item: { pr, merged, draft, open, mergeable, checks, changes }
export function itemStatus(x) {
  if (!x.pr) return { status: "todo", why: "no PR yet" };
  if (x.merged) return { status: "merged", why: "" };
  if (!x.open) return { status: "closed", why: "PR closed without merging" };
  const why = [];
  if (x.draft) why.push("still a draft");
  if (x.mergeable === false) why.push("merge conflicts");
  if (x.checks.state === "failing") why.push("failing: " + x.checks.failing.join(", "));
  if (x.checks.state === "pending") why.push("checks running");
  if (x.changes) why.push("changes requested");
  return why.length ? { status: "working", why: why.join("; ") } : { status: "ready", why: "" };
}

export function batchVerdict(batch, statuses, today = new Date()) {
  const n = statuses.length;
  const merged = statuses.filter((s) => s.status === "merged").length;
  const ready = statuses.filter((s) => s.status === "ready").length;
  if (merged === n) return { state: "merged", text: "Merged" };
  if (merged + ready === n) {
    if (batch.notBefore && today < new Date(batch.notBefore + "T00:00:00+01:00")) return { state: "waiting", text: `All ${n} correct — merge from ${batch.notBefore}` };
    return { state: "ready", text: `All ${n} correct — ready to merge, in the order listed` };
  }
  return { state: "open", text: `${merged + ready} of ${n} correct` };
}

// The current batch is the first one not fully merged; work may run one batch ahead.
export function summarise(plan, verdicts, openItemBatches) {
  const current = verdicts.findIndex((v) => v.state !== "merged");
  const done = current === -1;
  const limit = done ? Infinity : current + (plan.maxOpenBatches ?? 2) - 1;
  const early = openItemBatches.filter((b) => b.batch > limit);
  return { current: done ? null : current, next: done ? null : current + 1, limit, early, done };
}

// ---------- GitHub access ----------

function repoSlug() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY;
  const url = execFileSync("git", ["remote", "get-url", "origin"], { cwd: ROOT, encoding: "utf8" }).trim();
  return url.replace(/^.*github\.com[:/]/, "").replace(/\.git$/, "");
}

async function api(route, { method = "GET", body } = {}) {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  if (token && process.env.GITHUB_ACTIONS) {
    const res = await fetch(`https://api.github.com/${route}`, {
      method, body: body && JSON.stringify(body),
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json", "content-type": "application/json", "x-github-api-version": "2022-11-28" }
    });
    if (!res.ok) throw new Error(`${method} ${route}: ${res.status} ${await res.text()}`);
    return res.json();
  }
  const args = ["api", "-X", method, route];
  const input = body ? JSON.stringify(body) : undefined;
  if (input) args.push("--input", "-");
  return JSON.parse(execFileSync("gh", args, { input, encoding: "utf8", maxBuffer: 64 << 20 }));
}

async function allPulls(repo) {
  const out = [];
  for (let page = 1; page <= 20; page++) {
    const batch = await api(`repos/${repo}/pulls?state=all&per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

// ---------- report ----------

const ICON = { merged: "✅ merged", ready: "🟢 correct", working: "🟡 in progress", todo: "⚪ not started", closed: "🔴 closed" };

export async function collect(plan, repo) {
  const pulls = await allPulls(repo);
  const byNumber = new Map(pulls.map((p) => [p.number, p]));
  const byIssue = new Map();
  for (const p of pulls.slice().sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    if (p.state === "closed" && !p.merged_at) continue; // abandoned attempts don't count
    for (const n of linkedIssues(p.body)) byIssue.set(n, p);
  }
  const rows = [];
  for (const b of plan.batches) {
    for (const it of b.items) {
      const p = byNumber.get(it.issue) || byIssue.get(it.issue);
      let x = { pr: null };
      if (p) {
        const full = await api(`repos/${repo}/pulls/${p.number}`);
        const open = full.state === "open";
        const runs = open ? (await api(`repos/${repo}/commits/${full.head.sha}/check-runs?per_page=100`)).check_runs : [];
        const reviews = open ? await api(`repos/${repo}/pulls/${p.number}/reviews?per_page=100`) : [];
        x = { pr: p.number, merged: !!full.merged_at, open, draft: full.draft, mergeable: full.mergeable, checks: checksState(runs), changes: changesRequested(reviews) };
      }
      rows.push({ batch: b.batch, issue: it.issue, title: it.title, base: it.base, ...x, ...itemStatus(x) });
    }
  }
  return rows;
}

export function render(plan, rows, today = new Date()) {
  const verdicts = plan.batches.map((b) => batchVerdict(b, rows.filter((r) => r.batch === b.batch), today));
  const openBatches = rows.filter((r) => r.pr && r.status !== "merged" && r.status !== "closed");
  const s = summarise(plan, verdicts, openBatches);
  const lines = [];
  lines.push("<!-- Rewritten by the Merge batches workflow (scripts/batch-status.mjs). Edits here are overwritten; change docs/redesign/merge-batches.json instead. -->");
  lines.push("# Merge batches");
  lines.push("");
  lines.push(`Every issue is done in batches of ${plan.size}. A batch is merged only when all of its PRs are correct: ready for review, all checks green (including Design fidelity), no changes requested, no conflicts. Work runs at most one batch ahead of the batch being reviewed. Rules: AGENTS.md → "Merge batches".`);
  lines.push("");
  if (s.done) lines.push("**All batches are merged.**");
  else {
    lines.push(`**Now:** batch ${s.current} — ${verdicts[s.current].text}.`);
    lines.push(`**Next:** ${s.next < plan.batches.length ? `batch ${s.next} may be worked on now; batch ${s.next + 1} starts once batch ${s.current} is merged.` : "this is the last batch."}`);
    if (s.early.length) lines.push(`**⚠ Too early:** ${s.early.map((r) => `#${r.pr} (batch ${r.batch})`).join(", ")} — pause these until their batch comes up.`);
  }
  lines.push("");
  for (const b of plan.batches) {
    const v = verdicts[b.batch];
    const mark = v.state === "merged" ? "✅" : v.state === "ready" ? "🟢" : v.state === "waiting" ? "⏳" : b.batch === s.current ? "👉" : "▫️";
    lines.push(`## ${mark} Batch ${b.batch} — ${b.name}`);
    lines.push(`${v.text}${b.notBefore ? ` · not before ${b.notBefore}` : ""}`);
    lines.push("");
    lines.push("| Issue | PR | Status | Notes |");
    lines.push("| --- | --- | --- | --- |");
    for (const r of rows.filter((x) => x.batch === b.batch)) {
      lines.push(`| #${r.issue} ${r.title.replace(/\|/g, "\\|")} | ${r.pr ? "#" + r.pr : "—"} | ${ICON[r.status]} | ${[r.why, r.base ? `builds on ${r.base}` : ""].filter(Boolean).join("; ")} |`);
    }
    lines.push("");
  }
  return { markdown: lines.join("\n"), summary: s, verdicts };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8"));
  const repo = repoSlug();
  const rows = await collect(plan, repo);
  const { markdown, summary } = render(plan, rows);
  console.log(markdown);
  if (process.argv.includes("--update-issue")) {
    if (!plan.trackingIssue) throw new Error("trackingIssue is not set in merge-batches.json");
    await api(`repos/${repo}/issues/${plan.trackingIssue}`, { method: "PATCH", body: { body: markdown } });
    console.error(`Updated #${plan.trackingIssue}.`);
  }
  if (process.argv.includes("--strict") && summary.early.length) process.exit(1);
}
