/**
 * The agent-host registry (AGENT_SHELL_PLAN, Wave 2 / AS-5) — the FRONTEND
 * counterpart of the backend agent-kind registry
 * (`services/api/src/domain/agent/agent-kind-registry.ts`): an
 * insertion-ordered Map of per-kind host descriptors, `registerAgentHost()`
 * returning an UNSUBSCRIBE, and a typed getter. Host modules self-register at
 * module init; the composition root side-effect-imports each built-in host
 * module so the registry is populated at startup (AS-6 wires the experience
 * host).
 *
 * A host descriptor is everything the generic agent shell needs to render a
 * kind WITHOUT kind-switches: the i18n KEY table (keys, not strings — the
 * shell resolves them through `useT`), the buffer specs, the transport
 * (every send/observe API call, AS-6c-i), the optional editor
 * pane (absent = chat-only host), the send-options builder, the optional
 * toolbar/mobile slots, and the per-recordType fallback-card renderers for
 * record proposals.
 */
import type { ComponentType, ReactNode } from "react";
import type { RecordProposal } from "@vibe-tavern/api-contracts";
import type Resources from "../i18n/resources.js";
// AS-6c-i: type-only — the transport members mirror today's experience client
// fns exactly (the compiler keeps the host's delegation honest), so the
// generic shell/controller never import the kind-specific client. No runtime
// edge: these imports are erased.
import type {
  activateExperienceCopilotSession,
  answerCopilotAsk,
  getExperienceCopilotActive,
  listExperienceCopilotMessages,
  listExperienceCopilotSessions,
  renameExperienceCopilotSession,
  setExperienceCopilotContextLinks,
  startExperienceCopilotSession,
  streamExperienceCopilot,
} from "../api/experience-copilot-api.js";

/** A host tried to register under a kind that is already taken. */
export class AgentHostAlreadyRegisteredError extends Error {
  readonly code = "AGENT_HOST_ALREADY_REGISTERED";
  constructor(readonly kind: string) {
    super(`Agent host "${kind}" is already registered.`);
    this.name = "AgentHostAlreadyRegisteredError";
  }
}

/** No host is registered under the requested kind. */
export class UnknownAgentHostError extends Error {
  readonly code = "UNKNOWN_AGENT_HOST";
  constructor(readonly kind: string) {
    super(`No agent host registered under "${kind}".`);
    this.name = "UnknownAgentHostError";
  }
}

/**
 * The minimal-plus-live context a host descriptor receives. AS-5 shipped
 * only { ownerId, scriptId } (deliberately narrow); AS-6b2 grew it with the
 * live thread/streaming state and the shell↔host bridge the split shell
 * needs — hosts still receive, they never construct it.
 */
export interface AgentHostContext {
  ownerId: string;
  scriptId?: string;
  /** AS-6b2: the live thread the shell renders (null while the session
   *  loads) — buffer hosts key review rounds and draft persistence by it. */
  threadId: string | null;
  /** AS-6b2: true while the host's turn is streaming — freeze/lock
   *  affordances and the review-enable gate read it. */
  isSending: boolean;
  /** AS-6b2: the wrapper's host-specific props, opaque to the shell — the
   *  host narrows the type at its own boundary (wrapper and host are a
   *  pair; the shell only forwards). */
  hostProps?: unknown;
  /** AS-6b2: the live shell↔host bridge — the host's editor pane registers
   *  its session handle here, host surfaces prefill the chat input. */
  bridge: AgentHostBridge;
}

/** One named buffer the host's editor pane edits (label resolved via i18n). */
export interface AgentHostBufferSpec {
  id: string;
  labelKey: AgentI18nKey;
  language: string;
}

/**
 * AS-6b2: the live handle a host's editor pane assigns to
 * {@link AgentHostBridge.session} every render. `onBeforeSend` runs
 * synchronously before each dispatched turn (the buffer host captures its
 * dangling review before the turn store is cleared); `buildSendOptions`
 * returns the host's per-turn send options. The concrete options type is
 * transport-owned (`AgentSendOptions` in use-agent-controller.ts) and stays
 * opaque here until AS-6c-ii's kind parameter unifies it with the transport's
 * wire types.
 */
export interface AgentHostSessionHandle {
  onBeforeSend: () => void;
  buildSendOptions: () => unknown;
}

/**
 * AS-6b2: the stable mutable bridge the shell owns and hands the host through
 * {@link AgentHostContext}. The host's editor pane assigns `session` during
 * its render (latest-render closures — the same ref pattern the shell's
 * capture-dangling code already used); the shell reads it at send time.
 * `setInputPrefill` hands text from a host surface (e.g. a "send to
 * copilot" button) to the chat input — object identity is the trigger.
 */
export interface AgentHostBridge {
  session: AgentHostSessionHandle | null;
  setInputPrefill: (prefill: { text: string } | null) => void;
}

/** Props a per-recordType record-proposal renderer receives. */
export interface RecordProposalCardProps {
  proposal: RecordProposal;
}

/**
 * AS-6c-i: the TRANSPORT seam — every API call the generic shell and its
 * controller make to send and observe agent turns, so neither imports a
 * kind-specific client. Each member's type mirrors the experience client fn
 * it delegates to today (`api/experience-copilot-api.ts`), which makes the
 * host's delegation compiler-checked — until AS-6c-ii's kind parameter +
 * type unification generalize these behind per-kind wire types.
 */
export interface AgentHostTransport {
  /** Stream one agent turn for a thread (the send path). */
  sendStream: typeof streamExperienceCopilot;
  /** Answer a pending `ask_user` question — the split-turn continuation
   *  (no new user row; the answer replaces the awaiting tool-result row). */
  answerAsk: typeof answerCopilotAsk;
  /** The single active thread for an owner, or null when none exists. */
  getActiveThread: typeof getExperienceCopilotActive;
  /** All messages for a thread, oldest → newest. */
  listMessages: typeof listExperienceCopilotMessages;
  /** Archive the current active thread (if any) and start a fresh one. */
  startSession: typeof startExperienceCopilotSession;
  /** All sessions (active + archived) for an owner, newest first. */
  listSessions: typeof listExperienceCopilotSessions;
  /** Resume an archived session (archiving its active sibling, if any), or
   *  a no-op when already active. Null when the thread does not exist. */
  activateSession: typeof activateExperienceCopilotSession;
  /** Rename a session (empty title clears to the auto-numbered fallback).
   *  Null when the thread does not exist. */
  renameSession: typeof renameExperienceCopilotSession;
  /** Full-replace a thread's pinned-context links (max 64, schema-enforced). */
  setContextLinks: typeof setExperienceCopilotContextLinks;
}

/**
 * AS-6c-i: re-exported so the controller (and any transport consumer) types
 * its stream callbacks and ask answers through the registry instead of the
 * experience client — the single spelling stays the client's until AS-6c-ii
 * unifies the wire types behind the kind parameter.
 */
export type { CopilotAskAnswerInput, CopilotStreamOpts } from "../api/experience-copilot-api.js";

/** A strict i18n key — the generated en-locale union (`i18n/resources`), so a
 *  typo'd key in a host descriptor is a compile error, same as a literal `t()`
 *  call. The descriptor fields below carry KEYS, never translated strings. */
export type AgentI18nKey = keyof Resources["en"];

/** Everything the generic shell needs to host one agent kind. */
export interface AgentHostDescriptor {
  kind: string;
  /** i18n KEYS (not strings) — the shell resolves them through `useT`. */
  i18n: {
    title: AgentI18nKey;
    subtitle?: AgentI18nKey;
    placeholder: AgentI18nKey;
    loading: AgentI18nKey;
    emptyTitle: AgentI18nKey;
    emptySub: AgentI18nKey;
    /** AS-6b2: the mobile tab-row back chevron's aria-label key. Optional —
     *  a host that omits it renders no chevron even when `onBack` is passed
     *  (the chevron is folded into the tab-bar row, which a chat-only host
     *  does not render at all). */
    mobileBackLabelKey?: AgentI18nKey;
  };
  bufferSpecs: AgentHostBufferSpec[];
  /** AS-6c-i: the transport — the send/observe API seam. Every agent-turn
   *  call the shell (session load/switch/new/rename, context pins, message
   *  refetch) and the controller (stream + ask-answer) make goes through
   *  here, so the generic modules never import a kind-specific client. */
  transport: AgentHostTransport;
  /** Absent = chat-only host (no editor pane). */
  renderEditorPane?: (ctx: AgentHostContext) => ReactNode;
  /** The per-turn send options. AS-6b2: returns `unknown` — the live options
   *  come from the host session via `ctx.bridge` (the descriptor is a module
   * constant and cannot close over component state); the shell narrows the
   * result to the controller's AgentSendOptions at the send seam. */
  buildSendOptions: (ctx: AgentHostContext) => unknown;
  toolbarSlot?: (ctx: AgentHostContext) => ReactNode;
  mobileEditTabHeader?: (ctx: AgentHostContext) => ReactNode;
  recordProposalRenderers: Record<string, ComponentType<RecordProposalCardProps>>;
}

// Insertion-ordered: registration order is the documented precedence for any
// future first-match resolution over kinds.
const hosts = new Map<string, AgentHostDescriptor>();

/**
 * Register one agent host. Throws {@link AgentHostAlreadyRegisteredError} on
 * a duplicate kind. Returns an UNSUBSCRIBE that removes THIS registration (a
 * later re-registration under the same kind survives a stale unsubscribe
 * call — the guard compares the stored descriptor by identity) — this is the
 * cleanup seam tests use; there is no registry reset.
 */
export function registerAgentHost(descriptor: AgentHostDescriptor): () => void {
  if (hosts.has(descriptor.kind)) throw new AgentHostAlreadyRegisteredError(descriptor.kind);
  hosts.set(descriptor.kind, descriptor);
  return () => {
    if (hosts.get(descriptor.kind) === descriptor) hosts.delete(descriptor.kind);
  };
}

/** The registered host under `kind` — {@link UnknownAgentHostError} if absent. */
export function getAgentHost(kind: string): AgentHostDescriptor {
  const host = hosts.get(kind);
  if (host === undefined) throw new UnknownAgentHostError(kind);
  return host;
}
