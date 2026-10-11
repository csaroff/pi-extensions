import { formatError, isStaleContextError, notifyTerminal } from "./errors.js";
import type { ActiveGoal } from "./persistence.js";
import type { ContinuationTicket, GoalRuntime, StatusContext } from "./runtime.js";

const RESTORE_START_TIMEOUT_MS = 30_000;

interface RestoreTask {
  ticket: ContinuationTicket;
  generation: number;
  signal: AbortSignal;
  onAbort: () => void;
  resolve: () => void;
  waitForSettlement: boolean;
  timer?: NodeJS.Timeout;
}

/** Owns restore startup acknowledgement and the short-lived host's settlement wait. */
export class GoalRestoreContinuation {
  private task?: RestoreTask;
  private readonly runtime: GoalRuntime;

  constructor(runtime: GoalRuntime) {
    this.runtime = runtime;
  }

  start(ctx: StatusContext, goal: ActiveGoal): Promise<void> {
    if (!this.runtime.requestContinuation(goal)) return Promise.resolve();
    const ticket = this.runtime.continuationIntent;
    if (!ticket) return Promise.resolve();
    this.dispose();
    const signal = this.runtime.menuController.signal;
    const completion = new Promise<void>((resolve) => {
      const task: RestoreTask = {
        ticket,
        generation: this.runtime.menuGeneration,
        signal,
        onAbort: () => this.finish(task),
        resolve,
        waitForSettlement: ctx.mode === "print" || ctx.mode === "json",
      };
      this.task = task;
      signal.addEventListener("abort", task.onAbort, { once: true });
      this.watchStartup(ctx, task);
    });
    this.runtime.scheduleContinuationDispatch(ctx, goal.id);
    return completion;
  }

  acknowledge(marker: string) {
    const task = this.task;
    if (task?.ticket.marker !== marker) return;
    this.clearTimer(task);
    if (!task.waitForSettlement) this.finish(task);
  }

  cancelStartup() {
    const task = this.task;
    if (!task) return;
    this.clearTimer(task);
    if (!task.waitForSettlement) this.finish(task);
  }

  settleIfDone(ctx: StatusContext) {
    const task = this.task;
    if (!task) return;
    if (!this.isCurrent(task)) {
      this.finish(task);
      return;
    }
    const goal = this.runtime.activeGoal;
    if (
      (goal?.id !== task.ticket.goalId ||
        goal.status !== "active" ||
        goal.waiting ||
        !this.runtime.ownsWorkflow(goal)) &&
      ctx.isIdle?.() === true &&
      !ctx.hasPendingMessages?.()
    ) {
      this.finish(task);
    }
  }

  dispose() {
    if (this.task) this.finish(this.task);
  }

  private watchStartup(ctx: StatusContext, task: RestoreTask) {
    task.timer = setTimeout(() => {
      task.timer = undefined;
      if (!this.isCurrent(task)) {
        this.finish(task);
        return;
      }
      const goal = this.runtime.activeGoal;
      const pending =
        this.runtime.continuationIntent?.marker === task.ticket.marker ||
        this.runtime.continuationDelivery?.marker === task.ticket.marker;
      if (goal?.id !== task.ticket.goalId || !this.runtime.ownsWorkflow(goal) || !pending) {
        this.finish(task);
        return;
      }
      // Busy work and queued messages are not a rejected startup. Keep waiting for their boundary.
      if (ctx.isIdle?.() !== true || ctx.hasPendingMessages?.() || this.runtime.agentRunGoalId !== undefined) {
        this.watchStartup(ctx, task);
        return;
      }
      // Pi reports asynchronous send failures only to its host. Bound an unacknowledged
      // restore instead of retaining its delivery forever or guessing authentication state.
      try {
        this.runtime.stopActiveGoal(ctx, { kind: "explicit_pause", expectedGoalId: goal.id });
        this.finish(task);
        if (
          task.generation === this.runtime.menuGeneration &&
          !task.signal.aborted &&
          this.runtime.activeGoal?.id === task.ticket.goalId &&
          this.runtime.activeGoal.status === "paused"
        ) {
          notifyTerminal(
            ctx.ui,
            "Restored Goal did not start within 30 seconds. It was paused; use /goal resume when Pi is ready.",
            "warning",
          );
        }
      } catch (error) {
        this.finish(task);
        if (isStaleContextError(error) || task.generation !== this.runtime.menuGeneration || task.signal.aborted)
          return;
        notifyTerminal(ctx.ui, `Goal restore recovery failed: ${formatError(error)}`, "error");
      }
    }, RESTORE_START_TIMEOUT_MS);
  }

  private isCurrent(task: RestoreTask) {
    return this.task === task && task.generation === this.runtime.menuGeneration && !task.signal.aborted;
  }

  private clearTimer(task: RestoreTask) {
    if (task.timer) clearTimeout(task.timer);
    task.timer = undefined;
  }

  private finish(task: RestoreTask) {
    this.clearTimer(task);
    task.signal.removeEventListener("abort", task.onAbort);
    if (this.task === task) this.task = undefined;
    task.resolve();
  }
}
