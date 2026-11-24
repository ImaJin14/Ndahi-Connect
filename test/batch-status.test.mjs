import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { linkedIssues, checksState, changesRequested, itemStatus, batchVerdict, summarise, render, PLAN_FILE } from "../scripts/batch-status.mjs";

const plan = JSON.parse(readFileSync(PLAN_FILE, "utf8"));

test("the plan: batches of 5 at most, every issue once, numbered in order", () => {
  const seen = new Set();
  plan.batches.forEach((b, i) => {
    assert.equal(b.batch, i);
    assert.ok(b.items.length >= 1 && b.items.length <= plan.size, `batch ${i} size`);
    for (const it of b.items) { assert.ok(!seen.has(it.issue), `#${it.issue} twice`); seen.add(it.issue); }
  });
  // a PR may only build on an earlier item of the same batch
  for (const b of plan.batches) b.items.forEach((it, k) => {
    if (!it.base) return;
    const n = Number(it.base.slice(1));
    assert.ok(b.items.slice(0, k).some((x) => x.issue === n), `#${it.issue} builds on ${it.base} outside its batch or later`);
  });
});

test("every design screen is in the plan", () => {
  const screens = readdirSync(new URL("../docs/redesign/screens/", import.meta.url)).filter((f) => f.endsWith(".dc.html") && !f.startsWith("Brochure")).map((f) => f.slice(0, -8)); // brochure boards are documents (#434), not screens
  const titles = plan.batches.flatMap((b) => b.items.map((it) => it.title)).join("\n");
  const missing = screens.filter((s) => !new RegExp(`: ${s} —`).test(titles));
  assert.deepEqual(missing, []);
});

test("linked issues", () => {
  assert.deepEqual(linkedIssues("Closes #338. Also fixes #12 and resolves #9; see #4"), [338, 12, 9]);
});

test("checks: latest run per name, own job ignored", () => {
  const t = (name, status, conclusion, started_at) => ({ name, status, conclusion, started_at });
  assert.equal(checksState([]).state, "pending");
  assert.equal(checksState([t("ci", "completed", "failure", "2026-01-01"), t("ci", "completed", "success", "2026-01-02")]).state, "green");
  assert.equal(checksState([t("ci", "completed", "success", "1"), t("Merge batches", "in_progress", null, "2")]).state, "green");
  assert.deepEqual(checksState([t("Screen matches the design", "completed", "failure", "1")]).failing, ["Screen matches the design"]);
  assert.equal(checksState([t("ci", "in_progress", null, "1")]).state, "pending");
});

test("reviews: a later approval clears a change request", () => {
  const r = (login, state) => ({ user: { login }, state });
  assert.equal(changesRequested([r("a", "CHANGES_REQUESTED")]), true);
  assert.equal(changesRequested([r("a", "CHANGES_REQUESTED"), r("a", "COMMENTED"), r("a", "APPROVED")]), false);
});

test("item status", () => {
  const ok = { pr: 1, open: true, merged: false, draft: false, mergeable: true, checks: { state: "green", failing: [] }, changes: false };
  assert.equal(itemStatus({ pr: null }).status, "todo");
  assert.equal(itemStatus(ok).status, "ready");
  assert.equal(itemStatus({ ...ok, draft: true }).status, "working");
  assert.equal(itemStatus({ ...ok, mergeable: false }).why, "merge conflicts");
  assert.equal(itemStatus({ ...ok, merged: true, open: false }).status, "merged");
});

test("batch verdicts, the not-before date, and working too far ahead", () => {
  const st = (s) => ({ status: s });
  assert.equal(batchVerdict({}, [st("merged"), st("ready")]).state, "ready");
  assert.equal(batchVerdict({}, [st("merged"), st("working")]).text, "1 of 2 correct");
  assert.equal(batchVerdict({ notBefore: "2026-12-01" }, [st("ready")], new Date("2026-11-28")).state, "waiting");
  assert.equal(batchVerdict({ notBefore: "2026-12-01" }, [st("ready")], new Date("2026-12-02")).state, "ready");
  const v = [{ state: "merged" }, { state: "open" }, { state: "open" }, { state: "open" }];
  const s = summarise({ maxOpenBatches: 2 }, v, [{ batch: 2, pr: 7 }, { batch: 3, pr: 9 }]);
  assert.equal(s.current, 1);
  assert.deepEqual(s.early.map((x) => x.pr), [9]);
});

test("render names the current batch", () => {
  const rows = plan.batches.flatMap((b) => b.items.map((it) => ({ batch: b.batch, issue: it.issue, title: it.title, status: b.batch === 0 ? "merged" : "todo", why: "" })));
  const { markdown, summary } = render(plan, rows, new Date("2026-11-24"));
  assert.equal(summary.current, 1);
  assert.match(markdown, /\*\*Now:\*\* batch 1/);
});
