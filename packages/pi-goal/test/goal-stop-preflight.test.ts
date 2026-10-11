import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { test, vi } from "vitest";
import { lastGoal, restoreStoredGoalForTest, settingsPath } from "./support/goal-fixture.js";

const cases = ["pause", "clear"].flatMap((operation) =>
  ["manual", "automatic"].flatMap((origin) =>
    ["input", "accepted"].map((boundary) => ({ operation, origin, boundary })),
  ),
);

test.each(cases)(
  "$operation cancels $origin work after its $boundary boundary",
  async ({ operation, origin, boundary }) => {
    vi.useFakeTimers();
    const path = settingsPath("stop-preflight.json");
    writeFileSync(path, JSON.stringify({ resume: { autoResumeOnRestore: origin === "automatic" ? "auto" : "off" } }));
    const abort = vi.fn();
    const active = restoreStoredGoalForTest(
      {
        id: "stop-preflight",
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
      { mode: "rpc", abort, signal: new AbortController().signal },
      path,
    );
    if (origin === "manual") await active.mock.commands.get("goal")?.handler("resume", active.ctx);
    else await vi.advanceTimersByTimeAsync(0);
    const prompt = active.mock.sentUserMessages[0]?.text;
    assert.ok(prompt);
    active.mock.events.get("input")?.[0]?.({ source: "extension", text: prompt }, active.ctx);
    if (boundary === "accepted") active.mock.events.get("before_agent_start")?.[0]?.({ prompt }, active.ctx);
    await active.mock.commands.get("goal")?.handler(operation, active.ctx);
    if (boundary === "input") active.mock.events.get("before_agent_start")?.[0]?.({ prompt }, active.ctx);
    abort.mockClear();
    active.mock.events.get("message_start")?.[0]?.({ message: { role: "user", content: prompt } }, active.ctx);
    active.mock.events.get("context")?.[0]?.({ messages: [] }, active.ctx);
    assert.ok(abort.mock.calls.length > 0);
    active.mock.events.get("agent_end")?.[0]?.(
      { messages: [{ role: "assistant", stopReason: "aborted" }] },
      active.ctx,
    );
    assert.equal(lastGoal(active.mock)?.status ?? null, operation === "pause" ? "paused" : null);
    assert.equal(vi.getTimerCount(), 0);
    await active.mock.events.get("session_shutdown")?.[0]?.({}, active.ctx);
  },
);
