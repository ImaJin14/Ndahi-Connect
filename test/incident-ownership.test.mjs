import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";

// DEP-006: every alert must reach a responder with a documented first action and
// escalation path, and runbook links must resolve.
const read = (path) => readFileSync(path, "utf8");
const groups = ["alerts.yml", "slo.yml"].flatMap((file) => parse(read(`monitoring/prometheus/${file}`)).groups);
const alerts = groups.flatMap((group) => group.rules.filter((rule) => rule.alert).map((rule) => ({ ...rule, group: group.name })));
const objectives = groups.flatMap((group) => group.rules).filter((rule) => rule.record === "ndahi:slo_objective:ratio");
const routing = parse(read("monitoring/alertmanager/alertmanager.yml"), { merge: true });
const incident = read("docs/operations/incident-response.md");
const roster = read("docs/operations/service-monitoring.md");
const firstActions = ["service-monitoring.md", "service-level-objectives.md", "performance.md"].map((f) => read(`docs/operations/${f}`)).join("\n");

const roles = new Set([
  ...alerts.map((rule) => rule.labels?.responder).filter(Boolean),
  ...objectives.map((rule) => rule.labels.responder),
]);

test("every alert has a severity and reaches a responder role", () => {
  assert.ok(alerts.length >= 30);
  for (const rule of alerts) {
    assert.ok(["warning", "critical"].includes(rule.labels?.severity), `${rule.alert} needs a warning or critical severity`);
    // Error-budget alerts take the responder recorded on their objective.
    const derived = /group_left \(responder\)|ndahi:slo_error_budget_remaining/.test(rule.expr);
    assert.ok(rule.labels.responder || derived, `${rule.alert} has no responder`);
  }
  for (const rule of objectives) assert.ok(rule.labels.responder, `objective ${rule.labels.slo} has no responder`);
});

test("every responder role is routed, staffed and has an escalation path", () => {
  const routed = new Set(routing.route.routes.flatMap((route) => route.matchers)
    .map((matcher) => matcher.match(/^responder="(.+)"$/)?.[1]).filter(Boolean));
  const receivers = new Set(routing.receivers.map((receiver) => receiver.name));
  for (const role of roles) {
    assert.ok(routed.has(role) && receivers.has(role), `${role} has no Alertmanager route and receiver`);
    assert.match(roster, new RegExp(`^\\| \`${role}\` \\|`, "m"), `${role} is missing from the responder roster`);
    assert.match(incident, new RegExp(`^\\| [^|]+ \\| \`${role}\` \\|`, "m"), `${role} has no escalation path`);
  }
  for (const type of ["Payment", "Security", "Database", "Network"]) {
    assert.match(incident, new RegExp(`^\\| ${type} \\| \`[a-z-]+\` \\|`, "m"), `${type} incidents have no escalation path`);
    assert.match(incident, new RegExp(`^## ${type} incidents$`, "m"), `${type} incidents have no playbook`);
  }
});

test("every alert has a documented first action", () => {
  for (const rule of alerts) {
    assert.ok(firstActions.includes(`\`${rule.alert}\``), `${rule.alert} is not described in the operations docs`);
  }
});

test("operations and security runbook links resolve, including section anchors", () => {
  const slug = (heading) => heading.trim().toLowerCase().replace(/[^\w\- ]/g, "").replace(/ /g, "-");
  const anchors = (file) => new Set(read(file).split("\n").filter((line) => /^#{1,6} /.test(line)).map((line) => slug(line.replace(/^#+ /, ""))));
  const files = ["docs/operations", "docs/security"].flatMap((dir) => readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => join(dir, f)));
  let checked = 0;
  for (const file of [...files, "docs/product-improvement-checklist.md"]) {
    const text = read(file).replace(/```[\s\S]*?```/g, "");
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?|mailto):/.test(target)) continue;
      const [path, anchor] = target.split("#"), resolved = path ? join(dirname(file), path) : file;
      assert.ok(existsSync(resolved), `${file} links to missing ${target}`);
      if (anchor && resolved.endsWith(".md")) assert.ok(anchors(resolved).has(anchor), `${file} links to missing section ${target}`);
      checked++;
    }
  }
  assert.ok(checked > 50);
});
