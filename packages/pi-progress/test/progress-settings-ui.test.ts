import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ExtensionCommandContext, initTheme } from "@earendil-works/pi-coding-agent";
import {
  getKeybindings,
  KeybindingsManager,
  setKeybindings,
  TUI_KEYBINDINGS,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { createCustomSelectorHarness } from "../../../test/support.js";
import { showProgressSettings } from "../src/progress-settings-ui.js";
import { DEFAULT_PROGRESS_SETTINGS, type ProgressSettings } from "../src/settings.js";
import { createContext, createHarness, setProgress } from "./progress-harness.js";

initTheme("dark");

test("changes all five settings in one screen with bounded rendering", async () => {
  const current = createContext();
  let settings = { ...DEFAULT_PROGRESS_SETTINGS };
  const patches: Partial<ProgressSettings>[] = [];
  let screen!: ReturnType<typeof createCustomSelectorHarness>;
  Object.assign(current.ctx.ui, {
    custom: async (factory: unknown) => {
      screen = createCustomSelectorHarness(factory);
      return screen.resultPromise;
    },
  });
  const controller = new AbortController();
  const command = showProgressSettings(current.ctx as ExtensionCommandContext, {
    signal: controller.signal,
    isCurrent: () => true,
    get: () => settings,
    save: async (patch) => {
      patches.push(patch);
      return { ...settings, ...patch };
    },
    apply: (next) => {
      settings = next;
    },
  });
  await vi.waitFor(() => assert.ok(screen));
  const initial = screen.render().join("\n");
  for (const width of [0, 1, 20, 80]) {
    for (const line of screen.render(width)) assert.ok(visibleWidth(line) <= width);
  }
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(settings.enabled, false));
  screen.handleInput("tui.select.down");
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(settings.displayMode, "expanded"));
  screen.handleInput("tui.select.down");
  screen.handleInput(" ");
  await vi.waitFor(() => assert.equal(settings.showCompleted, false));
  screen.handleInput("tui.select.down");
  screen.handleInput("\r");
  screen.handleInput("1");
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(settings.maxVisibleItems, 1));
  screen.handleInput("tui.select.down");
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(settings.showProgress, false));
  screen.handleInput("\u0003");
  await command;
  screen.dispose();
  assert.match(initial, /Show widget/u);
  assert.match(initial, /Visible item limit/u);
  assert.deepEqual(patches, [
    { enabled: false },
    { displayMode: "expanded" },
    { showCompleted: false },
    { maxVisibleItems: 1 },
    { showProgress: false },
  ]);
});

test("save failure restores the value and later saves still work", async () => {
  const current = createContext();
  let screen!: ReturnType<typeof createCustomSelectorHarness>;
  Object.assign(current.ctx.ui, {
    custom: async (factory: unknown) => {
      screen = createCustomSelectorHarness(factory);
      return screen.resultPromise;
    },
  });
  let settings = { ...DEFAULT_PROGRESS_SETTINGS };
  let failures = 1;
  const command = showProgressSettings(current.ctx as ExtensionCommandContext, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    get: () => settings,
    save: async (patch) => {
      if (failures-- > 0) throw new Error("invalid settings");
      return { ...settings, ...patch };
    },
    apply: (next) => {
      settings = next;
    },
  });
  await vi.waitFor(() => assert.ok(screen));
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(current.notifications.length, 1));
  assert.equal(settings.enabled, true);
  assert.match(stripVTControlCharacters(screen.render().join("\n")), /Show widget\s+true/u);
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(settings.enabled, false));
  screen.handleInput("\u0003");
  await command;
  screen.dispose();
  assert.match(current.notifications[0]?.message ?? "", /invalid settings/u);
});

for (const cancellation of ["close", "dispose", "parent"] as const) {
  test(`${cancellation} cancels uncommitted work and prevents late application`, async () => {
    const current = createContext();
    let screen!: ReturnType<typeof createCustomSelectorHarness>;
    Object.assign(current.ctx.ui, {
      custom: async (factory: unknown) => {
        screen = createCustomSelectorHarness(factory);
        return screen.resultPromise;
      },
    });
    const controller = new AbortController();
    let saveSignal: AbortSignal | undefined;
    let reject!: (reason: unknown) => void;
    const apply = vi.fn();
    const command = showProgressSettings(current.ctx as ExtensionCommandContext, {
      signal: controller.signal,
      isCurrent: () => !controller.signal.aborted,
      get: () => ({ ...DEFAULT_PROGRESS_SETTINGS }),
      save: async (_patch, signal) => {
        saveSignal = signal;
        return new Promise((_resolve, fail) => {
          reject = fail;
        });
      },
      apply,
    });
    await vi.waitFor(() => assert.ok(screen));
    screen.handleInput("\r");
    await vi.waitFor(() => assert.ok(saveSignal));
    if (cancellation === "close") screen.handleInput("\u0003");
    else if (cancellation === "dispose") screen.dispose();
    else controller.abort();
    assert.equal(saveSignal?.aborted, true);
    reject(saveSignal?.reason);
    await command;
    assert.equal(apply.mock.calls.length, 0);
    assert.deepEqual(current.notifications, []);
    screen.dispose();
  });
}

test("native non-default navigation and cancellation work; Ctrl+C remains a hard cancel", async () => {
  const original = getKeybindings();
  setKeybindings(
    new KeybindingsManager(TUI_KEYBINDINGS, { "tui.select.down": "ctrl+n", "tui.select.cancel": "ctrl+x" }),
  );
  try {
    for (const cancel of ["\u0018", "\u0003"]) {
      const current = createContext();
      let screen!: ReturnType<typeof createCustomSelectorHarness>;
      Object.assign(current.ctx.ui, {
        custom: async (factory: unknown) => {
          screen = createCustomSelectorHarness(factory);
          return screen.resultPromise;
        },
      });
      const command = showProgressSettings(current.ctx as ExtensionCommandContext, {
        signal: new AbortController().signal,
        isCurrent: () => true,
        get: () => ({ ...DEFAULT_PROGRESS_SETTINGS }),
        save: async () => ({ ...DEFAULT_PROGRESS_SETTINGS }),
        apply: () => {},
      });
      await vi.waitFor(() => assert.ok(screen));
      screen.handleInput("\u000e");
      const lines = screen.render().join("\n");
      screen.handleInput(cancel);
      await command;
      screen.dispose();
      assert.match(lines, /Use adaptive, expanded, or collapsed/u);
    }
  } finally {
    setKeybindings(original);
  }
});

test("command saves apply to the active widget without changing progress state", async () => {
  const saved: Partial<ProgressSettings>[] = [];
  const harness = createHarness({
    saveSettings: async (patch) => {
      saved.push(patch);
      return { ...DEFAULT_PROGRESS_SETTINGS, ...patch };
    },
  });
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  await setProgress(harness, current.ctx, [{ text: "work", status: "pending" }]);
  let screen!: ReturnType<typeof createCustomSelectorHarness>;
  Object.assign(current.ctx.ui, {
    custom: async (factory: unknown) => {
      screen = createCustomSelectorHarness(factory);
      return screen.resultPromise;
    },
  });
  const progress = harness.commands.get("progress");
  assert.ok(progress);
  const command = progress.handler("settings", current.ctx as ExtensionCommandContext);
  await vi.waitFor(() => assert.ok(screen));
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(current.widgets.at(-1)?.content, undefined));
  screen.handleInput("\u0003");
  await command;
  screen.dispose();
  assert.deepEqual(saved, [{ enabled: false }]);
  assert.deepEqual(harness.entries, []);
  await harness.emit("session_shutdown", current.ctx);
});

test("RPC reports the settings path without opening custom UI", async () => {
  const harness = createHarness();
  const current = createContext({ mode: "rpc" });
  const custom = vi.fn();
  Object.assign(current.ctx.ui, { custom });
  await harness.emit("session_start", current.ctx);
  const progress = harness.commands.get("progress");
  assert.ok(progress);
  await progress.handler("settings", current.ctx as ExtensionCommandContext);
  assert.equal(custom.mock.calls.length, 0);
  assert.match(current.notifications.at(-1)?.message ?? "", /Edit settings manually: .*pi-progress.json/u);
  await harness.emit("session_shutdown", current.ctx);
});

test("session replacement closes the old screen and suppresses a late save", async () => {
  let signal: AbortSignal | undefined;
  let resolve!: (value: ProgressSettings) => void;
  const harness = createHarness({
    saveSettings: async (_patch, _path, ownedSignal) => {
      signal = ownedSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const previous = createContext();
  await harness.emit("session_start", previous.ctx);
  let screen!: ReturnType<typeof createCustomSelectorHarness>;
  Object.assign(previous.ctx.ui, {
    custom: async (factory: unknown) => {
      screen = createCustomSelectorHarness(factory);
      return screen.resultPromise;
    },
  });
  const progress = harness.commands.get("progress");
  assert.ok(progress);
  const command = progress.handler("settings", previous.ctx as ExtensionCommandContext);
  await vi.waitFor(() => assert.ok(screen));
  screen.handleInput("\r");
  await vi.waitFor(() => assert.ok(signal));
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  const publications = current.widgets.length;
  resolve({ ...DEFAULT_PROGRESS_SETTINGS, enabled: false });
  await command;
  assert.equal(signal?.aborted, true);
  assert.equal(current.widgets.length, publications);
  assert.deepEqual(previous.notifications, []);
  screen.dispose();
  await harness.emit("session_shutdown", current.ctx);
});

test("shutdown cancels settings work and waits for its durability boundary", async () => {
  let signal: AbortSignal | undefined;
  let resolve!: (value: ProgressSettings) => void;
  const harness = createHarness({
    saveSettings: async (_patch, _path, ownedSignal) => {
      signal = ownedSignal;
      return new Promise((done) => {
        resolve = done;
      });
    },
  });
  const current = createContext();
  await harness.emit("session_start", current.ctx);
  let screen!: ReturnType<typeof createCustomSelectorHarness>;
  Object.assign(current.ctx.ui, {
    custom: async (factory: unknown) => {
      screen = createCustomSelectorHarness(factory);
      return screen.resultPromise;
    },
  });
  const progress = harness.commands.get("progress");
  assert.ok(progress);
  const command = progress.handler("settings", current.ctx as ExtensionCommandContext);
  await vi.waitFor(() => assert.ok(screen));
  screen.handleInput("\r");
  await vi.waitFor(() => assert.ok(signal));
  let settled = false;
  const shuttingDown = harness.emit("session_shutdown", current.ctx).then(() => {
    settled = true;
  });
  assert.equal(signal?.aborted, true);
  assert.equal(settled, false);
  resolve({ ...DEFAULT_PROGRESS_SETTINGS, enabled: false });
  await Promise.all([command, shuttingDown]);
  assert.equal(settled, true);
  assert.deepEqual(current.notifications, []);
  screen.dispose();
});

test("rapid changes save in order without resetting a newer displayed choice", async () => {
  const current = createContext();
  let screen!: ReturnType<typeof createCustomSelectorHarness>;
  Object.assign(current.ctx.ui, {
    custom: async (factory: unknown) => {
      screen = createCustomSelectorHarness(factory);
      return screen.resultPromise;
    },
  });
  let settings = { ...DEFAULT_PROGRESS_SETTINGS };
  const patches: Partial<ProgressSettings>[] = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const command = showProgressSettings(current.ctx as ExtensionCommandContext, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    get: () => settings,
    save: async (patch) => {
      patches.push(patch);
      await gate;
      return { ...settings, ...patch };
    },
    apply: (next) => {
      settings = next;
    },
  });
  await vi.waitFor(() => assert.ok(screen));
  screen.handleInput("\r");
  screen.handleInput("\r");
  screen.handleInput("\r");
  await vi.waitFor(() => assert.equal(patches.length, 1));
  assert.match(stripVTControlCharacters(screen.render().join("\n")), /Show widget\s+false/u);
  release();
  await vi.waitFor(() => assert.equal(patches.length, 3));
  screen.handleInput("\u0003");
  await command;
  screen.dispose();
  assert.deepEqual(patches, [{ enabled: false }, { enabled: true }, { enabled: false }]);
  assert.equal(settings.enabled, false);
});
