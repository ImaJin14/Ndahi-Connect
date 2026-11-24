import test from "node:test";
import assert from "node:assert/strict";
import { checkFidelity, touchesScreens } from "../scripts/check-design-fidelity.mjs";

const screens = new Set(["PhoneDevices", "PhoneReplaceDevice"]);
const files = ["customer-app-v2/portal-devices.js"];
const good = `Intro

## Design fidelity
Screens: PhoneDevices, PhoneReplaceDevice
- [x] Every state of each screen captured next to its design at the same width
- [x] Layout, copy, order, components and states match the design
Differences: none

![PhoneDevices](https://example.test/a.png)
![PhoneReplaceDevice](https://example.test/b.png)

## Journeys
`;

test("only screen folders need the section", () => {
  assert.equal(touchesScreens(["lib/api/vouchers.mjs", "docs/x.md"]), false);
  assert.equal(touchesScreens(["admin-app-v2/test.test.mjs"]), false);
  assert.equal(touchesScreens(["shared-app/ui/button.css"]), true);
  assert.deepEqual(checkFidelity({ body: "", files: ["lib/x.mjs"], screens }), []);
});

test("a complete section passes", () => {
  assert.deepEqual(checkFidelity({ body: good, files, screens }), []);
});

test("missing section fails", () => {
  assert.match(checkFidelity({ body: "no section", files, screens })[0], /Missing/);
});

test("unticked box, unknown screen and too few images fail", () => {
  const body = good.replace("- [x] Layout", "- [ ] Layout").replace("PhoneReplaceDevice\n", "PhoneNope\n").replace(/!\[PhoneReplaceDevice\].*\n/, "");
  const p = checkFidelity({ body, files, screens }).join("\n");
  assert.match(p, /ticked/);
  assert.match(p, /PhoneNope/);
  assert.match(p, /capture per screen/);
});

test("differences need an owner approval link", () => {
  const bad = good.replace("Differences: none", "Differences:\n- Button moved under the card");
  assert.match(checkFidelity({ body: bad, files, screens }).join(), /approving comment/);
  const ok = good.replace("Differences: none", "Differences:\n- Button moved under the card — approved https://github.com/ImaJin14/ndahi-connect/issues/349#issuecomment-123");
  assert.deepEqual(checkFidelity({ body: ok, files, screens }), []);
});

test("Screens: none needs a reason", () => {
  const body = "## Design fidelity\nScreens: none\n";
  assert.match(checkFidelity({ body, files, screens })[0], /reason/);
  assert.deepEqual(checkFidelity({ body: "## Design fidelity\nScreens: none — refactor only, nothing visible changes\n", files, screens }), []);
});
