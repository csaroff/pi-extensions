import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";

function fixture(mode = "rpc", overrides: Record<string, unknown> = {}) {
  vi.useFakeTimers();
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const sessionManager = {};
  const context = createMockContext({ mode, sessionManager, ...overrides });
  const runtime = new GoalRuntime(mock.pi);
  runtime.bindWorkflowSession(sessionManager);
  runtime.activeGoal = createGoal("restored objective", undefined, 0);
  assert.equal(runtime.acquireWorkflow(), true);
  let settled = false;
  const completion = runtime.restoreContinuation.start(context.ctx, runtime.activeGoal).then(() => {
    settled = true;
  });
  return { mock, ...context, runtime, completion, settled: () => settled };
}

function dispose(active: ReturnType<typeof fixture>) {
  active.runtime.clearContinuationTracking();
  active.runtime.releaseWorkflow();
  active.runtime.closeMenuSession();
}

test("unacknowledged idle restore pauses and cancels stale delivery", async () => {
  const active = fixture();
  await vi.advanceTimersByTimeAsync(0);
  const prompt = active.mock.sentUserMessages[0]?.text;
  assert.ok(prompt);
  assert.ok(active.runtime.continuationDelivery);
  await vi.advanceTimersByTimeAsync(30_000);
  await active.completion;
  assert.equal(active.runtime.activeGoal?.status, "paused");
  assert.equal(active.runtime.ownsWorkflow(), false);
  assert.equal(active.runtime.continuationDelivery, undefined);
  assert.equal(active.runtime.consumeCancelledContinuationPrompt(prompt), true);
  assert.match(active.notifications.at(-1)?.message ?? "", /did not start within 30 seconds/);
  assert.equal(vi.getTimerCount(), 0);
  dispose(active);
});

test.each(["busy", "pending"])("startup watchdog does not pause %s host work", async (state) => {
  let blocked = true;
  const active = fixture("rpc", {
    isIdle: () => state !== "busy" || !blocked,
    hasPendingMessages: () => state === "pending" && blocked,
  });
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(active.runtime.activeGoal?.status, "active");
  assert.equal(active.settled(), false);
  blocked = false;
  active.runtime.dispatchContinuationIfSettled(active.ctx);
  await vi.advanceTimersByTimeAsync(30_000);
  assert.equal(active.runtime.activeGoal?.status, "paused");
  dispose(active);
});

test("acknowledged interactive restore releases its startup timer", async () => {
  const active = fixture();
  await vi.advanceTimersByTimeAsync(0);
  active.runtime.markContinuationStarted(active.mock.sentUserMessages[0]?.text ?? "");
  await active.completion;
  assert.equal(vi.getTimerCount(), 0);
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(active.runtime.activeGoal?.status, "active");
  dispose(active);
});

test.each(["print", "json"])("%s restore awaits Goal settlement after startup acknowledgement", async (mode) => {
  let idle = true;
  const active = fixture(mode, { isIdle: () => idle });
  await vi.advanceTimersByTimeAsync(0);
  active.runtime.markContinuationStarted(active.mock.sentUserMessages[0]?.text ?? "");
  assert.equal(active.settled(), false);
  idle = false;
  active.runtime.stopActiveGoal(active.ctx, { kind: "explicit_pause", expectedGoalId: active.runtime.activeGoal!.id });
  await Promise.resolve();
  assert.equal(active.settled(), false);
  idle = true;
  active.runtime.restoreContinuation.settleIfDone(active.ctx);
  await active.completion;
  assert.equal(active.settled(), true);
  assert.equal(vi.getTimerCount(), 0);
  dispose(active);
});

test("headless rejected startup settles after recovery", async () => {
  const active = fixture("print");
  await vi.advanceTimersByTimeAsync(30_000);
  await active.completion;
  assert.equal(active.runtime.activeGoal?.status, "paused");
  dispose(active);
});

test.each(["shutdown", "replacement"])("%s cancels watchdog without accessing stale context", async (reason) => {
  let stale = false;
  const active = fixture("json", {
    isIdle: () => {
      assert.equal(stale, false);
      return true;
    },
  });
  await vi.advanceTimersByTimeAsync(0);
  stale = true;
  if (reason === "replacement") active.runtime.replaceMenuSession();
  else active.runtime.closeMenuSession();
  active.runtime.clearContinuationTracking();
  await active.completion;
  await vi.advanceTimersByTimeAsync(60_000);
  assert.equal(active.runtime.activeGoal?.status, "active");
  assert.equal(vi.getTimerCount(), 0);
  dispose(active);
});
