import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { GoalCommandController } from "../src/commands.js";
import { createGoal, GoalRuntime } from "../src/runtime.js";
import { requireLastGoal, restoreGoalForTest, startGoalForTest } from "./support/goal-fixture.js";

test.each(["start", "edit", "resume"])("active resume rejects a pending %s prompt", async (operation) => {
  const active = operation === "resume" ? restoreGoalForTest("paused") : await startGoalForTest();
  if (operation === "edit") await active.mock.commands.get("goal")?.handler("edit updated objective", active.ctx);
  if (operation === "resume") await active.mock.commands.get("goal")?.handler("resume", active.ctx);
  const before = requireLastGoal(active.mock);
  const prompts = active.mock.sentUserMessages.length;

  await active.mock.commands.get("goal")?.handler("resume", active.ctx);

  assert.equal(requireLastGoal(active.mock).id, before.id);
  assert.equal(active.mock.sentUserMessages.length, prompts);
  assert.match(active.notifications.at(-1)?.message ?? "", /only stopped or idle active/);
  await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
});

test.each([{ isIdle: () => false }, { hasPendingMessages: () => true }])(
  "active resume rejects host work or pending session messages: %s",
  async (overrides) => {
    const active = restoreGoalForTest("active", {}, overrides);
    await active.mock.commands.get("goal")?.handler("resume", active.ctx);
    assert.equal(requireLastGoal(active.mock).id, active.sessionGoal.id);
    assert.equal(active.mock.sentUserMessages.length, 0);
    await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
  },
);

test.each([true, false])("failed active resume keeps ownership with retained owner=%s", async (retained) => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const sessionManager = {};
  const context = createMockContext({ sessionManager });
  const runtime = new GoalRuntime(mock.pi);
  runtime.bindWorkflowSession(sessionManager);
  runtime.activeGoal = createGoal("restored objective", undefined, 0);
  const original = runtime.activeGoal;
  if (retained) assert.equal(runtime.acquireWorkflow(), true);
  mock.rawPi.sendUserMessage = () => {
    throw new Error("delivery rejected");
  };

  await new GoalCommandController(runtime).resumeGoal(context.ctx);

  assert.equal(runtime.activeGoal.id, original.id);
  assert.equal(runtime.activeGoal.status, "active");
  assert.equal(runtime.ownsWorkflow(), true);
  assert.equal(runtime.hasPendingGoalPromptForGoal(original.id), false);
  runtime.releaseWorkflow();
  runtime.closeMenuSession();
});

test("missing helpers pause an idle active Goal before releasing ownership", async () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const sessionManager = {};
  const context = createMockContext({ sessionManager });
  const runtime = new GoalRuntime(mock.pi);
  runtime.bindWorkflowSession(sessionManager);
  runtime.activeGoal = createGoal("restored objective", undefined, 0);
  assert.equal(runtime.acquireWorkflow(), true);
  mock.rawPi.setActiveTools([]);

  await new GoalCommandController(runtime).resumeGoal(context.ctx);

  assert.equal(runtime.activeGoal.status, "paused");
  assert.equal(runtime.ownsWorkflow(), false);
  assert.equal(mock.sentUserMessages.length, 0);
  runtime.closeMenuSession();
});

test("failed stopped resume releases only its newly acquired ownership", async () => {
  const mock = createMockPi({ activeTools: ["goal_complete", "goal_blocked", "goal_wait"] });
  const sessionManager = {};
  const context = createMockContext({ sessionManager });
  const runtime = new GoalRuntime(mock.pi);
  runtime.bindWorkflowSession(sessionManager);
  runtime.activeGoal = { ...createGoal("paused objective", undefined, 0), status: "paused" };
  const id = runtime.activeGoal.id;
  mock.rawPi.sendUserMessage = () => {
    throw new Error("delivery rejected");
  };

  await new GoalCommandController(runtime).resumeGoal(context.ctx);

  assert.equal(runtime.activeGoal.id, id);
  assert.equal(runtime.activeGoal.status, "paused");
  const contender = new GoalRuntime(mock.pi);
  contender.bindWorkflowSession(sessionManager);
  assert.equal(contender.acquireWorkflow(), true);
  contender.releaseWorkflow();
  contender.closeMenuSession();
  runtime.releaseWorkflow();
  runtime.closeMenuSession();
});
