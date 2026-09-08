import assert from "node:assert/strict";
import test from "node:test";

import { escapeHtml } from "../shared-app/safe-html.js";

test("escapeHtml renders stored markup as text", () => {
  const payload = `<img src=x onerror="alert('x')">&`;
  const rendered = `<td>${escapeHtml(payload)}</td>`;

  assert.equal(
    rendered,
    "<td>&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;&amp;</td>",
  );
  assert.equal(rendered.includes("<img"), false);
});

test("escapeHtml safely handles empty and attribute-breaking values", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(`\"><script>alert(1)</script>`), "&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
});
