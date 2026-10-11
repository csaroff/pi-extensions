import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  lastGoal,
  requireLastGoal,
  restoreStoredGoalForTest,
  type StoredGoal,
  settingsPath,
} from "./support/goal-fixture.js";

const STORED_GOAL: StoredGoal = {
  id: "restored-goal",
  text: "finish the objective",
  status: "active",
  startedAt: 1,
  updatedAt: 2,
  iteration: 3,
  tokensUsed: 0,
  timeUsedSeconds: 4,
  baselineTokens: 0,
  automaticModelTurns: 2,
};

function restore(
  mode: "ask" | "auto" | "off" = "ask",
  goalOverrides: Partial<StoredGoal> = {},
  contextOverrides: Record<string, unknown> = {},
) {
  const path = settingsPath("restore-actions.json");
  writeFileSync(path, JSON.stringify({ resume: { autoResumeOnRestore: mode } }));
  return restoreStoredGoalForTest(
    { ...STORED_GOAL, ...goalOverrides },
    [],
    { mode: "rpc", hasUI: true, ...contextOverrides },
    path,
  );
}

function deferredChoice() {
  let resolve!: (value: string | undefined) => void;
  const promise = new Promise<string | undefined>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flushChoice() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

function shutdown(restored: ReturnType<typeof restore>) {
  return restored.mock.events.get("session_shutdown")?.[0]?.({}, restored.ctx);
}

test("manual resume starts an active restored idle Goal without pause first", async () => {
  const restored = restore("off");
  const previous = requireLastGoal(restored.mock);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);
  assert.equal(restored.mock.sentUserMessages.length, 1);
  assert.notEqual(requireLastGoal(restored.mock).id, previous.id);
  await shutdown(restored);
});

test("manual resume still rejects an active Goal owned by a running agent", async () => {
  const restored = restore("off");
  restored.mock.events.get("before_agent_start")?.[0]?.({ prompt: "continue working" }, restored.ctx);
  await restored.mock.commands.get("goal")?.handler("resume", restored.ctx);
  assert.equal(requireLastGoal(restored.mock).id, STORED_GOAL.id);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  assert.match(restored.notifications.at(-1)?.message ?? "", /only stopped or idle active/);
  await shutdown(restored);
});

test.each(["auto", "ask"] as const)(
  "%s starts one restored idle continuation without resetting safety",
  async (mode) => {
    vi.useFakeTimers();
    const restored = restore(mode, {}, { select: async () => "Resume now" });
    await flushChoice();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(restored.mock.sentUserMessages.length, 1);
    restored.mock.events.get("before_agent_start")?.[0]?.(
      { prompt: restored.mock.sentUserMessages[0]?.text },
      restored.ctx,
    );
    assert.equal(requireLastGoal(restored.mock).status, "active");
    assert.equal(requireLastGoal(restored.mock).automaticModelTurns, 2);
    restored.mock.events.get("agent_settled")?.[0]?.({}, restored.ctx);
    assert.equal(restored.mock.sentUserMessages.length, 1);
    await shutdown(restored);
  },
);

test.each(["paused", "blocked", "usage_limited", "budget_limited"])("auto never resumes %s Goals", async (status) => {
  vi.useFakeTimers();
  const restored = restore("auto", { status });
  await vi.runAllTimersAsync();
  assert.equal(requireLastGoal(restored.mock).status, status);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await shutdown(restored);
});

test.each([undefined, "invalid choice"])("dismissed or invalid restore choice leaves Goal idle", async (choice) => {
  vi.useFakeTimers();
  const restored = restore("ask", {}, { select: async () => choice });
  await flushChoice();
  await vi.runAllTimersAsync();
  assert.equal(requireLastGoal(restored.mock).status, "active");
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await shutdown(restored);
});

test.each(["print", "json"])("ask does not open a dialog in %s mode", async (mode) => {
  const select = vi.fn(async () => "Resume now");
  const restored = restore("ask", {}, { mode, hasUI: false, select });
  await flushChoice();
  assert.equal(select.mock.calls.length, 0);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await shutdown(restored);
});

test.each([false, true])("restore choice ignores newer work with pending continuation=%s", async (pending) => {
  vi.useFakeTimers();
  const choice = deferredChoice();
  const abort = vi.fn();
  const restored = restore("ask", {}, { select: () => choice.promise, abort });
  restored.mock.events.get("before_agent_start")?.[0]?.({ prompt: "continue working" }, restored.ctx);
  if (pending) restored.mock.events.get("agent_end")?.[0]?.({ messages: [] }, restored.ctx);
  choice.resolve("Keep paused");
  await flushChoice();
  assert.equal(requireLastGoal(restored.mock).status, "active");
  assert.equal(abort.mock.calls.length, 0);
  const result = restored.mock.events.get("tool_call")?.[0]?.(
    { toolName: "bash", input: { command: "true" } },
    restored.ctx,
  );
  assert.equal(result, undefined);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await shutdown(restored);
});

test("restore pause cancels a restored wait deadline", async () => {
  vi.useFakeTimers();
  const restored = restore(
    "ask",
    { waiting: { reason: "external work", resumeAt: Date.now() + 60_000 } },
    { select: async () => "Keep paused" },
  );
  await flushChoice();
  assert.equal(requireLastGoal(restored.mock).status, "paused");
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await shutdown(restored);
});

test.each([undefined, 60_000])("Resume now wakes restored waiting Goal with deadline=%s", async (deadline) => {
  vi.useFakeTimers();
  const restored = restore(
    "ask",
    { waiting: { reason: "external work", ...(deadline === undefined ? {} : { resumeAt: Date.now() + deadline }) } },
    { select: async () => "Resume now" },
  );
  await flushChoice();
  assert.equal(requireLastGoal(restored.mock).waiting, undefined);
  assert.equal(requireLastGoal(restored.mock).automaticModelTurns, 2);
  assert.equal(restored.mock.sentUserMessages.length, 1);
  assert.match(restored.mock.sentUserMessages[0]?.text ?? "", /external work/);
  assert.equal(vi.getTimerCount(), 0);
  await shutdown(restored);
});

test("auto preserves an indefinite restored wait", async () => {
  vi.useFakeTimers();
  const restored = restore("auto", { waiting: { reason: "external work" } });
  await vi.runAllTimersAsync();
  assert.deepEqual(requireLastGoal(restored.mock).waiting, { reason: "external work" });
  assert.equal(restored.mock.sentUserMessages.length, 0);
  await shutdown(restored);
});

test("restore clear uses the normal clear path without aborting unrelated work", async () => {
  const abort = vi.fn();
  const restored = restore("ask", {}, { select: async () => "Clear goal", abort });
  await flushChoice();
  assert.equal(lastGoal(restored.mock), null);
  assert.equal(restored.statuses.get("goal"), undefined);
  assert.equal(abort.mock.calls.length, 0);
  await shutdown(restored);
});

test("shutdown aborts the restore dialog and ignores a late answer", async () => {
  const choice = deferredChoice();
  let options: { signal?: AbortSignal; timeout?: number } | undefined;
  const restored = restore(
    "ask",
    {},
    {
      select: (_title: string, _choices: string[], opts: typeof options) => {
        options = opts;
        return choice.promise;
      },
    },
  );
  assert.equal(options?.timeout, 30_000);
  assert.equal(options?.signal?.aborted, false);
  await shutdown(restored);
  assert.equal(options?.signal?.aborted, true);
  const entries = restored.mock.entries.length;
  choice.resolve("Keep paused");
  await flushChoice();
  assert.equal(restored.mock.entries.length, entries);
});

test("replacement ignores an old dialog even when the Goal ID is unchanged", async () => {
  const choice = deferredChoice();
  const restored = restore("ask", {}, { select: () => choice.promise });
  const branch = [{ type: "custom", customType: "goal-state", data: { goal: STORED_GOAL } }];
  const replacement = createMockContext({
    mode: "rpc",
    hasUI: true,
    sessionManager: { getBranch: () => branch, getEntries: () => branch },
    select: async () => undefined,
  });
  await restored.mock.events.get("session_start")?.[0]?.({}, replacement.ctx);
  choice.resolve("Keep paused");
  await flushChoice();
  assert.equal(requireLastGoal(restored.mock).status, "active");
  await restored.mock.events.get("session_shutdown")?.[0]?.({}, replacement.ctx);
});

test("a Goal transition invalidates a pending restore choice", async () => {
  const choice = deferredChoice();
  const restored = restore("ask", {}, { select: () => choice.promise });
  await restored.mock.commands.get("goal")?.handler("edit revised objective", restored.ctx);
  const edited = requireLastGoal(restored.mock);
  assert.notEqual(edited.id, STORED_GOAL.id);
  choice.resolve("Clear goal");
  await flushChoice();
  assert.equal(requireLastGoal(restored.mock).id, edited.id);
  assert.equal(requireLastGoal(restored.mock).text, "revised objective");
  await shutdown(restored);
});
