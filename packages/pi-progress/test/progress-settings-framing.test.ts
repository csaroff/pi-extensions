import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { createTuiHarness } from "@narumitw/pi-tui-kit/testing";
import { test, vi } from "vitest";
import { showProgressSettings } from "../src/progress-settings-ui.js";
import { DEFAULT_PROGRESS_SETTINGS } from "../src/settings.js";
import { createContext } from "./progress-harness.js";

initTheme("dark");

function openSettings(current: ReturnType<typeof createContext>, controller = new AbortController()) {
  return showProgressSettings(current.ctx as ExtensionCommandContext, {
    signal: controller.signal,
    isCurrent: () => true,
    get: () => ({ ...DEFAULT_PROGRESS_SETTINGS }),
    save: async (patch) => ({ ...DEFAULT_PROGRESS_SETTINGS, ...patch }),
    apply: () => {},
  });
}

test("Settings has full-width callback-themed top and bottom rules and rebuilds them after invalidation", async () => {
  const current = createContext();
  let color = 31;
  const themeCalls: { role: string; text: string }[] = [];
  const tui = createTuiHarness({
    width: 80,
    rows: 24,
    theme: {
      fg(role, text) {
        themeCalls.push({ role, text });
        return `\u001b[${color}m${text}\u001b[0m`;
      },
      bold: (text) => text,
    },
  });
  Object.assign(current.ctx.ui, { custom: tui.custom });
  const running = openSettings(current);
  await tui.waitForOpen();
  const first = tui.render();
  assert.equal(stripVTControlCharacters(first[0] ?? ""), "─".repeat(80));
  assert.equal(stripVTControlCharacters(first.at(-1) ?? ""), "─".repeat(80));
  assert.ok(themeCalls.some(({ role, text }) => role === "border" && text === "─".repeat(80)));
  color = 32;
  tui.invalidate();
  const changed = tui.render();
  assert.notEqual(changed[0], first[0]);
  assert.equal(stripVTControlCharacters(changed[0] ?? ""), "─".repeat(80));
  tui.resize({ width: 20 });
  const narrow = tui.render();
  assert.equal(stripVTControlCharacters(narrow[0] ?? ""), "─".repeat(20));
  assert.equal(stripVTControlCharacters(narrow.at(-1) ?? ""), "─".repeat(20));
  for (const line of narrow) assert.ok(visibleWidth(line) <= 20);
  tui.press("ctrl+c");
  await running;
  tui.dispose();
});

test("height-bounded Settings retains the focused row and omits rules only below five screen rows", async () => {
  const current = createContext();
  const tui = createTuiHarness({ width: 80, rows: 24 });
  Object.assign(current.ctx.ui, { custom: tui.custom });
  const running = openSettings(current);
  await tui.waitForOpen();
  for (let index = 0; index < 4; index++) tui.press("tui.select.down");
  for (const rows of [4, 7, 8, 12, 24]) {
    tui.resize({ rows });
    const lines = tui.render().map(stripVTControlCharacters);
    const budget = Math.max(1, rows - 3);
    assert.ok(lines.length <= budget);
    assert.ok(lines.some((line) => /^→ Show completion count/u.test(line)));
    if (budget >= 5) {
      assert.equal(lines[0], "─".repeat(80));
      assert.equal(lines.at(-1), "─".repeat(80));
    } else assert.ok(lines.every((line) => line !== "─".repeat(80)));
  }
  tui.press("ctrl+c");
  await running;
  tui.dispose();
});

test("the item-limit input uses the same frame and retains its draft at low heights", async () => {
  const current = createContext();
  const tui = createTuiHarness({ width: 80, rows: 24 });
  Object.assign(current.ctx.ui, { custom: tui.custom });
  const running = openSettings(current);
  await tui.waitForOpen();
  for (let index = 0; index < 3; index++) tui.press("tui.select.down");
  tui.press("tui.select.confirm");
  tui.type("50");
  const normal = tui.render().map(stripVTControlCharacters);
  assert.equal(normal[0], "─".repeat(80));
  assert.equal(normal.at(-1), "─".repeat(80));
  assert.ok(normal.some((line) => line.startsWith("> 50")));
  for (const rows of [4, 7, 8]) {
    tui.resize({ rows, width: 20 });
    const lines = tui.render().map(stripVTControlCharacters);
    assert.ok(lines.length <= Math.max(1, rows - 3));
    assert.ok(lines.some((line) => line.startsWith("> 50")));
    for (const line of lines) assert.ok(visibleWidth(line) <= 20);
  }
  tui.press("ctrl+c");
  await running;
  tui.dispose();
});

test("owner cancellation before lazy frame loading never creates a settings component", async () => {
  const current = createContext();
  const custom = vi.fn();
  Object.assign(current.ctx.ui, { custom });
  const controller = new AbortController();
  const running = openSettings(current, controller);
  controller.abort();
  assert.equal(await running, "stale");
  assert.equal(custom.mock.calls.length, 0);
});
