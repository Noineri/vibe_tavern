/**
 * The agent-kind registry — the single table routes resolve agent kinds
 * through (AGENT_SHELL_PLAN, Wave 1 / AS-2a). Mirrors the house
 * registry pattern (cf. apps/web build-panel-registry): a descriptor type, a
 * `register*()` returning an UNSUBSCRIBE, and getters. Kind modules
 * self-register at module init (see kinds/experience-kind.ts); the
 * composition root (server-runtime.ts) side-effect-imports each built-in kind
 * module so the registry is populated at startup.
 *
 * The script-kind → agent-kind mapping lives in the DATA the kinds register
 * (`servesScriptKinds`) — never in a switch here or in a route. Registering a
 * second kind for the same script kind: the FIRST registered wins (Map
 * insertion order); built-ins register at import time, so tests may observe
 * them and their own later registration of an overlapping fake wins nothing —
 * keep test fakes off served-by-built-in script kinds unless the overlap is
 * the point.
 */

import type { AgentKind, AgentKindId } from "./agent-kind.js";
import type { ChatMode, ScriptKind } from "@vibe-tavern/domain";

/** A kind module tried to register under an id that is already taken. */
export class AgentKindAlreadyRegisteredError extends Error {
  readonly code = "AGENT_KIND_ALREADY_REGISTERED";
  constructor(readonly kindId: AgentKindId) {
    super(`Agent kind "${kindId}" is already registered.`);
    this.name = "AgentKindAlreadyRegisteredError";
  }
}

/** No kind is registered under the requested id. */
export class UnknownAgentKindError extends Error {
  readonly code = "UNKNOWN_AGENT_KIND";
  constructor(readonly kindId: AgentKindId) {
    super(`No agent kind registered under "${kindId}".`);
    this.name = "UnknownAgentKindError";
  }
}

/** No registered kind serves the requested script kind. */
export class NoAgentKindForScriptKindError extends Error {
  readonly code = "NO_AGENT_KIND_FOR_SCRIPT_KIND";
  constructor(readonly scriptKind: ScriptKind) {
    super(`No agent kind serves script kind "${scriptKind}".`);
    this.name = "NoAgentKindForScriptKindError";
  }
}

/** The kind IS registered, but the copilot adapter has no wiring-table entry
 *  for it — unlike {@link UnknownAgentKindError} (no kind registered under
 *  the id at all), this is a server wiring bug: a kind module registered, yet
 *  the adapter was never given the matching stream or compaction entry. The
 *  `table` field names which table is missing. */
export class AgentKindNotWiredError extends Error {
  readonly code = "AGENT_KIND_NOT_WIRED";
  constructor(readonly kindId: AgentKindId, readonly table: "stream" | "compaction") {
    super(`Agent kind "${kindId}" is registered but has no ${table} wiring in the copilot adapter.`);
    this.name = "AgentKindNotWiredError";
  }
}

/** The kind IS registered, but its threads are not chat-owned
 *  (`owner !== "chat"`, SC-0b) — the chat-owner lifecycle routes reject it
 *  with a 400 instead of silently serving a script-derived kind under a
 *  chat-branch path (its kind could never be stored on a thread row). */
export class AgentKindNotChatOwnedError extends Error {
  readonly code = "AGENT_KIND_NOT_CHAT_OWNED";
  constructor(readonly kindId: AgentKindId) {
    super(`Agent kind "${kindId}" is not chat-owned.`);
    this.name = "AgentKindNotChatOwnedError";
  }
}

/** A chat-owned kind does not serve the chat's MODE (SC-7b, owner decision
 *  8: RP chats only) — the session-create route rejects the pair with a 400
 *  naming both the kind and the mode. Thrown by
 *  {@link requireKindServesChatMode}; the reads on such a chat answer empty
 *  instead (they filter through {@link kindServesChatMode}, never throw). */
export class AgentKindModeNotServedError extends Error {
  readonly code = "AGENT_KIND_MODE_NOT_SERVED";
  constructor(readonly kindId: AgentKindId, readonly mode: ChatMode) {
    super(`Agent kind "${kindId}" does not serve chat mode "${mode}".`);
    this.name = "AgentKindModeNotServedError";
  }
}

// Insertion-ordered: registration order is the documented precedence for
// resolveKindForScript.
const kinds = new Map<AgentKindId, AgentKind>();
/**
 * Register one agent kind. Throws
 * {@link AgentKindAlreadyRegisteredError} on a duplicate id. Returns an
 * UNSUBSCRIBE that removes THIS registration (a later re-registration under
 * the same id survives a stale unsubscribe call) — this is the cleanup seam
 * tests use; there is no registry reset.
 */
export function registerAgentKind(kind: AgentKind): () => void {
  if (kinds.has(kind.id)) throw new AgentKindAlreadyRegisteredError(kind.id);
  kinds.set(kind.id, kind);
  return () => {
    if (kinds.get(kind.id) === kind) kinds.delete(kind.id);
  };
}

/** The registered kind under `id` — {@link UnknownAgentKindError} if absent. */
export function getAgentKind(id: AgentKindId): AgentKind {
  const kind = kinds.get(id);
  if (kind === undefined) throw new UnknownAgentKindError(id);
  return kind;
}

/** All registered kinds in registration order — the enumeration seam for
 *  consumers that need EVERY kind (e.g. the bootstrap payload's per-kind
 *  settings map, SC-0d). A copy, so callers cannot mutate the registry
 *  through it. */
export function listAgentKinds(): readonly AgentKind[] {
  return [...kinds.values()];
}

/**
 * Typed kind getter (AS-2b): same lookup as {@link getAgentKind}, but returns
 * `AgentKind<CTX>` so call sites (e.g. the generic assembly calling
 * `renderContextPackage`) pass the kind's own ctx shape WITHOUT casting. The
 * ctx stays opaque to the registry — the type argument is the CALLER's
 * assertion of the kind's declared ctx, exactly like the descriptor the kind
 * registered.
 */
export function getAgentKindOf<CTX>(id: AgentKindId): AgentKind<CTX> {
  return getAgentKind(id);
}

/**
 * Resolve a kind for the CHAT-OWNER lifecycle (SC-0b): the registered kind
 * must exist AND own its threads (`owner: "chat"`). Throws
 * {@link UnknownAgentKindError} / {@link AgentKindNotChatOwnedError} — the
 * chat-owner routes map both to a 400. The owner check lives here, beside
 * the data it reads, so no route or adapter holds a second kind-classification
 * of its own.
 */
export function getChatOwnedAgentKind(id: AgentKindId): AgentKind {
  const kind = getAgentKind(id);
  if (kind.owner !== "chat") throw new AgentKindNotChatOwnedError(id);
  return kind;
}

/** Whether a kind serves a chat mode — the ONE predicate over the
 *  descriptor's `servesChatModes` (SC-7b). The create path wraps it in
 *  {@link requireKindServesChatMode}; the read paths branch on this boolean
 *  and answer empty, so a chat whose mode changed after its sessions were
 *  born reads consistently (no session listable, none active) while its
 *  rows stay intact for the day the mode returns. */
export function kindServesChatMode(kind: AgentKind, mode: ChatMode): boolean {
  return kind.servesChatModes.includes(mode);
}

/** The create-path guard over {@link kindServesChatMode}: a chat-owned kind
 *  that does not serve the chat's mode throws
 *  {@link AgentKindModeNotServedError} (the route maps it to the shared 400
 *  `{ error, code }` shape naming the kind and the mode). Lives here, beside
 *  the data it reads, so no adapter or route holds a second copy of the
 *  mode-membership comparison. */
export function requireKindServesChatMode(kind: AgentKind, mode: ChatMode): void {
  if (!kindServesChatMode(kind, mode)) throw new AgentKindModeNotServedError(kind.id, mode);
}

/**
 * Resolve the agent kind serving a script kind — the ONLY sanctioned mapping
 * seam (routes call this, AS-2c; they never hold kind maps of their own).
 * Returns the first REGISTERED kind whose `servesScriptKinds` contains
 * `scriptKind`; throws {@link NoAgentKindForScriptKindError} when none does
 * (the route-side translation to HTTP 400 comes with AS-2c).
 */
export function resolveKindForScript(scriptKind: ScriptKind): AgentKind {
  for (const kind of kinds.values()) {
    if (kind.servesScriptKinds.includes(scriptKind)) return kind;
  }
  throw new NoAgentKindForScriptKindError(scriptKind);
}
