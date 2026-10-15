import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { AgentBeforeSettleEvent, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AccountStore, AccountsData } from "./account-store.js";
import type { PersistSelection, SessionSelectionOwner, SyncProvider } from "./accounts.js";
import type { AccountProviderAdapter, AccountProviderId } from "./oauth.js";

// A spent account usually recovers after hours, but a cooldown only spares later requests in this
// process; the per-prompt attempt list is what keeps one prompt from looping.
export const ROTATION_COOLDOWN_MS = 15 * 60_000;

// Errors another account of the same provider can plausibly avoid: quota, usage, and rate limits.
// Auth failures are excluded because pi-accounts fails a broken credential closed by design, and
// provider-wide overload or outages would fail on every account.
const LIMIT_ERROR_PATTERN = /usage.?limit|quota|rate.?limit|too many requests|\b429\b/i;

export type RotationSettings = { enabled: boolean };

export function readRotationSettings(data: AccountsData): RotationSettings {
  const rotation = data.rotation;
  return {
    enabled: !!rotation && typeof rotation === "object" && (rotation as { enabled?: unknown }).enabled === true,
  };
}

export function setRotationEnabled(data: AccountsData, enabled: boolean): AccountsData {
  const current = data.rotation && typeof data.rotation === "object" ? data.rotation : {};
  return { ...data, rotation: { ...current, enabled } };
}

export function isRotatableFailure(message: Pick<AssistantMessage, "stopReason" | "errorMessage">): boolean {
  return message.stopReason === "error" && LIMIT_ERROR_PATTERN.test(message.errorMessage ?? "");
}

/** The next saved account after `failed`, skipping accounts already tried for this prompt or cooling down. */
export function pickNextAccount(options: {
  names: readonly string[];
  failed: string;
  attempted: ReadonlySet<string>;
  coolingUntil: (name: string) => number | undefined;
  now: number;
}): string | undefined {
  const names = [...options.names].sort();
  const start = names.indexOf(options.failed);
  const ordered = [...names.slice(start + 1), ...names.slice(0, Math.max(start, 0))];
  return ordered.find((name) => {
    if (name === options.failed || options.attempted.has(name)) return false;
    const until = options.coolingUntil(name);
    return until === undefined || until <= options.now;
  });
}

type RotationDependencies = {
  store: AccountStore;
  adapters: ReadonlyMap<AccountProviderId, AccountProviderAdapter>;
  getOwner(sessionManager: ExtensionContext["sessionManager"]): SessionSelectionOwner | undefined;
  isOwnerCurrent(owner: SessionSelectionOwner): boolean;
  persistSelection: PersistSelection;
  syncProvider: SyncProvider;
  now?: () => number;
};

type SessionRotationState = {
  // The named account each provider's latest request used, so a failure is blamed on the account
  // that produced it even if the selection changed afterwards.
  requestAccounts: Map<AccountProviderId, string>;
  // Accounts tried for the current user prompt; a new prompt starts over.
  attempted: Map<AccountProviderId, Set<string>>;
};

export function registerAccountRotation(pi: ExtensionAPI, dependencies: RotationDependencies): void {
  const { store, adapters, getOwner, isOwnerCurrent, persistSelection, syncProvider } = dependencies;
  const now = dependencies.now ?? Date.now;
  const cooldowns = new Map<string, number>();
  const sessions = new WeakMap<SessionSelectionOwner, SessionRotationState>();
  const stateFor = (owner: SessionSelectionOwner): SessionRotationState => {
    let state = sessions.get(owner);
    if (!state) {
      state = { requestAccounts: new Map(), attempted: new Map() };
      sessions.set(owner, state);
    }
    return state;
  };
  const toProviderId = (value: string | undefined): AccountProviderId | undefined =>
    value && adapters.has(value as AccountProviderId) ? (value as AccountProviderId) : undefined;

  pi.on("before_agent_start", (_event, ctx) => {
    const owner = getOwner(ctx.sessionManager);
    if (owner) stateFor(owner).attempted.clear();
  });

  pi.on("turn_start", (_event, ctx) => {
    const owner = getOwner(ctx.sessionManager);
    const providerId = toProviderId(ctx.model?.provider);
    if (!owner || !providerId) return;
    const result = owner.results.get(providerId);
    const state = stateFor(owner);
    if (result?.status === "active") state.requestAccounts.set(providerId, result.accountName);
    else state.requestAccounts.delete(providerId);
  });

  pi.on("agent_before_settle", async (event, ctx) => {
    const owner = getOwner(ctx.sessionManager);
    if (!owner || !isOwnerCurrent(owner) || !event.context.canContinue) return;
    // PI_ACCOUNT pins one account for the whole process.
    if (owner.environmentAccount !== undefined || owner.environmentError !== undefined) return;
    const failure = latestFailedReply(event);
    const providerId = toProviderId(failure?.message.provider);
    if (!failure || !providerId || providerId !== ctx.model?.provider) return;
    if (!isRotatableFailure(failure.message)) return;
    const state = stateFor(owner);
    // Only named accounts rotate; Pi's built-in login is not part of the saved pool.
    const failed = state.requestAccounts.get(providerId);
    if (!failed) return;

    let data: AccountsData;
    try {
      data = await store.readAsync(owner.signal);
    } catch {
      return;
    }
    if (!isOwnerCurrent(owner) || !readRotationSettings(data).enabled) return;

    const adapter = adapters.get(providerId);
    const displayName = adapter?.displayName ?? providerId;
    const at = now();
    cooldowns.set(cooldownKey(providerId, failed), at + ROTATION_COOLDOWN_MS);
    const attempted = state.attempted.get(providerId) ?? new Set<string>();
    attempted.add(failed);
    state.attempted.set(providerId, attempted);
    const next = pickNextAccount({
      names: Object.keys(data.providers[providerId]?.accounts ?? {}),
      failed,
      attempted,
      coolingUntil: (name) => cooldowns.get(cooldownKey(providerId, name)),
      now: at,
    });
    if (!next) {
      notify(ctx, `${displayName} account "${failed}" hit a limit and no other saved account is available.`, "warning");
      return;
    }

    // A manual switch that lands while this runs wins; rotation never overwrites it.
    const revision = owner.selectionRevisions.get(providerId) ?? 0;
    const unchanged = () => (owner.selectionRevisions.get(providerId) ?? 0) === revision;
    let persisted: boolean;
    try {
      persisted = persistSelection(owner, providerId, next, unchanged);
    } catch {
      persisted = false;
    }
    if (!persisted) return;
    const result = await syncProvider(providerId, ctx, owner);
    if (!isOwnerCurrent(owner)) return;
    if (result.status !== "active" || result.accountName !== next) {
      notify(
        ctx,
        `${displayName} account "${failed}" hit a limit, but switching to "${next}" failed; requests will fail closed until you choose an account in /accounts.`,
        "error",
      );
      return;
    }
    state.requestAccounts.set(providerId, next);
    notify(
      ctx,
      `${displayName} account "${failed}" hit a limit. Switched this session to "${next}" and retrying.`,
      "info",
    );
    return {
      entries: [{ type: "context_edit" as const, targetId: failure.entryId, replacement: null }],
      continue: true,
    };
  });
}

function latestFailedReply(event: AgentBeforeSettleEvent): { entryId: string; message: AssistantMessage } | undefined {
  const entries = event.context.contextEntries;
  let index = entries.length - 1;
  while (index >= 0 && entries[index]?.messages.length === 0) index -= 1;
  const source = entries[index]?.sourceEntry;
  if (source?.type !== "message" || source.message.role !== "assistant") return undefined;
  return { entryId: source.id, message: source.message };
}

function cooldownKey(providerId: AccountProviderId, accountName: string): string {
  return `${providerId}/${accountName}`;
}

function notify(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
  try {
    ctx.ui.notify(message, level);
  } catch {
    // A replaced session's UI must not break settlement.
  }
}
