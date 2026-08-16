/** Prefixes used when generating entity IDs (e.g. "char_…", "chat_…", "msg_…"). */
export const ENTITY_ID_NAMESPACE = {
  character: "char",
  characterVersion: "charver",
  scratchCharacter: "char",
  scratchCharacterVersion: "ver",
  freeCharacter: "free",
  freeCharacterVersion: "fver",
  persona: "persona",
  lorebook: "lorebook",
  loreEntry: "lore_entry",
  loreEntryDeterministic: "loreentry",
  chat: "chat",
  chatBranch: "branch",
  chatSummary: "chat_summary",
  message: "msg",
  messageVariant: "variant",
  summaryMemory: "summary",
  promptTrace: "trace",
  providerProfile: "provider",
  promptPreset: "prompt_preset",
  script: "script",
  diceRoll: "dice_roll",
  dicePendingLane: "dice_pending_lane",
  experienceVisual: "exp_visual",
  experienceSession: "exp_session",
  experienceStep: "exp_step",
  experienceEffect: "exp_effect",
  experienceContextBundle: "exp_context",
  experienceAttachment: "exp_attach",
} as const;

export type EntityIdNamespace = typeof ENTITY_ID_NAMESPACE[keyof typeof ENTITY_ID_NAMESPACE];

/** Well-known IDs for system-managed singleton resources. */
export const SYSTEM_RESOURCE_ID = {
  toolsDisabled: "tools_disabled",
  unresolvedModel: "unresolved_model",
  activeToolProfile: "active_tool_profile",
  preflight: "preflight",
} as const;

export type SystemResourceId = typeof SYSTEM_RESOURCE_ID[keyof typeof SYSTEM_RESOURCE_ID];

/**
 * Supported LLM provider backends.
 *
 * - `openaiCompat` — OpenAI API and all compatible endpoints
 * - `anthropic` — Anthropic Claude API
 * - `google` — Google Gemini API
 * - `ollama` — Ollama (via OpenAI-compatible adapter)
 * - `llamaCpp` — llama.cpp server (via OpenAI-compatible adapter)
 * - `koboldCpp` — KoboldCpp (native adapter, non-OpenAI API)
 * - `unsloth` — Unsloth Studio (OpenAI-compatible /v1 endpoints; requires sk-unsloth- key)
 */
export const PROVIDER_TYPE = {
  openaiCompat: "openai_compat",
  anthropic: "anthropic",
  google: "google",
  ollama: "ollama",
  llamaCpp: "llamacpp",
  koboldCpp: "koboldcpp",
  unsloth: "unsloth",
} as const;

export type ProviderType = typeof PROVIDER_TYPE[keyof typeof PROVIDER_TYPE];

export const PROVIDER_PRESET_GROUP = {
  cloud: "cloud",
  native: "native",
  local: "local",
} as const;

export type ProviderPresetGroup = typeof PROVIDER_PRESET_GROUP[keyof typeof PROVIDER_PRESET_GROUP];

/**
 * Character card serialization formats.
 *
 * - `st_v2` — SillyTavern V2 spec
 * - `st_v3` — SillyTavern V3 spec
 * - `janitor_md` — Janitor-flavored Markdown
 * - `internal_json` — Platform-internal JSON representation
 */
export const CARD_FORMAT = {
  sillyTavernV2: "st_v2",
  sillyTavernV3: "st_v3",
  janitorMarkdown: "janitor_md",
  internalJson: "internal_json",
} as const;

export type CardFormat = typeof CARD_FORMAT[keyof typeof CARD_FORMAT];

export const LORE_SCOPE_TYPE = {
  global: "global",
  character: "character",
  persona: "persona",
  chat: "chat",
} as const;

export type LoreScopeType = typeof LORE_SCOPE_TYPE[keyof typeof LORE_SCOPE_TYPE];

export const CHAT_STATUS = {
  active: "active",
  archived: "archived",
} as const;

export type ChatStatus = typeof CHAT_STATUS[keyof typeof CHAT_STATUS];

/**
 * Chat mode — determines how a chat's prompt is assembled and which
 * ChatModeStrategy drives it. Modes differ through the strategy, not through
 * mode-specific branches in shared paths. Add a value here + a strategy class
 * + a registry entry to introduce a new mode.
 *
 * - `rp`      — roleplay (the original/default mode).
 * - `coauthor`— co-author: edit a character card with an AI in a split-screen.
 * - `novel`/`group` — reserved for future modes (no strategy yet).
 */
export const CHAT_MODE = {
  rp: "rp",
  coauthor: "coauthor",
  novel: "novel",
  group: "group",
} as const;

export type ChatMode = typeof CHAT_MODE[keyof typeof CHAT_MODE];

export const MESSAGE_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
  tool: "tool",
} as const;

export type MessageRole = typeof MESSAGE_ROLE[keyof typeof MESSAGE_ROLE];

export const AUTHOR_TYPE = MESSAGE_ROLE;
export type AuthorType = typeof AUTHOR_TYPE[keyof typeof AUTHOR_TYPE];

/**
 * Lifecycle states of a chat message.
 *
 * - `pending` — currently being generated
 * - `complete` — generation finished
 * - `edited` — user-modified after generation
 * - `deleted` — soft-deleted
 */
export const MESSAGE_STATE = {
  pending: "pending",
  complete: "complete",
  edited: "edited",
  deleted: "deleted",
} as const;

export type MessageState = typeof MESSAGE_STATE[keyof typeof MESSAGE_STATE];

/**
 * Categories of summary memories.
 *
 * - `scene` — current scene description
 * - `relationship` — relationship dynamics between characters
 * - `world_state` — world/setting facts
 * - `open_threads` — unresolved plot threads
 * - `general` — catch-all category
 */
export const SUMMARY_KIND = {
  scene: "scene",
  relationship: "relationship",
  worldState: "world_state",
  openThreads: "open_threads",
  general: "general",
} as const;

export type SummaryKind = typeof SUMMARY_KIND[keyof typeof SUMMARY_KIND];

export const CHAT_SUMMARY_SOURCE = {
  manual: "manual",
  auto: "auto",
} as const;

export type ChatSummarySource = typeof CHAT_SUMMARY_SOURCE[keyof typeof CHAT_SUMMARY_SOURCE];

/**
 * Activation modes for a tool profile.
 *
 * - `disabled` — tools are off
 * - `available_on_request` — user can invoke tools manually
 * - `active` — tools are always enabled
 * - `hidden_system_use_only` — internal system tools, not exposed to user
 */
export const TOOL_PROFILE_MODE = {
  disabled: "disabled",
  availableOnRequest: "available_on_request",
  active: "active",
  hiddenSystemUseOnly: "hidden_system_use_only",
} as const;

export type ToolProfileMode = typeof TOOL_PROFILE_MODE[keyof typeof TOOL_PROFILE_MODE];

/**
 * Logic operators that combine primary keys with secondary keys in a {@link LoreEntry}.
 *
 * - `and_any` — at least one secondary key must match
 * - `and_all` — all secondary keys must match
 * - `not_any` — none of the secondary keys may match
 * - `not_all` — not all secondary keys match (at least one missing)
 */
export const LORE_LOGIC = {
  andAny: "and_any",
  andAll: "and_all",
  notAny: "not_any",
  notAll: "not_all",
} as const;

export type LoreLogic = typeof LORE_LOGIC[keyof typeof LORE_LOGIC];

/**
 * Where a prompt layer is injected into the assembled prompt.
 *
 * - `before_prompt` — prepended before everything else
 * - `in_prompt` — main prompt block (system / jailbreak)
 * - `in_chat` — inserted into the chat history (may use `injectionDepth`)
 * - `hidden_system` — system-level instruction not shown in prompt traces
 */
export const PROMPT_LAYER_POSITION = {
  beforePrompt: "before_prompt",
  inPrompt: "in_prompt",
  inChat: "in_chat",
  hiddenSystem: "hidden_system",
} as const;

export type PromptLayerPosition = typeof PROMPT_LAYER_POSITION[keyof typeof PROMPT_LAYER_POSITION];

/**
 * Lorebook entry position — the prompt slot where an activated entry's text
 * is inserted. Wider than `PromptLayerPosition` because SillyTavern World
 * Info defines 8 fine-grained positions that map onto the prompt-order
 * canvas (before/after char, before/after example messages, before/after
 * Author's Note, at-depth, outlet). VT preserves all 8 ST positions so
 * imports do not lose the user's carefully-placed before/after split.
 *
 * The 4 pipeline-native positions (`before_prompt | in_prompt | in_chat |
 * hidden_system`) cover VT-native lorebooks that don't map to ST's taxonomy.
 *
 * `assemble.ts` switches on these literals to route each entry to the right
 * `worldInfoBefore` / `worldInfoAfter` marker and subPosition.
 */
export const LORE_ENTRY_POSITION = {
  // SillyTavern World Info positions (8)
  beforeChar: "before_char",
  afterChar: "after_char",
  beforeExamples: "before_examples",
  afterExamples: "after_examples",
  topAn: "top_an",
  bottomAn: "bottom_an",
  atDepth: "at_depth",
  outlet: "outlet",
  // Pipeline-native positions (4)
  beforePrompt: "before_prompt",
  inPrompt: "in_prompt",
  inChat: "in_chat",
  hiddenSystem: "hidden_system",
} as const;

export type LoreEntryPosition = typeof LORE_ENTRY_POSITION[keyof typeof LORE_ENTRY_POSITION];

export const RETRIEVED_MEMORY_SOURCE_TYPE = {
  loreEntry: "lore_entry",
  characterSection: "character_section",
  message: "message",
  summary: "summary",
} as const;

export type RetrievedMemorySourceType = typeof RETRIEVED_MEMORY_SOURCE_TYPE[keyof typeof RETRIEVED_MEMORY_SOURCE_TYPE];

export const LORE_ENTRY_ROLE = {
  system: "system",
  user: "user",
  assistant: "assistant",
} as const;

export type LoreEntryRole = typeof LORE_ENTRY_ROLE[keyof typeof LORE_ENTRY_ROLE];

// `LORE_TRIGGER_TYPE` / `LoreTriggerType` and mode-based lore-entry
// activation were removed: the UI chips had already been deleted, and the
// engine filter was unreachable because `mode` was hardcoded to "normal" on
// every call site. The DB column `lore_entries.triggers_json` remains as an
// orphan in existing user databases (removing it would require a
// table-rebuild migration for no functional gain) but no code reads it. See
// vibe_tavern_plan/reports/lorebook-st-parity-audit.md §3.5.


export const LORE_MATCH_SOURCE = {
  chatMessages: "chat_messages",
  characterDesc: "character_desc",
  characterPersonality: "character_personality",
  characterNote: "character_note",
  personaDesc: "persona_desc",
  scenario: "scenario",
  creatorNotes: "creator_notes",
} as const;

export type LoreMatchSource = typeof LORE_MATCH_SOURCE[keyof typeof LORE_MATCH_SOURCE];

/**
 * The two per-chat opt-in insight features (INSIGHTS_PLAN).
 *
 * - `objective` — Objective Tracker: an LLM-generated task roadmap; the active task is injected as a prompt layer so the model plays toward it.
 * - `tracker` — Scene Tracker: LLM-filled structured scene state per message; the latest is injected as a prompt layer so the model knows the current scene.
 */
export const INSIGHT_FEATURE = {
  objective: "objective",
  tracker: "tracker",
} as const;

export type InsightFeature = typeof INSIGHT_FEATURE[keyof typeof INSIGHT_FEATURE];

/**
 * Lifecycle states of an objective task in the Objective Tracker insight.
 *
 * - `pending` — not yet started
 * - `active` — the current task the model is playing toward (injected as a prompt layer)
 * - `completed` — finished
 * - `abandoned` — dropped / superseded
 */
export const OBJECTIVE_TASK_STATUS = {
  pending: "pending",
  active: "active",
  completed: "completed",
  abandoned: "abandoned",
} as const;

export type ObjectiveTaskStatus = typeof OBJECTIVE_TASK_STATUS[keyof typeof OBJECTIVE_TASK_STATUS];

/**
 * Enforce the "exactly one active target" display/injection invariant.
 *
 * `selectActiveTask` (services/api) targets the first `active` item, else the
 * first `pending`, so the model is steered toward that goal even when no item is
 * explicitly `active`. But the STORED status of that fallback target stays
 * `pending`, so the UI — which renders status literally — shows it as a regular
 * pending item, indistinguishable from the rest. This pure helper promotes the
 * would-be-injected item to `active` so the existing UI marks it as the current
 * goal. It is a READ/DISPLAY normalization: callers apply it when reading state
 * for the snapshot / patch response so every consumer agrees on which item is
 * "current"; they do NOT persist the promotion unless they choose to.
 *
 * No-op when an `active` item already exists or when there are no `pending`
 * items. Generic over the item shape (only `status` is read) so it serves both
 * route `tasks` and goals-mode `shortTermGoals`.
 */
export function ensureActiveObjectiveTarget<T extends { status: string }>(items: readonly T[]): T[] {
  if (items.length === 0) return [...items];
  if (items.some((t) => t.status === OBJECTIVE_TASK_STATUS.active)) return [...items];
  const firstPending = items.findIndex((t) => t.status === OBJECTIVE_TASK_STATUS.pending);
  if (firstPending === -1) return [...items];
  return items.map((t, i) => (i === firstPending ? { ...t, status: OBJECTIVE_TASK_STATUS.active } : t));
}

/**
 * Objective Tracker mode (OGM — OBJECTIVE_GOALS_MODE_PLAN).
 *
 * - `route` — the original mode: one high-level objective broken into an ordered
 *   task route (`ObjectiveState.tasks`), one active target at a time, advanced
 *   sequentially toward the objective's resolution.
 * - `goals` — one enduring long-term goal plus a flat list of independent
 *   short-term goals. The long-term goal is always injected into the RP prompt
 *   (until completed); the one selected (active) short-term goal is injected
 *   next to it. Short-term goals are completable independently and may be
 *   unrelated to the long-term goal.
 *
 * Absent on disk → `route` (existing chats stay unchanged).
 */
export const OBJECTIVE_MODE = {
  route: "route",
  goals: "goals",
} as const;

export type ObjectiveMode = typeof OBJECTIVE_MODE[keyof typeof OBJECTIVE_MODE];

// ─── Dice system (DICE_SYSTEM_BACKEND_PLAN, Wave B1) ───────────────────────────
//
// The per-chat opt-in Dice feature is server-authoritative and manual-only
// in V1. These constants are the canonical vocabulary shared by the domain
// entities, the pure roller (dice.ts), the Zod request/result schemas
// (api-contracts/dice-schema.ts), the Dice-script VM (Wave B2), and the
// pending-lane storage + API (Wave B3). Add a value here first; everything
// else keys off these literals.

/**
 * Runtime contract of a script.
 *
 * - `prompt` — the original prompt-script VM: mutates character/scenario
 *   fields as a side effect of `assemblePrompt()`. Every legacy row, import,
 *   and request defaults to this.
 * - `dice` — the dedicated Dice-script VM (Wave B2): registers checks, reads
 *   a frozen actor snapshot, and calls a bounded server roller. A dice script
 *   never mutates prompt fields, injects messages, or runs during assembly.
 * - `interactive` — the Interactive Runtime VM (IR plan, Wave 1): registers
 *   exactly one experience definition with the four mandatory methods
 *   (`create`/`project`/`actions`/`reduce`) and owns JSON-safe authoritative
 *   state. An interactive script never mutates prompt fields, runs during
 *   prompt assembly, or shares state with the prompt/dice runtimes.
 *
 * Each runtime loads only its own kind: prompt assembly loads `prompt`
 * scripts, Dice actions load `dice` scripts, and the experience service loads
 * `interactive` scripts. The three runtimes are isolated by kind at the store
 * boundary; neither existing behavior-pinned VM is broadened into a mixed
 * runtime.
 */
export const SCRIPT_KIND = {
  prompt: "prompt",
  dice: "dice",
  interactive: "interactive",
} as const;

export type ScriptKind = typeof SCRIPT_KIND[keyof typeof SCRIPT_KIND];

/**
 * Dice turn mode — whether discarded attempts persist and how extra attempts
 * are granted. Orthogonal to {@link DiceResolution} (strict/narrative).
 *
 * - `normal` — repeating the same actor+check replaces its pending result;
 *   discarded attempts never persist as history. One result per actor+check.
 * - `immersive` — each actor+check gets one initial attempt per draft turn;
 *   further attempts exist only when the Dice script grants them. Multiple
 *   authorized attempts stay inside one result envelope's `attempts[]`.
 */
export const DICE_MODE = {
  normal: "normal",
  immersive: "immersive",
} as const;

export type DiceMode = typeof DICE_MODE[keyof typeof DICE_MODE];

/**
 * Who a check is rolled for. Both actor types can roll multiple distinct
 * checks before one user message; each is a separate pending result.
 *
 * - `persona` — the user's persona.
 * - `character` — the chat's character.
 */
export const DICE_ACTOR_TYPE = {
  persona: "persona",
  character: "character",
} as const;

export type DiceActorType = typeof DICE_ACTOR_TYPE[keyof typeof DICE_ACTOR_TYPE];

/**
 * How a check's outcome is adjudicated, per-check and orthogonal to mode.
 *
 * - `strict` — persists a validated outcome (and optional degree/constraint);
 *   the model receives these as binding adjudication.
 * - `narrative` — persists mechanical facts (faces/total) but NO authoritative
 *   success/failure; the model is not forced to adjudicate.
 */
export const DICE_RESOLUTION = {
  strict: "strict",
  narrative: "narrative",
} as const;

export type DiceResolution = typeof DICE_RESOLUTION[keyof typeof DICE_RESOLUTION];

/**
 * Finalization policy a Dice script declares for an Immersive check's extra
 * attempts. Drives how the active attempt is chosen and whether send blocks.
 *
 * - `replace` — the latest authorized attempt replaces the previous one.
 * - `keep_best` — auto-marks the highest-total attempt as the final result.
 * - `keep_worst` — auto-marks the lowest-total attempt as the final result.
 * - `choose` — the user must select one attempt; send is blocked at the API
 *   layer until a choice exists.
 */
export const DICE_FINALIZATION_POLICY = {
  replace: "replace",
  keepBest: "keep_best",
  keepWorst: "keep_worst",
  choose: "choose",
} as const;

export type DiceFinalizationPolicy =
  typeof DICE_FINALIZATION_POLICY[keyof typeof DICE_FINALIZATION_POLICY];

/**
 * Face-shape hint for per-die visualization. The bounded roller supports the
 * standard polyhedral set plus the percentile (`d%`, sides 100). This is the
 * ONLY set the core notation accepts; advanced mechanics (pools, explode,
 * keep-high/low, advantage) are implemented by the Dice script through
 * repeated bounded roller calls, never by growing the notation grammar.
 */
export const DICE_FACE_SHAPE = {
  d4: "d4",
  d6: "d6",
  d8: "d8",
  d10: "d10",
  d12: "d12",
  d20: "d20",
  dPercent: "d%",
} as const;

export type DiceFaceShape = typeof DICE_FACE_SHAPE[keyof typeof DICE_FACE_SHAPE];

// ─── Interactive Runtime (INTERACTIVE_RUNTIME_FOUNDATION_PLAN, Wave 1) ─────────
//
// The general Interactive Runtime beneath Scripted Games: a per-chat opt-in,
// branch-scoped experience engine with a four-method authored lifecycle. These
// constants are the canonical vocabulary shared by the domain envelopes
// (entities.ts), the bounded wire schemas (api-contracts/interactive-schema.ts),
// the synchronous rules VM/kernel (Wave 1, IR-12), and the durable persistence
// layer (Wave 2). Add a value here first; everything else keys off these
// literals, exactly like the Dice vocabulary above.

/**
 * Interactive Runtime capability registry (Wave 1). A package declares the
 * capabilities it may use; the user grants a subset per session. Only declared
 * AND granted capabilities appear in the VM `context`; absence is a true no-op
 * and never silently grants host privilege.
 *
 * - `participants`         — multi-seat games; reads the participant roster.
 * - `deterministic_random` — a seeded RNG the reducer draws from (synchronous,
 *   replay-stable; not a durable effect).
 * - `model`                — durable atomic/non-streaming model generation for
 *   a model-controlled seat (the sole durable effect kind in V1).
 * - `rp_context`           — frozen RP context (branch/recent/summaries/compact)
 *   attached to a model-controlled seat's prompt.
 * - `rp_attachment`        — freeze/queue an experience report that binds
 *   atomically to the next user message.
 */
export const EXPERIENCE_CAPABILITY = {
  participants: "participants",
  deterministicRandom: "deterministic_random",
  model: "model",
  rpContext: "rp_context",
  rpAttachment: "rp_attachment",
} as const;

export type ExperienceCapability =
  typeof EXPERIENCE_CAPABILITY[keyof typeof EXPERIENCE_CAPABILITY];

/**
 * Who controls a participant seat. The host supports all three; each experience
 * decides which are allowed for its seats.
 *
 * - `human`  — the user controls this seat.
 * - `script` — a synchronous strategy function chooses actions.
 * - `model`  — a durable model effect chooses a validated action.
 */
export const EXPERIENCE_CONTROLLER = {
  human: "human",
  script: "script",
  model: "model",
} as const;

export type ExperienceController =
  typeof EXPERIENCE_CONTROLLER[keyof typeof EXPERIENCE_CONTROLLER];

/**
 * The viewer a `project`/`actions` call is for. Hidden information is enforced
 * by projecting per-viewer: the human seat, a specific script/model seat, or a
 * public observer (reports/Writer) that sees no private data.
 */
export const EXPERIENCE_VIEWER_KIND = {
  human: "human",
  script: "script",
  model: "model",
  observer: "observer",
} as const;

export type ExperienceViewerKind =
  typeof EXPERIENCE_VIEWER_KIND[keyof typeof EXPERIENCE_VIEWER_KIND];

/**
 * Lifecycle status of an experience session. `active` is the running state —
 * including UI-closed/reloaded, because closing the UI pauses nothing
 * destructively. `completed` is a rule-determined natural end. `interrupted`
 * is an explicit user end. A reducer transition returns `active` or
 * `completed` only; the host records `interrupted` via a system transition.
 */
export const EXPERIENCE_SESSION_STATUS = {
  active: "active",
  completed: "completed",
  interrupted: "interrupted",
} as const;

export type ExperienceSessionStatus =
  typeof EXPERIENCE_SESSION_STATUS[keyof typeof EXPERIENCE_SESSION_STATUS];

/**
 * Visibility of an event emitted by a transition. `public` events reach the
 * visual, the queued report, and the Writer; `private` events never leave the
 * authoritative runtime. This literal is how hidden state is proven absent
 * from every projection.
 */
export const EXPERIENCE_EVENT_VISIBILITY = {
  public: "public",
  private: "private",
} as const;

export type ExperienceEventVisibility =
  typeof EXPERIENCE_EVENT_VISIBILITY[keyof typeof EXPERIENCE_EVENT_VISIBILITY];

/**
 * Lifecycle status of a durable effect. A reducer requests an effect as data;
 * the host persists it `pending` before running it. Process interruption after
 * `running` reconciles an effect to `unknown` (never directly back to
 * `pending`); only an explicit user retry creates a new attempt.
 */
export const EXPERIENCE_EFFECT_STATUS = {
  pending: "pending",
  running: "running",
  succeeded: "succeeded",
  failed: "failed",
  cancelled: "cancelled",
  unknown: "unknown",
} as const;

export type ExperienceEffectStatus =
  typeof EXPERIENCE_EFFECT_STATUS[keyof typeof EXPERIENCE_EFFECT_STATUS];

/**
 * Kind of durable effect a reducer may request. The host persists the request,
 * runs the capability work, and feeds the result back through the same
 * state-machine boundary. V1 ships `model` (atomic model generation) and
 * `timer` (a host-fired synthetic tick action after a delay); the set is
 * bounded and grows only as a capability introduces new durable work.
 */
export const EXPERIENCE_EFFECT_KIND = {
  model: "model",
  timer: "timer",
} as const;

export type ExperienceEffectKind =
  typeof EXPERIENCE_EFFECT_KIND[keyof typeof EXPERIENCE_EFFECT_KIND];

/**
 * RP-context capture mode for a model-controlled seat (Wave 4). Context is
 * optional and explicit; it never silently resynchronizes.
 *
 * - `none`             — no RP context.
 * - `current_branch`   — the current branch within the selected model budget.
 * - `recent`           — a bounded recent-message window.
 * - `summaries_recent` — existing included summaries plus recent messages.
 * - `compact_summary`  — an explicitly generated compact snapshot (never the
 *   default; a separate user action).
 */
export const EXPERIENCE_CONTEXT_MODE = {
  none: "none",
  currentBranch: "current_branch",
  recent: "recent",
  summariesRecent: "summaries_recent",
  compactSummary: "compact_summary",
} as const;

export type ExperienceContextMode =
  typeof EXPERIENCE_CONTEXT_MODE[keyof typeof EXPERIENCE_CONTEXT_MODE];

/**
 * Setup-field kind discriminator for an experience's optional package-authored
 * setup descriptor (IR-70F). A package may declare a bounded list of fields the
 * host renders as bounded settings before launch; the four kinds cover the
 * standard control surface (text/number/boolean/select) a game needs for
 * strength/style and similar authored controls. Existing packages without a
 * setup descriptor remain byte-for-byte valid.
 */
export const EXPERIENCE_SETUP_FIELD_KIND = {
  text: "text",
  number: "number",
  boolean: "boolean",
  select: "select",
} as const;

export type ExperienceSetupFieldKind =
  typeof EXPERIENCE_SETUP_FIELD_KIND[keyof typeof EXPERIENCE_SETUP_FIELD_KIND];
