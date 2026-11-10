// The local redesign preview (scripts/redesign-preview.mjs): its screen list
// points at real canvas files, and the canvas stand-in runtime parses.
import test from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCREENS, DEMO } from "../scripts/redesign-preview.mjs";

const root = new URL("..", import.meta.url).pathname;

test("every preview screen pairs real canvas artboards with a page of the app", async () => {
  const canvas = JSON.parse(await readFile(join(root, "docs/redesign/screens/canvas.json"), "utf8"));
  assert.ok(SCREENS.length >= 5);
  for (const screen of SCREENS) {
    for (const board of [screen.phone, screen.desktop].filter(Boolean)) {
      await access(join(root, "docs/redesign/screens", `${board}.dc.html`));
      assert.ok(canvas.boards[`${board}.dc.html`], `${board} is on the canvas`);
    }
    if (screen.app === "portal") {
      assert.match(screen.path, /^\/dashboard#(home|internet|shop|activity|account)$/);
      assert.equal(screen.path.slice("/dashboard#".length), screen.id, "captures wait for this tab");
    } else {
      assert.equal(screen.app, "admin");
      assert.match(screen.path, /^\/(dashboard#[a-z-]+|login|home-routers\.html)$/);
    }
  }
  // Every admin artboard except the shared side menu has a preview entry.
  const adminBoards = Object.keys(canvas.boards).filter((name) => name.startsWith("Admin") && name !== "AdminSide.dc.html");
  assert.deepEqual(SCREENS.filter((s) => s.app === "admin").map((s) => `${s.desktop}.dc.html`).sort(), adminBoards.sort());
  assert.match(DEMO.pin, /^\d{4}$/);
});

test("the canvas stand-in runtime is valid script and only renders, never posts", async () => {
  const source = await readFile(join(root, "scripts/redesign-preview-canvas.js"), "utf8");
  assert.doesNotThrow(() => new Function(source));
  assert.doesNotMatch(source, /method:\s*["']POST|XMLHttpRequest|sendBeacon/);
});
