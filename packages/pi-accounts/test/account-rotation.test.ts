import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  type CustomEntry,
  initTheme,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { isRotatableFailure, pickNextAccount } from "../src/account-rotation.js";
import accountsExtension, { AccountStore } from "../src/accounts.js";
import type { AccountProviderAdapter } from "../src/oauth.js";
import { ACCOUNT_SELECTION_ENTRY_TYPE } from "../src/session-selection.js";
import { InMemoryAccountStorageBackend } from "../src/storage.js";
import { isolateAccountEnvironment } from "./isolate-account-environment.js";

isolateAccountEnvironment();
beforeAll(() => initTheme("dark", false));

const credential = (name: string) => ({
  type: "oauth" as const,
  access: `access-${name}`,
  refresh: `refresh-${name}`,
  expires: Date.now() + 3_600_000,
});

const openai: AccountProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",
  requiresApiKeyBridge: false,
  supportsApiKey: true,
  runtimeAuthMode: "api-key",
  oauth: {
    login: async () => credential("login"),
    refresh: async (current) => current,
    toAuth: async (current) => ({ apiKey: current.access }),
  },
};

type Handler = (event: unknown, ctx: unknown) => unknown;

// Pi runs every handler registered for an event; the last non-empty result is what the boundary sees.
async function emit(mock: ReturnType<typeof createMockPi>, name: string, event: object, ctx: unknown) {
  let result: unknown;
  for (const handler of (mock.events.get(name) ?? []) as Handler[]) {
    result = (await handler({ type: name, ...event }, ctx)) ?? result;
  }
  return result;
}

function sessionSelection(manager: SessionManager, providerId: string) {
  const entry = manager
    .getEntries()
    .filter(
      (candidate): candidate is CustomEntry =>
        candidate.type === "custom" && candidate.customType === ACCOUNT_SELECTION_ENTRY_TYPE,
    )
    .at(-1);
  return (entry?.data as { providers?: Record<string, string | null> } | undefined)?.providers?.[providerId];
}

function failedReply(errorMessage: string) {
  return {
    role: "assistant" as const,
    content: [],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4o",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error" as const,
    errorMessage,
    timestamp: Date.now(),
  };
}

function settleEvent(manager: SessionManager) {
  const projection = manager.buildSessionProjection();
  return {
    outcome: "error",
    entries: [],
    continue: false,
    context: {
      contextEntries: projection.entries,
      contextMessages: projection.messages,
      llmMessages: [],
      pendingMessages: [],
      canContinue: true,
    },
  };
}

test("a usage-limited account hands the same request to the next saved account", async () => {
  // Two ChatGPT subscriptions under the native OpenAI provider. "work" is the saved default,
  // and rotation is switched on in pi-accounts.json.
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.update((data) => ({
    ...data,
    rotation: { enabled: true },
    providers: {
      openai: { active: "work", accounts: { work: credential("work"), personal: credential("personal") } },
    },
  }));
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [openai] });
  const registry = new ModelRegistry(
    await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
    }),
  );
  const manager = SessionManager.inMemory(process.cwd());
  const { ctx, notifications } = createMockContext({
    sessionManager: manager,
    modelRegistry: registry,
    model: { provider: "openai", id: "gpt-4o" },
  });

  // The session starts on the saved default and sends its first request with that credential.
  await emit(mock, "session_start", {}, ctx);
  await emit(mock, "before_agent_start", {}, ctx);
  await emit(mock, "turn_start", { turnIndex: 0 }, ctx);
  assert.equal(await registry.getApiKeyForProvider("openai"), "access-work");

  // ChatGPT rejects it because the subscription's usage limit is spent. Pi does not retry this
  // error (the same account would fail again), so the run reaches settlement with it as the
  // latest reply.
  manager.appendMessage({ role: "user", content: "Refactor the parser", timestamp: Date.now() });
  const failedId = manager.appendMessage(
    failedReply("Sign in with ChatGPT: subscription_sharing_usage_limit_exceeded"),
  );
  const result = await emit(mock, "agent_before_settle", settleEvent(manager), ctx);

  // Rotation hides only the failed reply from the model and asks Pi for one more request, so the
  // model answers the original prompt as if the failure never happened.
  assert.deepEqual(result, {
    entries: [{ type: "context_edit", targetId: failedId, replacement: null }],
    continue: true,
  });

  // That request goes out with the second account's credential...
  assert.equal(await registry.getApiKeyForProvider("openai"), "access-personal");

  // ...but only for this session: new sessions still start on the saved default.
  assert.equal(sessionSelection(manager, "openai"), "personal");
  assert.equal((await store.readProviderAsync("openai")).active, "work");

  // The user can see what happened and why.
  assert.ok(
    notifications.some(({ message }) => message.includes('"work"') && message.includes('"personal"')),
    "expected a notification naming both accounts",
  );

  await emit(mock, "session_shutdown", {}, ctx);
});

async function rotationFixture(options: { rotation?: boolean; active?: string; accounts?: string[] } = {}) {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.update((data) => ({
    ...data,
    ...(options.rotation === false ? {} : { rotation: { enabled: true } }),
    providers: {
      openai: {
        ...(options.active === undefined ? { active: "work" } : options.active ? { active: options.active } : {}),
        accounts: Object.fromEntries(
          (options.accounts ?? ["work", "personal"]).map((name) => [name, credential(name)]),
        ),
      },
    },
  }));
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [openai] });
  const registry = new ModelRegistry(
    await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false }),
  );
  const manager = SessionManager.inMemory(process.cwd());
  const { ctx, notifications } = createMockContext({
    sessionManager: manager,
    modelRegistry: registry,
    model: { provider: "openai", id: "gpt-4o" },
  });
  await emit(mock, "session_start", {}, ctx);
  await emit(mock, "before_agent_start", {}, ctx);
  // Each request records which account sent it, then fails with the given provider error.
  const failRequest = async (errorMessage: string) => {
    await emit(mock, "turn_start", { turnIndex: 0 }, ctx);
    manager.appendMessage(failedReply(errorMessage));
    return emit(mock, "agent_before_settle", settleEvent(manager), ctx);
  };
  const apiKey = () => registry.getApiKeyForProvider("openai");
  return { store, mock, ctx, manager, notifications, failRequest, apiKey };
}

test("rotation stops once every saved account has failed the same prompt", async () => {
  const { failRequest, apiKey, notifications } = await rotationFixture();
  const first = (await failRequest("429 Too Many Requests: rate limit reached")) as { continue?: boolean };
  assert.equal(first?.continue, true);
  assert.equal(await apiKey(), "access-personal");

  // "work" already failed this prompt, so the second failure settles instead of looping back.
  assert.equal(await failRequest("insufficient_quota"), undefined);
  assert.equal(await apiKey(), "access-personal");
  assert.ok(notifications.some(({ message, level }) => level === "warning" && message.includes("no other saved")));
});

for (const scenario of [
  { name: "rotation is off by default", fixture: { rotation: false }, error: "usage_limit_exceeded" },
  { name: "auth failures stay fail-closed", fixture: {}, error: "401 Unauthorized: token has been invalidated" },
  { name: "provider-wide overload would fail on any account", fixture: {}, error: "529 overloaded" },
  { name: "Pi's built-in login is not in the saved pool", fixture: { active: "" }, error: "usage_limit_exceeded" },
]) {
  test(`no rotation when ${scenario.name}`, async () => {
    const { failRequest, apiKey, manager } = await rotationFixture(scenario.fixture);
    const before = await apiKey();
    assert.equal(await failRequest(scenario.error), undefined);
    assert.equal(await apiKey(), before);
    assert.notEqual(sessionSelection(manager, "openai"), "personal");
  });
}

test("no rotation when PI_ACCOUNT pins the process to one account", async () => {
  process.env.PI_ACCOUNT = "work";
  const { failRequest, apiKey } = await rotationFixture();
  assert.equal(await apiKey(), "access-work");
  assert.equal(await failRequest("usage_limit_exceeded"), undefined);
  assert.equal(await apiKey(), "access-work");
});

test("pickNextAccount walks saved accounts in order, skipping tried and cooling accounts", () => {
  const names = ["c", "a", "b"];
  const pick = (failed: string, attempted: string[] = [], cooling: Record<string, number> = {}) =>
    pickNextAccount({ names, failed, attempted: new Set(attempted), coolingUntil: (name) => cooling[name], now: 100 });
  assert.equal(pick("a"), "b");
  assert.equal(pick("c"), "a", "wraps around after the last account");
  assert.equal(pick("a", ["b"]), "c");
  assert.equal(pick("a", [], { b: 200 }), "c", "skips an account still cooling down");
  assert.equal(pick("a", [], { b: 50 }), "b", "an expired cooldown is available again");
  assert.equal(pick("a", ["b", "c"]), undefined);
});

test("isRotatableFailure matches limit errors only", () => {
  const rotatable = (errorMessage: string) => isRotatableFailure({ stopReason: "error", errorMessage });
  for (const message of [
    "subscription_sharing_usage_limit_exceeded",
    "insufficient_quota",
    "Quota exceeded for this billing period",
    "429 Too Many Requests",
    "rate_limit_error: Number of request tokens has exceeded your per-minute rate limit",
  ]) {
    assert.equal(rotatable(message), true, message);
  }
  for (const message of ["401 Unauthorized", "529 overloaded", "500 internal server error", "fetch failed"]) {
    assert.equal(rotatable(message), false, message);
  }
  assert.equal(isRotatableFailure({ stopReason: "aborted", errorMessage: "usage_limit_exceeded" }), false);
});
