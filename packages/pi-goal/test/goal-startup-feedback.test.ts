import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { requireLastGoal, restoreStoredGoalForTest, settingsPath } from "./support/goal-fixture.js";

function restore(mode = "off", overrides: Record<string, unknown> = {}, goalOverrides = {}) {
  const path = settingsPath("startup-feedback.json");
  writeFileSync(path, JSON.stringify({ resume: { autoResumeOnRestore: mode } }));
  return restoreStoredGoalForTest(
    {
      id: "restored-feedback",
      text: "finish",
      status: "active",
      startedAt: 1,
      updatedAt: 2,
      iteration: 0,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      baselineTokens: 0,
      ...goalOverrides,
    },
    [],
    overrides,
    path,
  );
}

test("JSON SDK with UI does not open an Ask restore dialog", async () => {
  const select = vi.fn(async () => "Resume now");
  const active = restore("ask", { mode: "json", hasUI: true, select });
  await Promise.resolve();
  assert.equal(select.mock.calls.length, 0);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test("unacknowledged idle active resume restores its original Goal and permits retry", async () => {
  vi.useFakeTimers();
  const active = restore();
  const original = requireLastGoal(active.mock);
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  const rejectedPrompt = active.mock.sentUserMessages[0]?.text;
  assert.ok(rejectedPrompt);
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(requireLastGoal(active.mock).id, original.id);
  assert.equal(requireLastGoal(active.mock).status, "active");
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  assert.equal(active.mock.sentUserMessages.length, 2);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test("a timed-out restore aborts a late accepted prompt at its model context boundary", async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const active = restore("auto", { mode: "rpc", abort, signal: new AbortController().signal });
  await vi.advanceTimersByTimeAsync(0);
  const prompt = active.mock.sentUserMessages[0]?.text;
  assert.ok(prompt);
  active.mock.events.get("input")?.[0]?.({ text: prompt, source: "extension" }, active.ctx);
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(requireLastGoal(active.mock).status, "paused");
  abort.mockClear();
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt }, active.ctx);
  active.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: prompt } }, active.ctx);
  active.mock.events.get("context")?.[0]?.({ messages: [] }, active.ctx);
  assert.ok(abort.mock.calls.length > 0);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test("manual startup acknowledgement cancels recovery without resetting the original Goal again", async () => {
  vi.useFakeTimers();
  const active = restore();
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  const resumed = requireLastGoal(active.mock);
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt: active.mock.sentUserMessages[0]?.text }, active.ctx);
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(requireLastGoal(active.mock).id, resumed.id);
  assert.equal(vi.getTimerCount(), 0);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test("late rejected manual startup leaves the original active Goal intact and does not abort unrelated input", async () => {
  vi.useFakeTimers();
  const abort = vi.fn();
  const active = restore("off", { abort, signal: new AbortController().signal });
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  const prompt = active.mock.sentUserMessages[0]?.text;
  assert.ok(prompt);
  active.mock.events.get("input")?.[0]?.({ text: prompt, source: "extension" }, active.ctx);
  await vi.advanceTimersByTimeAsync(30_000);
  active.mock.events.get("before_agent_start")?.[0]?.({ prompt }, active.ctx);
  active.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: prompt } }, active.ctx);
  abort.mockClear();
  active.mock.events.get("context")?.[0]?.({ messages: [] }, active.ctx);
  assert.ok(abort.mock.calls.length > 0);
  active.mock.events.get("agent_end")?.[0]?.({ messages: [] }, active.ctx);
  assert.equal(requireLastGoal(active.mock).id, "restored-feedback");
  assert.equal(requireLastGoal(active.mock).status, "active");
  active.mock.events.get("agent_settled")?.[0]?.({}, active.ctx);
  Object.assign(active.ctx, { signal: new AbortController().signal });
  abort.mockClear();
  active.mock.events.get("before_agent_start")?.[0]?.(
    { prompt: `Quoted cancelled work: ${prompt}\nEnd quote` },
    active.ctx,
  );
  active.mock.events.get("context")?.[0]?.({ messages: [] }, active.ctx);
  assert.equal(abort.mock.calls.length, 0);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test("shutdown cancels unacknowledged manual resume recovery", async () => {
  vi.useFakeTimers();
  const active = restore();
  await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
  const entries = active.mock.entries.length;
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(active.mock.entries.length, entries);
  assert.equal(vi.getTimerCount(), 0);
});

test.each(["print", "json"])("%s dispatches an overdue restored Auto wait during startup", async (mode) => {
  vi.useFakeTimers();
  const active = restore(
    "auto",
    { mode, hasUI: false },
    { waiting: { reason: "external work", resumeAt: Date.now() - 1 } },
  );
  const startup = active.mock.events.get("resources_discover")?.[0]?.({ reason: "startup" }, active.ctx);
  await Promise.resolve();
  assert.equal(active.mock.sentUserMessages.length, 1);
  assert.equal(requireLastGoal(active.mock).waiting, undefined);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
  await startup;
});
