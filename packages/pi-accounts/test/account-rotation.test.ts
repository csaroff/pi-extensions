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
