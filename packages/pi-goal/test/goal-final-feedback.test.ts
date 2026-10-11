import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { buildGoalMenuState, GOAL_MENU_ACTIONS } from "../src/menu.js";
import { DEFAULT_GOAL_SETTINGS } from "../src/settings.js";
import { requireLastGoal, restoreStoredGoalForTest, settingsPath } from "./support/goal-fixture.js";

function restore(mode = "off", overrides: Record<string, unknown> = {}) {
  const path = settingsPath("final-feedback.json");
  writeFileSync(path, JSON.stringify({ resume: { autoResumeOnRestore: mode } }));
  return restoreStoredGoalForTest(
    {
      id: "restored-final",
      text: "finish",
      status: "active",
      startedAt: 1,
      updatedAt: 2,
      iteration: 0,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      baselineTokens: 0,
    },
    [],
    overrides,
    path,
  );
}

test.each(["Keep paused", "Resume now", "Clear goal"])(
  "accepted new input invalidates late restore choice %s",
  async (choice) => {
    vi.useFakeTimers();
    let resolve!: (value: string) => void;
    const selection = new Promise<string>((done) => {
      resolve = done;
    });
    const active = restore("ask", { mode: "rpc", hasUI: true, select: () => selection });
    active.mock.events.get("input")?.[0]?.({ text: "new user request", source: "user" }, active.ctx);
    active.mock.events.get("before_agent_start")?.[0]?.({ prompt: "new user request" }, active.ctx);
    resolve(choice);
    await Promise.resolve();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(requireLastGoal(active.mock).status, "active");
    assert.equal(requireLastGoal(active.mock).id, "restored-final");
    assert.equal(active.mock.sentUserMessages.length, 0);
    await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
  },
);

test("headless Auto does not hold subsequent session_start handlers", async () => {
  vi.useFakeTimers();
  const active = restore("auto", { mode: "print" });
  let returned = false;
  const startup = Promise.resolve(active.mock.events.get("session_start")?.[0]?.({}, active.ctx)).then(() => {
    returned = true;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(returned, true);
  assert.equal(active.mock.sentUserMessages.length, 0);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
  await startup;
});

test("cancelled and unrelated preflight boundaries cannot overwrite run cancellation", async () => {
  vi.useFakeTimers();
  const signal = new AbortController().signal;
  const abort = vi.fn();
  const active = restore("auto", { mode: "rpc", signal, abort });
  await vi.advanceTimersByTimeAsync(0);
  const prompt = active.mock.sentUserMessages[0]?.text;
  assert.ok(prompt);
  active.mock.events.get("input")?.[0]?.({ text: prompt, source: "extension" }, active.ctx);
  await vi.advanceTimersByTimeAsync(30_000);
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt }, active.ctx);
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: "unrelated work" }, active.ctx);
  active.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: prompt } }, active.ctx);
  abort.mockClear();
  active.mock.events.get("context")?.[0]?.({ messages: [] }, active.ctx);
  assert.ok(abort.mock.calls.length > 0);
  Object.assign(active.ctx, { signal: new AbortController().signal });
  abort.mockClear();
  active.mock.events.get("context")?.[0]?.({ messages: [] }, active.ctx);
  assert.equal(abort.mock.calls.length, 0);
  Object.assign(active.ctx, { signal });
  active.mock.events.get("context")?.[0]?.({ messages: [] }, active.ctx);
  assert.ok(abort.mock.calls.length > 0);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test("idle-active status includes the same resume command as the manager", async () => {
  const active = restore();
  await active.mock.commands.get("goal")?.handler("status", active.ctx);
  assert.match(active.notifications.at(-1)?.message ?? "", /Commands: \/goal resume/);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test("Goal menu can expose idle-active resume", () => {
  const state = buildGoalMenuState(
    {
      settings: DEFAULT_GOAL_SETTINGS,
      activeGoal: {
        id: "idle",
        text: "finish",
        status: "active",
        startedAt: 1,
        updatedAt: 2,
        iteration: 0,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        baselineTokens: 0,
        automaticModelTurns: 0,
        toolFreeRepeatCount: 0,
      },
    },
    true,
  );
  assert.equal(state.actions[0], GOAL_MENU_ACTIONS.resume);
});
