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
 * shell resolves them through `useT`), the buffer specs, the optional editor
 * pane (absent = chat-only host), the send-options builder, the optional
 * toolbar/mobile slots, and the per-recordType fallback-card renderers for
 * record proposals.
 */
import type { ComponentType, ReactNode } from "react";
import type { RecordProposal } from "@vibe-tavern/api-contracts";

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
 * The minimal context a host descriptor receives (AS-5). Deliberately narrow:
 * the shell owns the thread/session, the host only needs to know WHOSE
 * script it renders for. Grows in AS-6 (draft handles, send plumbing).
 */
export interface AgentHostContext {
  ownerId: string;
  scriptId?: string;
}

/** One named buffer the host's editor pane edits (label resolved via i18n). */
export interface AgentHostBufferSpec {
  id: string;
  labelKey: string;
  language: string;
}

/** Props a per-recordType record-proposal renderer receives. */
export interface RecordProposalCardProps {
  proposal: RecordProposal;
}

/** Everything the generic shell needs to host one agent kind. */
export interface AgentHostDescriptor {
  kind: string;
  /** i18n KEYS (not strings) — the shell resolves them through `useT`. */
  i18n: {
    title: string;
    subtitle?: string;
    placeholder: string;
    loading: string;
    emptyTitle: string;
    emptySub: string;
  };
  bufferSpecs: AgentHostBufferSpec[];
  /** Absent = chat-only host (no editor pane). */
  renderEditorPane?: (ctx: AgentHostContext) => ReactNode;
  buildSendOptions: (ctx: AgentHostContext) => Record<string, unknown>;
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
