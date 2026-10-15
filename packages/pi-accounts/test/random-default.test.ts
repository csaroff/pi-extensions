import assert from "node:assert/strict";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { initTheme, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeAll, test } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { showAccountsMenu } from "../src/account-menu.js";
import { startupAccount } from "../src/account-store.js";
import accountsExtension, { AccountStore } from "../src/accounts.js";
import { type AccountProviderAdapter, createBuiltinProviderAdapters } from "../src/oauth.js";
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

async function startSession(store: AccountStore, random: number, manager = SessionManager.inMemory(process.cwd())) {
  const mock = createMockPi();
  accountsExtension(mock.pi, { store, providers: [openai], random: () => random });
  const registry = new ModelRegistry(
    await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false }),
  );
  const { ctx } = createMockContext({
    sessionManager: manager,
    modelRegistry: registry,
    model: { provider: "openai", id: "gpt-4o" },
  });
  await mock.events.get("session_start")?.[0]?.({}, ctx);
  await mock.events.get("before_agent_start")?.[0]?.({}, ctx);
  return { manager, apiKey: await registry.getApiKeyForProvider("openai") };
}

test("a random default spreads new sessions across accounts while forks keep their parent's", async () => {
  // Two ChatGPT subscriptions, with the OpenAI default set to "Any account (random)".
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("openai", () => ({
    randomDefault: true,
    accounts: { personal: credential("personal"), work: credential("work") },
  }));

  // Each new session rolls independently, so over time both subscriptions carry load.
  const first = await startSession(store, 0);
  const second = await startSession(store, 0.99);
  assert.equal(first.apiKey, "access-personal");
  assert.equal(second.apiKey, "access-work");

  // A fork copies its parent's entries. Re-rolling there would move an ongoing conversation to
  // another account, so it keeps the parent's choice even when the roll says otherwise.
  const fork = SessionManager.inMemory(process.cwd());
  for (const entry of first.manager.getEntries()) {
    if (entry.type === "custom" && entry.customType === ACCOUNT_SELECTION_ENTRY_TYPE) {
      fork.appendCustomEntry(entry.customType, entry.data);
    }
  }
  assert.equal((await startSession(store, 0.99, fork)).apiKey, "access-personal");

  // The roll is a session choice; the saved default stays random rather than pinning an account.
  const saved = await store.readProviderAsync("openai");
  assert.equal(saved.randomDefault, true);
  assert.equal(saved.active, undefined);
});

test("choosing Any account (random) in /accounts replaces a pinned default, and a named choice clears it", async () => {
  const store = new AccountStore(new InMemoryAccountStorageBackend());
  await store.updateProvider("anthropic", () => ({
    active: "alpha",
    accounts: { alpha: credential("alpha"), beta: credential("beta") },
  }));
  const adapters = new Map(createBuiltinProviderAdapters().map((adapter) => [adapter.id, adapter]));
  const handlers = {
    login: async () => assert.fail("unexpected login"),
    switch: async () => assert.fail("unexpected switch"),
    remove: async () => assert.fail("unexpected remove"),
  };
  const owner = { signal: new AbortController().signal, isCurrent: () => true };
  const choose = async (account: string) => {
    const choices = ["Set default account", "Anthropic", account];
    const { ctx, notifications } = createMockContext({ mode: "rpc", hasUI: true, select: async () => choices.shift() });
    await showAccountsMenu(ctx, store, adapters, { selections: { anthropic: "alpha" } }, handlers, owner);
    return notifications.at(-1)?.message ?? "";
  };

  assert.match(await choose("Any account (random)"), /Any account \(random\)/);
  assert.deepEqual(
    { active: store.read().providers.anthropic?.active, random: store.read().providers.anthropic?.randomDefault },
    { active: undefined, random: true },
  );

  await choose("beta");
  assert.deepEqual(
    { active: store.read().providers.anthropic?.active, random: store.read().providers.anthropic?.randomDefault },
    { active: "beta", random: undefined },
  );
});

test("startupAccount falls back predictably at the edges", () => {
  const accounts = { personal: credential("personal"), work: credential("work") };
  const pick = (state: Parameters<typeof startupAccount>[0], inherited?: string | null) =>
    startupAccount(state, inherited, () => 0.99);
  assert.equal(pick({ active: "work", accounts }), "work", "a pinned default ignores the roll");
  assert.equal(pick({ accounts }), null, "no default means Pi's built-in login");
  assert.equal(pick({ randomDefault: true, accounts: {} }), null, "nothing to pick from");
  assert.equal(pick({ randomDefault: true, accounts }, "removed"), "work", "a parent account that is gone re-rolls");
  assert.equal(pick({ randomDefault: true, accounts }, null), "work", "a parent on Pi's login still rolls");
  assert.equal(pick(undefined), null);
});
