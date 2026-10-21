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
import type {
  AgentReviewSnapshot,
  ExperienceCopilotLaunchContext,
  ExperienceCopilotStep,
  ExperienceCopilotThreadWire,
  RecordProposal,
} from "@vibe-tavern/api-contracts";
import type { AgentPlanOwner, AgentThreadOwner } from "@vibe-tavern/domain";
import type Resources from "../i18n/resources.js";
import type { AgentToolActivity } from "../stores/agent-turn-store.js";
import type { ProviderProfileRecord } from "../api/types.js";
// AS-6c-i: type-only — the thread-scoped transport members mirror today's
// experience client fns exactly (the compiler keeps the host's delegation
// honest), so the generic shell/controller never import the kind-specific
// client. No runtime edge: these imports are erased. (The three owner-scoped
// lifecycle members take the typed owner instead — SC-0c.)
import type {
  activateExperienceCopilotSession,
  answerCopilotAsk,
  listExperienceCopilotMessages,
  renameExperienceCopilotSession,
  setExperienceCopilotContextLinks,
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
 * The agent-kind id. Today only `"experience"` is registered (the
 * experience host in `build/editors/copilot/experience-agent-host.tsx`); a
 * second kind arrives in AS-7+. A plain string alias — the registry keys
 * hosts by it, and the agent stores qualify their per-thread map keys
 * through {@link agentThreadKey}.
 */
export type AgentKind = string;

/**
 * The per-kind store key for an agent thread (AS-6c-ii, decision AS-5/
 * Option A: the kind parameter lands atomically with this helper and the
 * selector migration — never in a commit where store keys are still bare).
 *
 * PERSISTENCE CONTRACT: neither agent store uses zustand `persist`, but the
 * experience draft envelope (`lib/experience-copilot-draft.ts`,
 * `vt:experience-copilot-draft:<threadId>`, v2) persists per-thread review
 * state in localStorage under the LEGACY BARE threadId. Returning a prefixed
 * key for `"experience"` would orphan every pre-6c-ii draft (silent data
 * loss with zero migration code), so the experience kind keeps the bare
 * threadId and only later kinds are namespaced (`${kind}:${threadId}`).
 * Server-side keys (API/DB) stay bare always — only the in-client store
 * maps re-key.
 *
 * Single source (DRY): both agent stores and every selector call site key
 * through this function — no second hand-written derivation.
 */
export function agentThreadKey(kind: AgentKind, threadId: string): string {
  return kind === "experience" ? threadId : `${kind}:${threadId}`;
}

/**
 * The logical-identity key of a thread owner (SC-0c) — the shell's session
 * effects depend on THIS string, never on the owner object's identity, so a
 * fresh-but-equal owner literal (a wrapper re-render, a new snapshot-store
 * object) never refetches the session. Server-issued threadIds are globally
 * unique, so equal keys always mean the same owner; two branches never share
 * client state through `agentThreadKey` either way.
 */
export function agentOwnerKey(owner: AgentThreadOwner): string {
  return owner.kind === "script"
    ? `script:${owner.scriptId}`
    : `chat:${owner.chatId}:${owner.branchId}:${owner.agentKind}`;
}

/**
 * SC-0c: the one-line map-back — script-owned hosts narrow the typed owner
 * to the script id their client fns take. A chat owner here is a wiring bug
 * (the sidechat host is the chat-owned one — SC-13b), so it throws instead
 * of silently serving the wrong owner's threads.
 */
export function scriptOwnerId(owner: AgentThreadOwner): string {
  if (owner.kind !== "script") throw new Error(`Agent host cannot serve a chat-owned thread (kind "${owner.agentKind}")`);
  return owner.scriptId;
}

/**
 * SC-13b: the one-line map-back for chat-owned hosts — the twin of
 * {@link scriptOwnerId}. A script owner here is a wiring bug, so it throws
 * instead of silently serving the wrong owner's threads.
 */
export function chatOwnerTriple(owner: AgentThreadOwner): { chatId: string; branchId: string; agentKind: string } {
  if (owner.kind !== "chat") throw new Error(`Agent host cannot serve a script-owned thread (script "${owner.scriptId}")`);
  return { chatId: owner.chatId, branchId: owner.branchId, agentKind: owner.agentKind };
}

/**
 * Live draft buffers + active authoring step to send with an agent message
 * (AS-6c-ii: moved here from use-agent-controller.ts — lib importing a
 * components module is banned, which is what forced the shell's
 * `as AgentSendOptions` cast; the controller re-exports this type for
 * compatibility). The model sees the current (possibly unsaved) source and
 * knows which buffer the user is editing.
 */
export interface AgentSendOptions {
  rules?: string;
  visual?: string;
  /** AS-8b — the script kind's single LIVE `code` buffer (the merged draft the
   *  editor shows; never a stale DB read). */
  code?: string;
  /** AS-8b — the script's runtime kind, sent on the body as advisory
   *  telemetry (the STORED script kind is authoritative server-side). */
  scriptKind?: "prompt" | "dice";
  /** AS-8b — whether the `code` buffer is saved (mirrors rulesSaved). */
  codeSaved?: boolean;
  step?: ExperienceCopilotStep;
  /** AS-8e3 — the script panel's current character/persona at send time.
   *  Carried on the body so the backend renders their full cards (the old
   *  modal's scopeContext parity); absent = not sent. */
  contextCharacterId?: string;
  /** AS-8e3 — the script panel's current persona at send time (absent when
   *  the panel has none). */
  contextPersonaId?: string;
  /** The latest test/simulate digest the user sent back from the test panel
   *  (ER-14). Carried on the body as `testFeedback` and rendered as a JSON
   *  context section by the backend (surviving history compaction). */
  testFeedback?: Record<string, unknown> | null;
  /** Latest Try-panel execution context; backend tools use it verbatim. */
  launchContext?: ExperienceCopilotLaunchContext;
  reviewSnapshot?: AgentReviewSnapshot;
  rulesSaved?: boolean;
  visualSaved?: boolean;
  /** SC-18 — RP variants attached to this turn as plain (messageId,
   *  variantId) pairs (wire twin of the api-contracts `attachedVariants`;
   *  the pair carries NO selected marker — the server reads the RP's own
   *  selection at freeze time, the schema rejects anything else). Only the
   *  `sidechat-ooc` kind reads the field; the other kinds ignore it. */
  attachedVariants?: { messageId: string; variantId: string }[];
}

/**
 * The minimal-plus-live context a host descriptor receives. AS-5 shipped
 * only { ownerId, scriptId } (deliberately narrow); SC-0c typed the owner
 * ({ owner, scriptId }); AS-6b2 grew it with the
 * live thread/streaming state and the shell↔host bridge the split shell
 * needs — hosts still receive, they never construct it.
 */
export interface AgentHostContext {
  /** SC-0c: the typed thread owner — hosts narrow it back to a script id in
   *  one line (`scriptOwnerId`) where their client fns need one. */
  owner: AgentThreadOwner;
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
 * returns the host's per-turn send options (AS-6c-ii: typed — the options
 * type lives in this registry now, so no narrowing cast is needed).
 */
export interface AgentHostSessionHandle {
  onBeforeSend: () => void;
  buildSendOptions: () => AgentSendOptions;
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

/** Props a per-recordType record-proposal renderer receives. SC-13a: the card
 *  resolves against its thread (accept/reject land in SC-13c), so the thread
 *  id rides the props — the fallback ignores it until then. */
export interface RecordProposalCardProps {
  proposal: RecordProposal;
  threadId: string;
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
  /** The single active thread for an owner, or null when none exists.
   *  SC-0c: takes the typed owner (chat owners route to the SC-0b client,
   *  script owners map back to the script id in one line). */
  getActiveThread: (owner: AgentThreadOwner) => Promise<ExperienceCopilotThreadWire | null>;
  /** All messages for a thread, oldest → newest. */
  listMessages: typeof listExperienceCopilotMessages;
  /** Archive the current active thread (if any) and start a fresh one. */
  startSession: (owner: AgentThreadOwner, title?: string) => Promise<ExperienceCopilotThreadWire>;
  /** All sessions (active + archived) for an owner, newest first. */
  listSessions: (owner: AgentThreadOwner) => Promise<ExperienceCopilotThreadWire[]>;
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
 * The context a host's optional model default sees (SIDECHAT_PLAN SC-0e).
 * The shell validates the proposal (a dangling profile id falls through),
 * so the hook only proposes — it never touches the network and must stay pure.
 */
export interface AgentDefaultModelContext {
  /** The typed thread owner the shell renders for. */
  owner: AgentThreadOwner;
  /** The currently available provider profiles (for proposal-time checks). */
  profiles: ProviderProfileRecord[];
}

/**
 * The context a host's optional plan owner sees (SIDECHAT_PLAN SC-0i) — the
 * typed thread owner the shell renders for. Narrow on purpose (the
 * SC-0e `AgentDefaultModelContext` precedent): plan ownership derives from
 * the owner alone — thread/session state is irrelevant, and the hook must
 * stay pure (it runs on every shell render, before the session loads).
 */
export interface AgentPlanOwnerContext {
  /** The typed thread owner the shell renders for. */
  owner: AgentThreadOwner;
}

/**
 * One host-proposed model binding (SIDECHAT_PLAN SC-0e) — the provider the
 * kind prefers plus, optionally, the model on it. Both ids are validated
 * against the live lists by the shell; unknown ids are ignored.
 */
export interface AgentDefaultModelBinding {
  providerProfileId: string;
  modelName?: string | null;
}

/**
 * AS-6c-i: re-exported so the controller (and any transport consumer) types
 * its stream callbacks and ask answers through the registry instead of the
 * experience client — the single spelling stays the client's (wire types are
 * untouched by AS-6c-ii; per-kind wire types arrive with a later unit).
 */
export type { CopilotAskAnswerInput, CopilotStreamOpts } from "../api/experience-copilot-api.js";

/** A strict i18n key — the generated en-locale union (`i18n/resources`), so a
 *  typo'd key in a host descriptor is a compile error, same as a literal `t()`
 *  call. The descriptor fields below carry KEYS, never translated strings. */
export type AgentI18nKey = keyof Resources["en"];

/**
 * SC-16: one per-message action rendered under ASSISTANT bubbles only (user
 *  bubbles never carry actions). The label key resolves through `useT` (the
 *  tooltip + aria-label), the icon is an `Icons.*` entry, and the handler
 *  receives the message text. The block renders the row only when the array
 *  is present and non-empty — hosts that omit it render byte-identically.
 */
export interface AgentMessageAction {
  labelKey: AgentI18nKey;
  icon: ComponentType<{ className?: string }>;
  onSelect: (text: string) => void;
  testId: string;
}

/**
 * SC-0g: where a host's assistant-profile choice is written — the single
 * seam the shared profile modal branches on (no kind literal in the shell).
 * Script-owned hosts write `scripts.copilot_profile_id` (the modal's
 * long-standing single action); chat-owned hosts write the (chat, kind)
 * settings row ("use here") or the kind default ("use by default").
 * Existing hosts are `script` (adding the field changes no behavior — the
 * script modal path is byte-identical).
 */
export type AgentProfileAssignment = { target: "script" } | { target: "chat" };

/** Everything the generic shell needs to host one agent kind. */
export interface AgentHostDescriptor {
  kind: AgentKind;
  /** i18n KEYS (not strings) — the shell resolves them through `useT`. */
  i18n: {
    title: AgentI18nKey;
    subtitle?: AgentI18nKey;
    placeholder: AgentI18nKey;
    loading: AgentI18nKey;
    emptyTitle: AgentI18nKey;
    /** Optional per-kind empty-chat subtitle key (AS-8c3a): the shell
     *  resolves it through `useT` and passes the string to the message
     *  list's `emptySub` prop — omitted falls back to the shared
     *  `agent_subtitle` line the list rendered before this seam existed. */
    emptySub?: AgentI18nKey;
    /** AS-6b2: the mobile tab-row back chevron's aria-label key. Optional —
     *  a host that omits it renders no chevron even when `onBack` is passed
     *  (the chevron is folded into the tab-bar row, which a chat-only host
     *  does not render at all). */
    mobileBackLabelKey?: AgentI18nKey;
  };
  /** The toggleable tool keys of this kind's assistant profiles (the keys of a
   *  profile's `toolSet`). The shared profile modal renders its toggles from
   *  here, so it never branches on the kind. */
  toolKeys: readonly string[];
  /** SC-0g: where this host's profile choice is written — the modal renders
   *  its single-action (script) or dual-action (chat) variant purely from
   *  this field, never from a kind literal. */
  profileAssignment: AgentProfileAssignment;
  bufferSpecs: AgentHostBufferSpec[];
  /** AS-6c-i: the transport — the send/observe API seam. Every agent-turn
   *  call the shell (session load/switch/new/rename, context pins, message
   *  refetch) and the controller (stream + ask-answer) make goes through
   *  here, so the generic modules never import a kind-specific client. */
  transport: AgentHostTransport;
  /** Absent = chat-only host (no editor pane). */
  renderEditorPane?: (ctx: AgentHostContext) => ReactNode;
  /** The per-turn send options. AS-6b2: the live options come from the host
   *  session via `ctx.bridge` (the descriptor is a module constant and
   *  cannot close over component state); AS-6c-ii types them as
   *  {@link AgentSendOptions} (owned by this registry). */
  buildSendOptions: (ctx: AgentHostContext) => AgentSendOptions;
  /** SC-18: the send-outcome hook — the shell calls it after every turn
   *  settles (both the composer send and the ask-answer continuation) with
   *  whether the stream completed. Lets a host clear per-turn attachments
   *  on success while keeping them for a retry on failure. Absent = the
   *  host holds no per-turn send state (both built-in script hosts omit
   *  it, so their surfaces stay byte-identical). */
  onSendSettled?: (ctx: AgentHostContext, ok: boolean) => void;
  /** SC-18: an optional row rendered inside the composer's input card above
   *  the textarea (beside the pinned-context pills) — the host's per-turn
   *  attachments (the sidechat's variant chips). Absent = no row (both
   *  built-in script hosts omit it). Pure: runs during the shell's render,
   *  so no hooks inside the function body itself (the returned component
   *  owns its hooks). */
  composerTopSlot?: (ctx: AgentHostContext) => ReactNode;
  /** AS-8e5: optional per-tool caption — the host translates a machine-shaped
   *  activity (the script `run_script_test` JSON envelope) into an i18n title
   *  key plus an optional detail line. SC-13a: the title may carry
   *  interpolation params (`titleParams`, rendered through `t(key, params)`);
   *  `detail` stays the error line — never a normal caption. Undefined = the
   *  shell keeps today's fallback (the model summary / raw tool-result text). */
  toolCaption?: (activity: AgentToolActivity) => { titleKey: AgentI18nKey; titleParams?: Record<string, string | number>; detail?: string } | undefined;
  /** SC-0e: optional per-kind model default — consulted ONLY when the kind
   *  has no usable saved binding (no row pair whose profile still exists).
   *  No built-in host defines it in this unit (both keep today's
   *  first-available fallback); it exists for future kinds (the sidechat's
   *  RP-model default lands here in SC-13). Must stay pure. */
  defaultModelBinding?: (ctx: AgentDefaultModelContext) => AgentDefaultModelBinding | undefined;
  /** SC-0i: optional plan owner — the shell's plan section (`AgentPlanSection`
   *  + the controller's `plan` tool-result feed) renders ONLY from what this
   *  hook returns. Absent = the host shows NO plan block. Both built-in hosts
   *  return their script owner (their plan section renders exactly as before
   *  this seam existed); a future chat host may return a branch owner (SC-13
   *  decides). Must stay pure — it runs on every shell render. */
  planOwner?: (ctx: AgentPlanOwnerContext) => AgentPlanOwner | undefined;
  /** SC-0j: optional kind-provided meter segment labels — existing i18n KEYS
   *  (never strings) for the `segments` the kind's metrics carry, keyed by
   *  segment key. The shell passes the map to `AgentContextMeter`, which
   *  resolves each key through `useT`. No built-in host defines it in this
   *  unit (the first consumer is the sidechat kind, Wave 1 — SC-6); absent =
   *  the meter renders its fixed system/digest/history segments as today. */
  meterSegmentLabels?: Record<string, AgentI18nKey>;
  /** SC-16: optional message actions under assistant bubbles (absent = no
   *  row — both built-in hosts omit it, so their surfaces stay
   *  byte-identical). */
  messageActions?: AgentMessageAction[];
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
export function getAgentHost(kind: AgentKind): AgentHostDescriptor {
  const host = hosts.get(kind);
  if (host === undefined) throw new UnknownAgentHostError(kind);
  return host;
}
