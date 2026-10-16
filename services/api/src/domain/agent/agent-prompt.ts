/**
 * Generic agent prompt primitives (AGENT_SHELL_PLAN, Wave 2 / AS-2b) — the
 * kind-AGNOSTIC half of the assembly machinery carved out of
 * `experience-copilot-prompt.ts`: history message shapes, the digest-boundary
 * resolution (CM-5), historical tool-echo stubbing (#16), digest-section
 * rendering, and history token estimation. The EXPERIENCE half (types,
 * contract derivation, the assembler itself) stays in the experience module,
 * which consumes these primitives through re-export aliases kept for
 * compatibility (AS-10 removes the shims).
 *
 * This file must stay free of kind knowledge: no `rules`/`visual` strings in
 * code, no experience imports — a second kind (the script agent, AS-7) reuses
 * these pieces verbatim.
 */

import { estimateTokens } from "@vibe-tavern/prompt-pipeline";
import type { ToolCallPart, ToolResultPart } from "ai";

// ─── History message shape (mirrors AI SDK v5/v6 message parts) ──────────────

/** One agent history message in the AI SDK message shape. Mirrors
 *  coauthor-prompt's `CoauthorHistoryMessage`: tool calls carry `input` (the
 *  parsed args), tool results carry `output` (the SDK v6 discriminated union).
 *  A `digest` message is a compaction digest (CM-3): it is lifted out of the
 *  history flow during assembly — the LAST digest becomes a system-level JSON
 *  context section, older digests are dropped. */
export type AgentHistoryMessage =
  | { role: "user" | "assistant"; content: string; toolCalls?: ToolCallPart[] }
  | { role: "tool"; content: ToolResultPart[] }
  | { role: "digest"; content: string };

/** A history message that is NOT a digest. Digests are lifted out of the
 *  history flow during assembly and rendered into the system message, so the
 *  windowing/budget trim — and the final `messages` array — only ever carry
 *  this narrower type. */
export type AgentFlowMessage = Exclude<AgentHistoryMessage, { role: "digest" }>;

// ─── Digest boundary (CM-5) ──────────────────────────────────────────────────
//
// A compaction digest REPLACES older messages in the MODEL window only — the
// UI keeps rendering the full history. The digest message (role === "digest")
// stores the id of the FIRST KEPT message in its `toolCallId` column (a
// soft-link overload — that column is otherwise only used for tool-result
// correlation). `resolveDigestBoundary` is the SINGLE source of truth for the
// split: everything strictly before the anchor is covered (dropped from the
// model window), the anchor and everything after it is kept. Both the stream
// (pre-split before assembly) and the compaction service (what to summarize)
// consume this helper.

/** The message column that carries the digest's boundary anchor. On a digest
 *  message (role === "digest"), `toolCallId` holds the id of the FIRST KEPT
 *  message; a dangling anchor (kept message deleted) degrades to no-drop, never
 *  wrong-side. See `resolveDigestBoundary`. */
export const AGENT_DIGEST_ANCHOR_FIELD = "toolCallId" as const;

/** Structural view of a stored message sufficient to resolve the digest
 *  boundary. Accepts the store's message rows and the wire shape — only
 *  `id`/`role`/`content`/`toolCallId` are read. */
export interface DigestBoundaryMessage {
  readonly id: string;
  readonly role: string;
  readonly content: string;
  readonly toolCallId: string | null;
}

/** Result of resolving the digest boundary over a thread's message list.
 *  Generic so the caller's concrete message type (store message rows)
 *  survives — the stream and compaction service both need it to feed the history
 *  converter unchanged. */
export interface AgentDigestBoundary<T extends DigestBoundaryMessage = DigestBoundaryMessage> {
  /** The LAST digest message, or null when the thread has never compacted. */
  readonly lastDigest: T | null;
  /** Messages strictly before the last digest's anchor — the covered prefix to
   *  DROP from the model window. Excludes the last digest itself; older digest
   *  messages are simply part of this dropped prefix. */
  readonly covered: readonly T[];
  /** Messages from the anchor onward — the keep-window that survives into the
   *  model window. Excludes the last digest itself. */
  readonly kept: readonly T[];
}

/** Resolve the digest boundary (CM-5): find the LAST digest message and split
 *  the list at its anchor. See the module comment above for the semantics.
 *
 *  - No digest → `{ lastDigest: null, covered: [], kept: all }`.
 *  - Anchor found → everything strictly before the anchor is `covered`; the
 *    anchor onward is `kept` (both exclude the last digest itself).
 *  - Anchor DANGLING (id not in the loaded set) → degrade to no-drop: `covered`
 *    is empty, `kept` is every non-digest message (never wrong-side; logged).
 *
 *  Pure — no store access; the caller supplies the loaded message list. */
export function resolveDigestBoundary<T extends DigestBoundaryMessage>(
  messages: readonly T[],
): AgentDigestBoundary<T> {
  let lastDigestIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "digest") {
      lastDigestIdx = i;
      break;
    }
  }
  if (lastDigestIdx === -1) {
    return { lastDigest: null, covered: [], kept: [...messages] };
  }

  const lastDigest = messages[lastDigestIdx];
  const anchor = lastDigest.toolCallId;
  // Default (dangling / no anchor) = drop nothing — the digest still renders,
  // but every non-digest message stays in the window (degraded, never wrong-side).
  let keepFrom = 0;
  if (anchor) {
    const anchorIdx = messages.findIndex((m) => m.id === anchor);
    if (anchorIdx >= 0) {
      keepFrom = anchorIdx;
    } else {
      console.error(
        `[agent-prompt] dangling digest anchor '${anchor}' on digest '${lastDigest.id}' — treating as no-drop`,
      );
    }
  }

  const covered = messages.slice(0, keepFrom).filter((m) => m.id !== lastDigest.id);
  const kept = messages.slice(keepFrom).filter((m) => m.id !== lastDigest.id);
  return { lastDigest, covered, kept };
}

// ─── Historical tool-echo stubbing (context economy, #16) ───────────────────
//
// The #1 context sink in an authoring session is ECHO: every write_buffer/
// edit_buffer exchange puts the FULL buffer in the tool-call args (the model
// wrote them) AND the full proposed buffer in the tool result (the UI diff's
// echo). Ten edit turns of a ~2k-token buffer ≈ 40k tokens of superseded
// copies — while the CURRENT buffer is already in the system context every
// turn. Same for read_skill_file: the skill text stays in history forever.
//
// The fix mirrors Claude Code's microcompaction and OpenCode v2's tail
// pruning (tool outputs capped in the retained tail; skill outputs treated
// as operational and never fully pruned): at ASSEMBLY time — model window
// only, the store/UI keep everything (the CM-3 "model window only" pattern) —
// tool exchanges older than the last few user turns are replaced by compact
// stubs. Tool-call/tool-result PAIRS are never split or removed (the
// compaction invariant): both sides stay, structurally intact, with the
// `summary` fields preserved — the one-line decision record the model and the
// compaction summarizer actually need. The LAST skill read stays verbatim
// (OpenCode's rule: skill text is operational instructions, and the newest
// read is the live one).

/** Placeholder for superseded buffer content in stubbed tool I/O. */
export const BUFFER_ECHO_STUB =
  "[omitted — superseded buffer content; the CURRENT buffer is in the system context]";

/** Placeholder for an old skill-file read (the last read stays verbatim). */
export const SKILL_READ_STUB =
  "[skill file read earlier in this session — call read_skill_file again if you need its text]";

/** Default keep-window: the previous user turn + the current one stay verbatim. */
const ECHO_KEEP_USER_TURNS = 2;

/** Replace a buffer tool call's bulky fields (write_buffer.content /
 *  edit_buffer.edits) with the stub, keeping target/summary. Shared with the
 *  compaction service so the summarizer transcript and the model window agree. */
export function stubBufferToolCallInput(input: unknown): unknown {
  if (input === null || typeof input !== "object") return input;
  const obj = { ...(input as Record<string, unknown>) };
  if (typeof obj.content === "string" && obj.content.length > 0) obj.content = BUFFER_ECHO_STUB;
  if (Array.isArray(obj.edits)) {
    obj.edits = obj.edits.map(() => ({ search: BUFFER_ECHO_STUB, replace: BUFFER_ECHO_STUB }));
  }
  return obj;
}

/** Replace a buffer tool result's `proposed` full-buffer echo with the stub,
 *  keeping target/summary. Shared with the compaction service. */
export function stubBufferToolResultOutput(output: unknown): unknown {
  if (output === null || typeof output !== "object") return output;
  const obj = { ...(output as Record<string, unknown>) };
  if (typeof obj.proposed === "string" && obj.proposed.length > 0) obj.proposed = BUFFER_ECHO_STUB;
  return obj;
}

export interface EchoStubOptions {
  /** How many trailing user turns keep their tool I/O verbatim. `0` stubs
   *  everything (used by the compaction transcript: the summarized prefix is
   *  entirely superseded). Default 2. */
  readonly keepUserTurns?: number;
}

/** The tool names whose args/results carry full-buffer echoes. Generic by
 *  design: `write_buffer`/`edit_buffer` are the buffer-tool names EVERY kind
 *  uses (buffer identity — rules/visual today — lives in the kind's own
 *  descriptor, not in these names). */
const BUFFER_TOOLS = new Set(["write_buffer", "edit_buffer"]);

/** Stub superseded tool echoes in a flow history (model-window transform —
 *  pure, returns a new array; untouched messages pass through by reference).
 *  Tool-call/result pairs and message structure are preserved; only the
 *  bulky fields inside them are replaced. */
export function stubHistoricalToolEchoes(
  messages: readonly AgentFlowMessage[],
  opts: EchoStubOptions = {},
): AgentFlowMessage[] {
  const keepTurns = opts.keepUserTurns ?? ECHO_KEEP_USER_TURNS;
  const userIdx: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === "user") userIdx.push(i);
  });
  // keepUserTurns 0 = keep NOTHING verbatim (the compaction transcript path);
  // otherwise anchor at the Nth-from-last user message. Short histories (fewer
  // user turns than the keep-window) anchor at the first user message →
  // nothing older → nothing stubbed.
  const anchorIdx =
    keepTurns <= 0
      ? messages.length
      : (userIdx[Math.max(0, userIdx.length - keepTurns)] ?? 0);

  // The LAST skill read stays verbatim (operational text, newest = live).
  let lastSkillCallId: string | null = null;
  for (const m of messages) {
    if (m.role === "tool") {
      for (const part of m.content) {
        if (part.toolName === "read_skill_file") lastSkillCallId = part.toolCallId;
      }
    }
  }

  return messages.map((m, i): AgentFlowMessage => {
    if (i < anchorIdx && m.role === "assistant" && m.toolCalls?.length) {
      return {
        ...m,
        toolCalls: m.toolCalls.map((call) =>
          BUFFER_TOOLS.has(call.toolName) ? { ...call, input: stubBufferToolCallInput(call.input) } : call,
        ),
      };
    }
    if (i < anchorIdx && m.role === "tool") {
      return {
        ...m,
        content: m.content.map((part) => {
          // Flow tool results always carry a text output (the stored-message →
          // history converter wraps everything as {type:"text", value}), but
          // the TYPE is the SDK's discriminated union — narrow before touching
          // `.value`.
          if (part.output.type !== "text") return part;
          if (BUFFER_TOOLS.has(part.toolName)) {
            try {
              const parsed = JSON.parse(part.output.value) as unknown;
              return {
                ...part,
                output: { type: "text" as const, value: JSON.stringify(stubBufferToolResultOutput(parsed)) },
              };
            } catch {
              return part; // non-JSON output — leave as-is (never throws here)
            }
          }
          if (part.toolName === "read_skill_file" && part.toolCallId !== lastSkillCallId) {
            return { ...part, output: { type: "text" as const, value: SKILL_READ_STUB } };
          }
          return part;
        }),
      };
    }
    return m;
  });
}

// ─── System-message section renderers ────────────────────────────────────────

/** Render the compaction digest as a system-level JSON context section (CM-3).
 *  Mirrors the Co-Author compaction pattern: a compact `{"digest": "..."}`
 *  block the model reads as a single fact — the digest is a summary, NOT a
 *  chat message, so it is injected into the system message (after the context
 *  package), never into the history flow. Exported (CM-5) so the compaction
 *  service estimates the post-compaction digest token count with the SAME
 *  rendering the assembler emits. */
export function renderDigestSection(digest: string): string {
  return [
    "# Compacted context (digest)",
    "```json",
    JSON.stringify({ digest }),
    "```",
  ].join("\n");
}

// ─── Skill-catalog rendering ──────────────────────────────────────────────
//
// fork #2 of renderSkillCatalog (services/api/src/domain/chat/coauthor-prompt.ts).
// forks: 2 — 1) renderExperienceCopilotSkillCatalog (experience-copilot-module.ts,
// copilot-local so its wording can diverge), 2) this generic twin (AS-7: the
// script kind needed a renderer without importing experience code). Per the
// fork rule the THIRD occurrence must be surfaced to the owner with a
// unification proposal (migrate coauthor + experience onto this generic
// renderer, an AS-10 cleanup candidate); until then this stays byte-identical
// to the experience copy and carries the correspondence by construction.

/** Render the skill-catalog block for a system message: the progressive-
 *  disclosure "Available skills" section (id + one-line description + the
 *  `read_skill_file` path to read on demand). Returns an empty string when no
 *  skills are available so the section is omitted entirely. */
export function renderAgentSkillCatalog(
  entries: ReadonlyArray<{
    readonly id: string;
    readonly description: string;
    readonly shadowsBuiltin?: boolean;
    readonly rootRelativeManifestPath: string;
  }>,
): string {
  if (entries.length === 0) return "";
  const lines = [
    "# Available skills (read on demand)",
    "Skills are loaded on demand. Pick the skill whose description matches the task, call `read_skill_file` with its manifest `path` to read its `SKILL.md`, obey that workflow, and read only the referenced files the task actually needs. Do NOT read a skill you do not need.",
    "",
    ...entries.map((e) => {
      const shadow = e.shadowsBuiltin ? " (user override of built-in)" : "";
      const desc = e.description.trim() || "(no description)";
      return `- **${e.id}**${shadow} — ${desc}  → read \`${e.rootRelativeManifestPath}\``;
    }),
  ];
  return lines.join("\n");
}

// ─── History token estimation ────────────────────────────────────────────────

function formatHistoryMessages(messages: ReadonlyArray<AgentFlowMessage>): string {
  return messages.map((message) => {
    const content = message.role === "tool"
      ? JSON.stringify(message.content)
      : `${message.content || ""}${message.toolCalls ? JSON.stringify(message.toolCalls) : ""}`;
    return `${message.role.toUpperCase()}: ${content}`;
  }).join("\n\n");
}

/** Estimate the token count of a list of flow messages using the SAME
 *  formatter the assembler's budget trim uses. Exported (CM-5) so the
 *  compaction service estimates the post-compaction history segment identically. */
export function estimateHistoryTokens(messages: ReadonlyArray<AgentFlowMessage>): number {
  return estimateTokens(formatHistoryMessages(messages));
}
