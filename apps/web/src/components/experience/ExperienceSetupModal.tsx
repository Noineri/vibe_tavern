/**
 * ExperienceSetupModal — prepares and starts ONE branch-scoped interactive
 * session from the confirmed per-chat config (INTERACTIVE_RUNTIME_FOUNDATION_PLAN,
 * Wave 7 / IR-73A). It is the host surface between "an experience is enabled in
 * Chat Add-ons" and "the visual frame is running" (the frame itself is IR-73B).
 *
 * What this modal owns:
 *  - Renders the rules package's validated `definition.setup.fields` (IR-70F),
 *    a generic V1 participant roster, immutable per-model-seat provider/model
 *    assignments, explicit frozen RP-context preparation, and model-only global
 *    /current-character prompt overrides.
 *  - Every authoritative transition goes through the committed Experience store
 *    /API seams (`startSession`, `captureContext`, `updateExperienceConfig`).
 *    There is NO local rule execution and NO local state reduction.
 *
 * Session-preservation invariant (mirrors the Wave 6 ExperienceModal): closing
 * the modal aborts any in-flight context generation but NEVER ends or deletes a
 * created session — `endSession` is never called here. A created session stays
 * resumable; IR-73B reconnects the persisted session to the frame.
 *
 * Scope safety: all local async work (discovery, provider/model fetches, start,
 * capture, generate, override load/save) is guarded by a monotonic scope epoch
 * keyed on `{chatId, branchId}`. A late result from scope A can never render or
 * apply to scope B. Immediately before the start mutation the store's active
 * scope is asserted to still equal the exact props scope, so a stale scope fails
 * locally instead of starting on another branch.
 *
 * Progressive disclosure (the VT design principle): capability-dependent
 * controls exist ONLY when the capability is both declared by the package AND
 * granted in the chat config. Participants/model seats/context/prompt-overrides
 * each gate independently on their capability grant — never on the mere
 * existence of a provider/model.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTEXT_MODE,
  type ExperienceCapability,
  type ExperienceContextMode,
} from "@vibe-tavern/domain";
import {
  INTERACTIVE_SCHEMA_MAX_LABEL,
  INTERACTIVE_SCHEMA_MAX_PARTICIPANTS,
  type ExperienceDefinitionDto,
} from "@vibe-tavern/api-contracts";
import { Modal } from "../shared/Modal.js";
import { DropdownSelect } from "../shared/DropdownSelect.js";
import { SegmentedControl } from "../shared/SegmentedControl.js";
import { Checkbox } from "../shared/Checkbox.js";
import { AutoTextarea } from "../shared/auto-textarea.js";
import { Ic } from "../shared/icons.js";
import { useIsMobile } from "../../hooks/use-mobile.js";
import { useT } from "../../i18n/context.js";
import { listPersonas } from "../../api/persona-api.js";
import type Resources from "../../i18n/resources.js";
import { useAllCharacters, useChatList } from "../../stores/snapshot-store.js";
import {
  useExperienceConfig,
  useExperienceLoading,
  useExperienceSession,
  useExperienceStore,
} from "../../stores/experience-store.js";
import {
  getExperiencePromptOverrides,
  updateExperienceConfig,
  updateExperienceCharacterOverride,
  updateExperienceGlobalOverride,
} from "../../api/experience-api.js";
import { testScript } from "../../api/script-api.js";
import {
  FieldError,
  SetupFieldRow,
  seedSetupDefaults,
  validateSetupFields,
  type SetupField,
} from "./setup-fields.js";
import {
  fetchProviderProfileModels,
  listProviderProfiles,
} from "../../api/provider-api.js";
import type {
  ExperienceContextCaptureRequest,
  ExperiencePromptOverridesResponse,
  ExperienceSessionResponse,
  ExperienceStartRequest,
  ProviderModelOption,
  ProviderProfileRecord,
} from "../../api/types.js";

type TKey = keyof Resources["en"];

/** Controller literal union (mirrors EXPERIENCE_CONTROLLER). */
type SeatController = "human" | "script" | "model";

/** One editable participant row. The host owns the stable id; the label is
 *  user-editable free text. Model seats additionally pin a provider + model,
 *  and may be backed by a library character (report item 6b). */
interface RosterSeat {
  /** Stable host-generated participant id (seat_1, seat_2, …; never reassigned). */
  id: string;
  /** User-editable bounded name. */
  label: string;
  controller: SeatController;
  /** Model seats only — both required before Start (IR-70E). */
  providerProfileId?: string;
  modelId?: string;
  /** Model seats only — a library character the seat answers as (report item
   *  6b). Stripped when the seat switches away from a model controller. */
  characterId?: string;
}

/** Modal phase — drives which controls render and which action is primary. */
type Phase = "config" | "capturing" | "awaiting-summary" | "generating-summary" | "ready";

export interface ExperienceSetupModalProps {
  /** Controls modal visibility. When open, the scope is hydrated on mount. */
  readonly open: boolean;
  /** The chat the experience config belongs to. */
  readonly chatId: string;
  /** The branch the session is scoped to (at most one active session per branch). */
  readonly branchId: string;
  /** Hide the surface. Aborts in-flight generation but NEVER ends the session. */
  readonly onClose: () => void;
  /** Fired with the prepared session once context is frozen (or immediately for
   *  `none`) and prompt overrides are settled, so IR-73B can launch the frame.
   *  The modal does NOT auto-close — the parent controls `open`. */
  readonly onReady?: (session: ExperienceSessionResponse) => void;
  /** RESTART mode (lobby LB-5 / Б3+Б4): the source session whose frozen
   *  snapshots prefill the form. When non-null, Start becomes a restart —
   *  the server finishes the source match and creates a NEW session under
   *  a fresh seed; `initialSettings`/`participants` overlay the authored
   *  defaults (fields the author added since keep their defaults; snapshot
   *  keys without a current field are ignored). */
  readonly restartSource?: ExperienceSessionResponse | null;
}

/** Canonical display order for the context-mode segmented control. */
const CONTEXT_MODE_ORDER: readonly ExperienceContextMode[] = [
  EXPERIENCE_CONTEXT_MODE.none,
  EXPERIENCE_CONTEXT_MODE.currentBranch,
  EXPERIENCE_CONTEXT_MODE.recent,
  EXPERIENCE_CONTEXT_MODE.summariesRecent,
  EXPERIENCE_CONTEXT_MODE.compactSummary,
];

const CONTEXT_MODE_LABEL_KEYS: Record<ExperienceContextMode, TKey> = {
  [EXPERIENCE_CONTEXT_MODE.none]: "experience_context_none",
  [EXPERIENCE_CONTEXT_MODE.currentBranch]: "experience_context_current_branch",
  [EXPERIENCE_CONTEXT_MODE.recent]: "experience_context_recent",
  [EXPERIENCE_CONTEXT_MODE.summariesRecent]: "experience_context_summaries_recent",
  [EXPERIENCE_CONTEXT_MODE.compactSummary]: "experience_context_compact_summary",
};

const CONTROLLER_LABEL_KEYS: Record<SeatController, TKey> = {
  human: "experience_setup_controller_human",
  script: "experience_setup_controller_script",
  model: "experience_setup_controller_model",
};

/** Fail-closed normalization of the DB config row's broad string fields into the
 *  canonical Domain unions (mirrors InsightsPanel — derived from the Domain
 *  constants, never a duplicate handwritten union or an unverified cast). */
const VALID_CAPABILITY_VALUES: ReadonlySet<string> = new Set(Object.values(EXPERIENCE_CAPABILITY));
const VALID_CONTEXT_MODE_VALUES: ReadonlySet<string> = new Set(Object.values(EXPERIENCE_CONTEXT_MODE));

function normalizeCapabilityGrants(raw: string[] | undefined): ExperienceCapability[] {
  return (raw ?? []).filter((g): g is ExperienceCapability => VALID_CAPABILITY_VALUES.has(g));
}

function isContextMode(raw: string): raw is ExperienceContextMode {
  return VALID_CONTEXT_MODE_VALUES.has(raw);
}

function normalizeContextMode(raw: string | undefined): ExperienceContextMode {
  if (raw !== undefined && isContextMode(raw)) return raw;
  return EXPERIENCE_CONTEXT_MODE.none;
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Overlay a frozen settings snapshot onto seeded defaults (lobby LB-5).
 * Only declared fields with a type-compatible snapshot value are prefilled:
 * select values no longer in the authored option list are DROPPED (the UI must
 * never display an option that does not exist), numbers must be finite, and a
 * no-default boolean maps false back to absent (unchecked). */
function applySnapshotPrefill(
  fields: SetupField[],
  snapshot: Record<string, unknown>,
): { values: Record<string, string | boolean | undefined>; entered: Set<string> } {
  const values: Record<string, string | boolean | undefined> = {};
  const entered = new Set<string>();
  for (const field of fields) {
    if (!(field.id in snapshot)) continue;
    const raw = snapshot[field.id];
    if (field.kind === "text" && typeof raw === "string") {
      values[field.id] = raw;
    } else if (field.kind === "number" && typeof raw === "number" && Number.isFinite(raw)) {
      values[field.id] = String(raw);
      entered.add(field.id);
    } else if (field.kind === "boolean" && typeof raw === "boolean") {
      values[field.id] = field.default === undefined ? (raw === true ? true : undefined) : raw;
    } else if (field.kind === "select" && typeof raw === "string" && field.options.some((o) => o.value === raw)) {
      values[field.id] = raw;
    }
  }
  return { values, entered };
}

/** Map a frozen roster snapshot onto editable seats (lobby LB-5). Seat ids are
 *  reused verbatim (stable, unique); the counter moves past every parseable
 *  `seat_N` suffix AND the roster length so a later Add never collides. */
function seatsFromSnapshot(participants: ExperienceSessionResponse["participants"]): {
  seats: RosterSeat[];
  nextCounter: number;
} {
  const seats: RosterSeat[] = participants.map((p) => {
    const seat: RosterSeat = { id: p.id, label: p.label, controller: p.controller };
    if (p.controller === "model") {
      if (p.providerProfileId !== undefined) seat.providerProfileId = p.providerProfileId;
      if (p.modelId !== undefined) seat.modelId = p.modelId;
      if (p.characterId !== undefined) seat.characterId = p.characterId;
    }
    return seat;
  });
  let maxN = 0;
  for (const seat of seats) {
    const m = /^seat_(\d+)$/.exec(seat.id);
    if (m) maxN = Math.max(maxN, Number(m[1]));
  }
  return { seats, nextCounter: Math.max(maxN, seats.length) + 1 };
}

export function ExperienceSetupModal({
  open,
  chatId,
  branchId,
  onClose,
  onReady,
  restartSource = null,
}: ExperienceSetupModalProps) {
  const { t } = useT();
  const isMobile = useIsMobile();

  // ── Store reads (server-authoritative) ──────────────────────────────────
  const config = useExperienceConfig(chatId, branchId);
  const liveSession = useExperienceSession(chatId, branchId);
  const loading = useExperienceLoading(chatId, branchId);

  // ── Scope epoch: invalidates ALL local async work on scope switch ───────
  const scopeRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // ── Discovery (testScript) state ────────────────────────────────────────
  type DiscoveryState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "ok"; definition: ExperienceDefinitionDto }
    | { status: "error"; message: string | null };
  const [discovery, setDiscovery] = useState<DiscoveryState>({ status: "idle" });

  // ── Setup-field draft values + per-field errors ─────────────────────────
  // text/select → string; number → string (raw, parsed at submit); boolean →
  // boolean | undefined (undefined = absent / untouched no-default).
  const [fieldValues, setFieldValues] = useState<Record<string, string | boolean | undefined>>({});
  // Number fields track an `entered` flag so an untouched no-default number
  // (displayed as 0 by NumberInput) stays ABSENT from the submitted settings.
  const [numberEntered, setNumberEntered] = useState<Set<string>>(new Set());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // ── Roster (participants capability) ────────────────────────────────────
  const seatCounterRef = useRef(1);
  const [roster, setRoster] = useState<RosterSeat[]>([{ id: "seat_1", label: "", controller: "human" }]);
  const [rosterError, setRosterError] = useState<string | null>(null);
  // ── Character-backed seat picker (report item 6b) ──────────────────────
  const [addCharOpen, setAddCharOpen] = useState(false);
  const [pendingCharIds, setPendingCharIds] = useState<ReadonlySet<string>>(new Set());

  // ── Provider/model selection (model capability) ─────────────────────────
  const [providerProfiles, setProviderProfiles] = useState<ProviderProfileRecord[] | null>(null);
  const [providerLoadError, setProviderLoadError] = useState<string | null>(null);
  const [modelsByProfile, setModelsByProfile] = useState<Record<string, ProviderModelOption[]>>({});
  const [loadingProfiles, setLoadingProfiles] = useState<ReadonlySet<string>>(new Set());

  // ── Context mode + phase machine ────────────────────────────────────────
  const [localContextMode, setLocalContextMode] = useState<ExperienceContextMode | null>(null);
  // ── User-chosen RP-context source (report item 6): null = uninitialized,
  //  mirrors the localContextMode init-once pattern. ───────────────────────
  const [localSource, setLocalSource] = useState<{ characterId: string | null; chatId: string | null; personaId: string | null } | null>(null);
  const [phase, setPhase] = useState<Phase>("config");
  const [phaseError, setPhaseError] = useState<string | null>(null);
  const [pendingStart, setPendingStart] = useState(false);
  const [pendingCapture, setPendingCapture] = useState(false);
  const [pendingSave, setPendingSave] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // ── Compact-summary generation selectors (independent of any seat) ───────
  const [summaryProviderId, setSummaryProviderId] = useState<string>("");
  const [summaryModelId, setSummaryModelId] = useState<string>("");

  // ── Prompt overrides (model capability, post-start) ─────────────────────
  const [overrides, setOverrides] = useState<ExperiencePromptOverridesResponse | null>(null);
  const [overrideDrafts, setOverrideDrafts] = useState<{ global: string; character: string }>({
    global: "",
    character: "",
  });

  // ── Hydrate the store scope when the modal opens for the exact scope ────
  useEffect(() => {
    if (!open) return;
    useExperienceStore.getState().setScope(chatId, branchId);
  }, [open, chatId, branchId]);

  // ── Reset ALL local form/async state on scope switch + bump the epoch ───
  useEffect(() => {
    scopeRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    setDiscovery({ status: "idle" });
    setFieldValues({});
    setNumberEntered(new Set());
    setFieldErrors({});
    seatCounterRef.current = 1;
    setRoster([{ id: "seat_1", label: "", controller: "human" }]);
    setRosterError(null);
    setAddCharOpen(false);
    setPendingCharIds(new Set());
    setProviderProfiles(null);
    setProviderLoadError(null);
    setModelsByProfile({});
    setLoadingProfiles(new Set());
    setLocalContextMode(null);
    setLocalSource(null);
    setPhase("config");
    setPhaseError(null);
    setPendingStart(false);
    setPendingCapture(false);
    setPendingSave(false);
    setSaveError(null);
    setSummaryProviderId("");
    setSummaryModelId("");
    setOverrides(null);
    setOverrideDrafts({ global: "", character: "" });
  }, [chatId, branchId]);

  // Derived config values (fail-closed normalization).
  const scriptId = config?.scriptId ?? null;
  const grants = normalizeCapabilityGrants(config?.capabilityGrants);
  const configContextMode = normalizeContextMode(config?.contextMode);

  // Initialize the local context mode from the confirmed config exactly once
  // per scope (do not clobber the user's local edits on a later rehydrate).
  useEffect(() => {
    if (localContextMode === null) setLocalContextMode(configContextMode);
  }, [configContextMode, localContextMode]);

  // Same init-once pattern for the RP-context source (report item 6).
  const configSourceCharacterId = config?.contextSourceCharacterId ?? null;
  const configSourceChatId = config?.contextSourceChatId ?? null;
  const configSourcePersonaId = config?.contextSourcePersonaId ?? null;
  useEffect(() => {
    if (localSource === null)
      setLocalSource({ characterId: configSourceCharacterId, chatId: configSourceChatId, personaId: configSourcePersonaId });
  }, [configSourceCharacterId, configSourceChatId, configSourcePersonaId, localSource]);
  const sourceCharacterId = localSource?.characterId ?? configSourceCharacterId;
  const sourceChatId = localSource?.chatId ?? configSourceChatId;
  const sourcePersonaId = localSource?.personaId ?? configSourcePersonaId;

  // ── Source picker data (report item 6) ──
  const allCharacters = useAllCharacters();
  const chatList = useChatList();
  const characterById = useMemo(() => new Map(allCharacters.map((c) => [c.id, c])), [allCharacters]);
  const sortedAllCharacters = useMemo(
    () => [...allCharacters].sort((a, b) => a.name.localeCompare(b.name)),
    [allCharacters],
  );
  const sourceCharacterOptions = useMemo(
    () =>
      [...allCharacters]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((c) => ({ id: c.id, label: c.name })),
    [allCharacters],
  );
  const sourceChatOptions = useMemo(() => {
    const scoped = sourceCharacterId ? chatList.filter((c) => c.characterId === sourceCharacterId) : chatList;
    return [...scoped]
      .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
      .map((c) => ({ id: c.id, label: c.title }));
  }, [chatList, sourceCharacterId]);

  // Wave 3 (PS-4): the persona list for the identity picker — fetched once per
  // modal mount, best-effort (a transient failure just leaves the picker empty,
  // same swallow-with-comment style as the copilot catalog fetch).
  const [personaList, setPersonaList] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    let cancelled = false;
    listPersonas()
      .then((personas) => {
        if (cancelled) return;
        setPersonaList(personas.map((p) => ({ id: p.id, name: p.name })));
      })
      .catch(() => {
        /* best-effort: empty picker, ambient identity stays available */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const sourcePersonaOptions = useMemo(
    () => [...personaList].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ id: p.id, label: p.name })),
    [personaList],
  );

  /** Pick the persona source (Wave 3 user-identity override); "" selects the
   *  ambient host-chat persona. Independent of the character/chat source. */
  function pickSourcePersona(id: string): void {
    setLocalSource({ characterId: sourceCharacterId, chatId: sourceChatId, personaId: id === "" ? null : id });
  }

  const sourcePersonaPreviewText = (() => {
    if (sourcePersonaId === null) return null;
    const name = personaList.find((p) => p.id === sourcePersonaId)?.name ?? sourcePersonaId;
    return t("experience_setup_source_preview_persona", { persona: name });
  })();

  /** Pick a source character; "" selects the ambient default. A chat that
   *  does not belong to the newly chosen character is dropped. */
  function pickSourceCharacter(id: string): void {
    const characterId = id === "" ? null : id;
    const chatStillFits =
      sourceChatId !== null && chatList.some((c) => c.id === sourceChatId && c.characterId === characterId);
    setLocalSource({ characterId, chatId: chatStillFits ? sourceChatId : null, personaId: sourcePersonaId });
  }

  /** Pick a source chat; "" clears it. Picking a chat auto-substitutes its
   *  character (an explicit re-pick can still override afterwards). */
  function pickSourceChat(id: string): void {
    const chatId = id === "" ? null : id;
    const chat = chatId !== null ? chatList.find((c) => c.id === chatId) : undefined;
    const characterId = chat ? (chat.characterId as string) : sourceCharacterId;
    setLocalSource({ characterId, chatId, personaId: sourcePersonaId });
  }

  const sourcePreviewText = (() => {
    const charName = sourceCharacterId ? (characterById.get(sourceCharacterId)?.name ?? sourceCharacterId) : null;
    const chatTitle = sourceChatId ? (chatList.find((c) => c.id === sourceChatId)?.title ?? sourceChatId) : null;
    if (charName !== null && chatTitle !== null) return t("experience_setup_source_preview_both", { character: charName, chat: chatTitle });
    if (chatTitle !== null) return t("experience_setup_source_preview_chat", { chat: chatTitle });
    if (charName !== null) return t("experience_setup_source_preview_character", { character: charName });
    return t("experience_setup_source_preview_ambient");
  })();

  // Effective capabilities: declared AND granted. Derived only from a clean ok
  // discovery so a stale/loading/error discovery never paints capability chrome.
  const declaredCapabilities =
    discovery.status === "ok" ? discovery.definition.declaredCapabilities : [];
  const declaredSet = new Set(declaredCapabilities.map((d) => d.capability));
  const effectiveGrants = grants.filter((g) => declaredSet.has(g));

  const participantsGranted =
    declaredSet.has(EXPERIENCE_CAPABILITY.participants) && effectiveGrants.includes(EXPERIENCE_CAPABILITY.participants);
  const modelGranted =
    declaredSet.has(EXPERIENCE_CAPABILITY.model) && effectiveGrants.includes(EXPERIENCE_CAPABILITY.model);
  const rpContextGranted =
    declaredSet.has(EXPERIENCE_CAPABILITY.rpContext) && effectiveGrants.includes(EXPERIENCE_CAPABILITY.rpContext);

  const setupFields: SetupField[] =
    discovery.status === "ok" && discovery.definition.setup ? discovery.definition.setup.fields : [];

  // ── Discovery effect: real testScript(config.scriptId, {}) ──────────────
  // Proceeds only for kind "interactive", non-null definition, null discovery
  // error (the assignment contract). `cancelled` invalidates same-scope
  // re-runs (scriptId change); the scope epoch invalidates cross-scope.
  useEffect(() => {
    if (!open || scriptId === null) {
      setDiscovery({ status: "idle" });
      return;
    }
    let cancelled = false;
    const gen = scopeRef.current;
    setDiscovery({ status: "loading" });
    testScript(scriptId, {})
      .then((result) => {
        if (cancelled || scopeRef.current !== gen) return;
        // Narrow to the interactive variant BEFORE reading discovery fields —
        // `testScript` returns the full prompt/dice/interactive union, and TS
        // cannot narrow across `||` boundaries (mirrors ExperienceAssignment).
        if (result.kind !== "interactive") {
          // No detail: the title already conveys "not interactive"; a duplicated
          // string would create two identical text nodes.
          setDiscovery({ status: "error", message: null });
          return;
        }
        if (result.discoveryError !== null || result.definition === null) {
          setDiscovery({ status: "error", message: result.discoveryError ?? t("experience_setup_discovery_error") });
          return;
        }
        setDiscovery({ status: "ok", definition: result.definition });
      })
      .catch((err: unknown) => {
        if (cancelled || scopeRef.current !== gen) return;
        setDiscovery({ status: "error", message: toMessage(err) });
      });
    return () => {
      cancelled = true;
    };
  }, [open, scriptId, chatId, branchId, t]);

  // ── Seed setup-field defaults on a clean discovery / scope ──────────────
  // Only fields with an author `default` are seeded; optional untouched fields
  // with no default stay ABSENT (preservation of omission). Number fields with
  // a default are marked `entered` so they submit as real values.
  useEffect(() => {
    if (discovery.status !== "ok") return;
    const fields = discovery.definition.setup?.fields ?? [];
    const { values, entered } = seedSetupDefaults(fields);
    // Restart prefill (LB-5): overlay the frozen settings snapshot over the
    // authored defaults, and rebuild the roster from the frozen participants.
    if (restartSource !== null) {
      const snapshot = restartSource.initialSettings;
      if (typeof snapshot === "object" && snapshot !== null && !Array.isArray(snapshot)) {
        const prefill = applySnapshotPrefill(fields, snapshot as Record<string, unknown>);
        Object.assign(values, prefill.values);
        for (const id of prefill.entered) entered.add(id);
      }
      if (restartSource.participants.length > 0) {
        const { seats, nextCounter } = seatsFromSnapshot(restartSource.participants);
        setRoster(seats);
        seatCounterRef.current = nextCounter;
        // Prefilled model seats need their provider's model list loaded so the
        // dropdown renders the pinned model instead of a blank option.
        for (const seat of seats) {
          if (seat.controller === "model" && seat.providerProfileId !== undefined) ensureModels(seat.providerProfileId);
        }
      }
    }
    setFieldValues(values);
    setNumberEntered(entered);
    setFieldErrors({});
    // restartSource is a stable parent-held snapshot keyed to the open that
    // produced it; re-running only on a fresh discovery would drop the
    // prefill if discovery re-fires (e.g. a config-driven scriptId change).
  }, [discovery, restartSource]);

  // ── Load provider profiles when a provider/model selector is live ─────────
  // Model seats need them (model capability), and compact-summary generation
  // exposes explicit provider/model selectors even when the model capability
  // is absent (it is an rp_context mode), so providers load under either grant.
  // Loaded once per scope; cached models are per-profile.
  useEffect(() => {
    if (!open || (!modelGranted && !rpContextGranted)) {
      setProviderProfiles(null);
      return;
    }
    let cancelled = false;
    const gen = scopeRef.current;
    listProviderProfiles()
      .then((profiles) => {
        if (cancelled || scopeRef.current !== gen) return;
        setProviderProfiles(profiles);
      })
      .catch((err: unknown) => {
        if (cancelled || scopeRef.current !== gen) return;
        setProviderProfiles([]);
        setProviderLoadError(toMessage(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, modelGranted, rpContextGranted]);

  /** Fetch + cache a provider's models (scope-guarded, idempotent per profile). */
  function ensureModels(profileId: string): void {
    if (profileId === "" || modelsByProfile[profileId] || loadingProfiles.has(profileId)) return;
    const gen = scopeRef.current;
    setLoadingProfiles((prev) => new Set(prev).add(profileId));
    fetchProviderProfileModels(profileId)
      .then((res) => {
        if (scopeRef.current !== gen) return;
        setModelsByProfile((prev) => ({ ...prev, [profileId]: res.models }));
      })
      .catch(() => {
        if (scopeRef.current !== gen) return;
        // An empty model list for a provider is a usable inline error surface,
        // never a crash; the seat's model dropdown simply shows none available.
        setModelsByProfile((prev) => ({ ...prev, [profileId]: [] }));
      })
      .finally(() => {
        if (scopeRef.current !== gen) return;
        setLoadingProfiles((prev) => {
          const next = new Set(prev);
          next.delete(profileId);
          return next;
        });
      });
  }

  /** Model dropdown options for a provider: the fetched models plus the
   *  configured profile's default model (usable even when the listing omits
   *  it). */
  function modelOptionsFor(profileId: string): Array<{ id: string; label: string }> {
    const fetched = modelsByProfile[profileId] ?? [];
    const options = fetched.map((m) => ({ id: m.id, label: m.label || m.id }));
    const profile = (providerProfiles ?? []).find((p) => p.id === profileId);
    if (profile?.defaultModel && !options.some((o) => o.id === profile.defaultModel)) {
      options.push({ id: profile.defaultModel, label: profile.defaultModel });
    }
    return options;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Field editing
  // ═════════════════════════════════════════════════════════════════════════

  function setFieldValue(id: string, value: string | boolean | undefined): void {
    setFieldValues((prev) => ({ ...prev, [id]: value }));
    setFieldErrors((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }

  /** Boolean toggle: a no-default boolean cycles absent ↔ true (unchecked stays
   *  absent); a defaulted boolean toggles true/false. */
  function toggleBoolean(field: SetupField): void {
    if (field.kind !== "boolean") return;
    const current = fieldValues[field.id];
    if (field.default === undefined) {
      // absent(undefined) → true → absent. Unchecking restores absence.
      setFieldValue(field.id, current === true ? undefined : true);
    } else {
      setFieldValue(field.id, !(current === true));
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Roster editing
  // ═════════════════════════════════════════════════════════════════════════

  function addSeat(): void {
    if (roster.length >= INTERACTIVE_SCHEMA_MAX_PARTICIPANTS) return;
    seatCounterRef.current += 1;
    // New seats default to a script controller (the seed already holds the one
    // required human seat); model is only offered when granted.
    setRoster((prev) => [...prev, { id: `seat_${seatCounterRef.current}`, label: "", controller: "script" }]);
    setRosterError(null);
  }

  function removeSeat(id: string): void {
    setRoster((prev) => prev.filter((s) => s.id !== id));
    setRosterError(null);
  }

  // ── Character-backed seat picker (report item 6b) ──────────────────────

  function openAddCharacter(): void {
    if (roster.length >= INTERACTIVE_SCHEMA_MAX_PARTICIPANTS) return;
    setPendingCharIds(new Set());
    setAddCharOpen(true);
    setRosterError(null);
  }

  function togglePendingCharacter(id: string): void {
    setPendingCharIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  /** Confirmed: each selected character becomes a model seat with its name as
   *  the (editable) label and its id pinned. Duplicates across seats are legal
   *  (user decision — «same character, different model»); the participant
   *  ceiling caps how many can be added at once. */
  function confirmAddCharacters(): void {
    const available = INTERACTIVE_SCHEMA_MAX_PARTICIPANTS - roster.length;
    if (available <= 0) {
      setAddCharOpen(false);
      setPendingCharIds(new Set());
      return;
    }
    const selected = sortedAllCharacters.filter((c) => pendingCharIds.has(c.id)).slice(0, available);
    const newSeats: RosterSeat[] = selected.map((c) => {
      seatCounterRef.current += 1;
      return { id: `seat_${seatCounterRef.current}`, label: c.name, controller: "model", characterId: c.id };
    });
    setRoster((prev) => [...prev, ...newSeats]);
    setAddCharOpen(false);
    setPendingCharIds(new Set());
    setRosterError(null);
  }

  function cancelAddCharacter(): void {
    setAddCharOpen(false);
    setPendingCharIds(new Set());
  }

  function patchSeat(id: string, patch: Partial<RosterSeat>): void {
    setRoster((prev) => prev.map((s) => (s.id === id ? { ...s, ...patch } : s)));
    setRosterError(null);
  }

  /** Changing a seat's provider clears its pinned model and loads the new
   *  provider's models. */
  function setSeatProvider(id: string, profileId: string): void {
    patchSeat(id, { providerProfileId: profileId, modelId: undefined });
    if (profileId !== "") ensureModels(profileId);
  }

  /** Changing a seat's controller: switching AWAY from model strips the
   *  provider/model assignment AND any character backing; switching TO model
   *  leaves them unset (no active-profile fallback for new sessions). */
  function setSeatController(id: string, controller: SeatController): void {
    if (controller === "model") {
      patchSeat(id, { controller });
    } else {
      patchSeat(id, { controller, providerProfileId: undefined, modelId: undefined, characterId: undefined });
    }
  }

  /** The controllers offered for a seat: human + script always; model only when
   *  the model capability is declared AND granted. */
  function controllerOptions(): Array<{ value: SeatController; label: string }> {
    const opts: Array<{ value: SeatController; label: string }> = [
      { value: "human", label: t(CONTROLLER_LABEL_KEYS.human) },
      { value: "script", label: t(CONTROLLER_LABEL_KEYS.script) },
    ];
    if (modelGranted) opts.push({ value: "model", label: t(CONTROLLER_LABEL_KEYS.model) });
    return opts;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Validation + Start
  // ═════════════════════════════════════════════════════════════════════════

  /** Validate setup fields → a clean bounded settings object (omitting optional
   *  untouched empties) or null when invalid, recording per-field errors. */
  function validateSettings(): Record<string, unknown> | null {
    const result = validateSetupFields({ fields: setupFields, values: fieldValues, entered: numberEntered, t });
    if (!result.ok) {
      setFieldErrors(result.errors);
      return null;
    }
    setFieldErrors({});
    return result.settings;
  }

  /** Validate the roster → a clean start-participant array or null when
   *  invalid. Rejects blank/duplicate ids, blank/overlong labels, >16, and zero
   *  or >1 human controller; every model seat must pin both provider + model. */
  function validateRoster(): ExperienceStartRequest["participants"] | null {
    const ids = new Set<string>();
    let humanCount = 0;
    for (const seat of roster) {
      if (seat.id === "" || ids.has(seat.id)) {
        setRosterError(t("experience_setup_roster_duplicate_id"));
        return null;
      }
      ids.add(seat.id);
      if (seat.label.trim() === "") {
        setRosterError(t("experience_setup_roster_label_blank"));
        return null;
      }
      if (seat.label.length > INTERACTIVE_SCHEMA_MAX_LABEL) {
        setRosterError(t("experience_setup_roster_label_long"));
        return null;
      }
      if (seat.controller === "human") humanCount += 1;
      if (seat.controller === "model" && (seat.providerProfileId === undefined || seat.modelId === undefined)) {
        setRosterError(t("experience_setup_model_seat_incomplete"));
        return null;
      }
    }
    if (humanCount !== 1) {
      setRosterError(t("experience_setup_roster_human_count"));
      return null;
    }
    setRosterError(null);
    return roster.map((seat) => {
      const base = { id: seat.id, label: seat.label, controller: seat.controller };
      if (seat.controller === "model") {
        return {
          ...base,
          providerProfileId: seat.providerProfileId!,
          modelId: seat.modelId!,
          ...(seat.characterId !== undefined ? { characterId: seat.characterId } : {}),
        };
      }
      return base;
    });
  }

  /** Begin context capture/generation for the active local mode (post-start). */
  async function runContextCapture(mode: ExperienceContextMode, gen: number): Promise<void> {
    // Compact summary never auto-runs — the user must click Generate.
    if (mode === EXPERIENCE_CONTEXT_MODE.compactSummary) {
      setPhase("awaiting-summary");
      return;
    }
    if (mode === EXPERIENCE_CONTEXT_MODE.none) {
      setPhase("ready");
      return;
    }
    // current_branch / recent / summaries_recent — explicit capture before ready.
    setPhase("capturing");
    setPhaseError(null);
    setPendingCapture(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const result = await useExperienceStore.getState().captureContext({ mode }, controller.signal);
    if (scopeRef.current !== gen) return; // stale scope — discard silently
    setPendingCapture(false);
    if (result === null) {
      // Failure: retain the active session + modal; surface retry / change-mode.
      setPhaseError(t("experience_setup_capture_error"));
      setPhase("capturing");
    } else {
      setPhase("ready");
    }
  }

  /** Explicit compact-summary generation (only from the Generate click). */
  async function runSummaryGeneration(gen: number): Promise<void> {
    if (pendingCapture) return;
    setPhase("generating-summary");
    setPhaseError(null);
    setPendingCapture(true);
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const body: ExperienceContextCaptureRequest = { mode: EXPERIENCE_CONTEXT_MODE.compactSummary };
    if (summaryProviderId !== "") body.providerProfileId = summaryProviderId;
    if (summaryModelId !== "") body.model = summaryModelId;
    const result = await useExperienceStore.getState().captureContext(body, controller.signal);
    if (scopeRef.current !== gen) return;
    setPendingCapture(false);
    if (result === null) {
      setPhaseError(t("experience_setup_generate_error"));
      setPhase("awaiting-summary");
    } else {
      setPhase("ready");
    }
  }

  /** The primary Start action. */
  async function handleStart(): Promise<void> {
    if (pendingStart || discovery.status !== "ok") return;
    const gen = scopeRef.current;

    // 1. Validate settings + roster before any mutation.
    const settings = validateSettings();
    if (settings === null) return;
    const validatedParticipants = participantsGranted ? validateRoster() : [];
    if (validatedParticipants === null) return;
    const participants: ExperienceStartRequest["participants"] = validatedParticipants;

    // 2. Assert the store active scope still equals the exact props scope — a
    //    stale scope fails locally instead of starting on another branch.
    const active = useExperienceStore.getState().activeScope;
    if (!active || active.chatId !== chatId || active.branchId !== branchId) {
      setPhaseError(t("experience_setup_scope_error"));
      return;
    }

    setPendingStart(true);
    setPhaseError(null);

    try {
      // 3. If the local context mode / source differ from the confirmed config,
      //    persist them first (backend config remains authority), then await an
      //    exact-scope rehydrate, THEN start. Never widen the start request.
      //    The capture that follows start-up reads the persisted config — one
      //    source of truth, no per-capture override needed on this path.
      const mode = localContextMode ?? configContextMode;
      const sourceDirty =
        sourceCharacterId !== configSourceCharacterId ||
        sourceChatId !== configSourceChatId ||
        sourcePersonaId !== configSourcePersonaId;
      if (rpContextGranted && (mode !== configContextMode || sourceDirty)) {
        await updateExperienceConfig(chatId, {
          ...(mode !== configContextMode ? { contextMode: mode } : {}),
          contextSourceCharacterId: sourceCharacterId,
          contextSourceChatId: sourceChatId,
          contextSourcePersonaId: sourcePersonaId,
        });
        if (scopeRef.current !== gen) return;
        await useExperienceStore.getState().rehydrate(chatId, branchId);
        if (scopeRef.current !== gen) return;
      }

      // 4. Start — or RESTART — the session through the store (server-
      //    authoritative). In restart mode (LB-5) the server finishes the
      //    source match and creates the successor; the roster is sent only
      //    when the participants capability is granted, else the server falls
       //   back to the source's frozen roster.
      const session = restartSource !== null
        ? await useExperienceStore.getState().restartSession({
            settings,
            ...(participantsGranted ? { participants } : {}),
          })
        : await useExperienceStore.getState().startSession(settings, participants);
      if (scopeRef.current !== gen) return;
      if (!session) {
        // The store surfaced a structured error (stale/conflict/no_provider…)
        // — it resynced and set lastError. Show it as an inline Start error and
        // keep the modal in the config phase; never crash.
        const err = useExperienceStore.getState().byScope[`${JSON.stringify([chatId, branchId])}`]?.lastError;
        setPhaseError(err ?? t("experience_setup_start_error"));
        setPendingStart(false);
        return;
      }

      setPendingStart(false);

      // 5. Model-only prompt overrides: load both independent layers now that a
      //    session exists (capability grant is the gate, never the provider).
      if (modelGranted) {
        void getExperiencePromptOverrides(session.sessionId)
          .then((res) => {
            if (scopeRef.current !== gen) return;
            setOverrides(res);
            setOverrideDrafts({
              global: res.global?.content ?? "",
              character: res.character?.content ?? "",
            });
          })
          .catch((err: unknown) => {
            if (scopeRef.current !== gen) return;
            // A failed override load never blocks the session — Continue stays
            // available; the error surfaces inline on the overrides section.
            setSaveError(toMessage(err));
          });
      }

      // 6. Enter the context-preparation phase for the active mode.
      await runContextCapture(mode, gen);
    } catch (err) {
      if (scopeRef.current !== gen) return;
      setPhaseError(toMessage(err));
      setPendingStart(false);
    }
  }

  /** Continue / Open: settle prompt overrides (write only changed layers) then
   *  fire onReady so IR-73B can launch the frame. */
  async function handleContinue(): Promise<void> {
    if (pendingSave) return;
    const session = liveSession;
    if (!session) return;
    const gen = scopeRef.current;

    if (modelGranted && overrides !== null) {
      const writes: Array<Promise<ExperiencePromptOverridesResponse>> = [];
      const globalNeedsWrite =
        overrides.global !== null
          ? overrideDrafts.global !== overrides.global.content
          : overrideDrafts.global !== "";
      const characterNeedsWrite =
        overrides.character !== null
          ? overrideDrafts.character !== overrides.character.content
          : overrideDrafts.character !== "";
      if (globalNeedsWrite) {
        writes.push(updateExperienceGlobalOverride(session.sessionId, { content: overrideDrafts.global }));
      }
      if (characterNeedsWrite) {
        writes.push(updateExperienceCharacterOverride(session.sessionId, { content: overrideDrafts.character }));
      }
      if (writes.length > 0) {
        setPendingSave(true);
        setSaveError(null);
        const results = await Promise.allSettled(writes);
        if (scopeRef.current !== gen) return;
        if (results.some((r) => r.status === "rejected")) {
          // A partial/failing write stays visible with an inline error; do not
          // pretend success and do not discard the active session.
          setSaveError(t("experience_setup_overrides_save_error"));
          setPendingSave(false);
          return;
        }
        // Merge the latest combined layers from the last successful response.
        const last = results.find((r) => r.status === "fulfilled");
        if (last && last.status === "fulfilled") {
          setOverrides(last.value);
          setOverrideDrafts({
            global: last.value.global?.content ?? "",
            character: last.value.character?.content ?? "",
          });
        }
        setPendingSave(false);
      }
    }
    onReady?.(session);
  }

  /** Change the context mode (local until Start; post-start it re-prepares the
   *  selected mode with no silent fallback). */
  async function changeContextMode(mode: ExperienceContextMode): Promise<void> {
    setLocalContextMode(mode);
    setPhaseError(null);
    // Only re-prepare if a session already exists (post-start mode change).
    if (phase !== "config" && liveSession) {
      const gen = scopeRef.current;
      await runContextCapture(mode, gen);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Close: abort generation, never end the session
  // ═════════════════════════════════════════════════════════════════════════

  function handleClose(): void {
    // Abort any in-flight context generation; the created session persists.
    abortRef.current?.abort();
    abortRef.current = null;
    setPendingCapture(false);
    onClose();
  }

  // ── Render-time flags ────────────────────────────────────────────────────
  const discovering = discovery.status === "loading";
  const configLoading = loading && config === null;
  const noScript = scriptId === null;
  const ready = phase === "ready";
  const contextControls = rpContextGranted;
  const effectiveMode = localContextMode ?? configContextMode;

  const providerOptions = useMemo(
    () => (providerProfiles ?? []).map((p) => ({ id: p.id, label: p.name })),
    [providerProfiles],
  );
  const providersAvailable = (providerProfiles?.length ?? 0) > 0;
  // Model seats need a provider+model each; if none are configured, block Start.
  const hasModelSeat = roster.some((s) => s.controller === "model");
  const modelSeatIncomplete =
    hasModelSeat && roster.some((s) => s.controller === "model" && (s.providerProfileId === undefined || s.modelId === undefined));
  const noProvidersForModelSeat = modelGranted && hasModelSeat && !providersAvailable;

  // ── Body content per state ───────────────────────────────────────────────
  let body: ReactNode;
  if (configLoading) {
    body = <p className="font-ui text-[12px] text-t4">{t("experience_setup_loading_config")}</p>;
  } else if (noScript) {
    body = <p className="font-ui text-[12px] leading-relaxed text-t4">{t("experience_setup_no_script")}</p>;
  } else if (discovering) {
    body = <p className="font-ui text-[12px] text-t4">{t("experience_setup_discovering")}</p>;
  } else if (discovery.status === "error") {
    body = <ErrorBox title={t("experience_setup_discovery_error")} detail={discovery.message} />;
  } else if (discovery.status === "ok") {
    body = (
      <div className="flex flex-col gap-4">
        {phase === "config" ? (
          <>
            {/* Package-declared settings */}
            <Section label={t("experience_setup_settings_label")}>
              {setupFields.length === 0 ? (
                <p className="font-ui text-[12px] leading-relaxed text-t4">{t("experience_setup_no_settings")}</p>
              ) : (
                <div className="flex flex-col gap-2.5">
                  {setupFields.map((field) => (
                    <SetupFieldRow key={field.id} field={field} value={fieldValues[field.id]} error={fieldErrors[field.id]} t={t} onText={(v) => setFieldValue(field.id, v)} onNumber={(v) => { setNumberEntered((prev) => new Set(prev).add(field.id)); setFieldValue(field.id, String(v)); }} onToggle={() => toggleBoolean(field)} onSelect={(v) => setFieldValue(field.id, v)} />
                  ))}
                </div>
              )}
            </Section>

            {/* Participant roster (participants declared + granted) */}
            {participantsGranted && (
              <Section label={t("experience_setup_participants_label")}>
                <div className="flex flex-col gap-2">
                  {roster.map((seat) => (
                    <RosterRow
                      key={seat.id}
                      seat={seat}
                      modelGranted={modelGranted}
                      characterName={seat.characterId !== undefined ? (characterById.get(seat.characterId)?.name ?? seat.characterId) : null}
                      controllerOptions={controllerOptions()}
                      providerOptions={providerOptions}
                      modelOptions={seat.providerProfileId ? modelOptionsFor(seat.providerProfileId) : []}
                      modelsLoading={seat.providerProfileId ? loadingProfiles.has(seat.providerProfileId) : false}
                      t={t}
                      onController={(c) => setSeatController(seat.id, c)}
                      onLabel={(v) => patchSeat(seat.id, { label: v })}
                      onProvider={(p) => setSeatProvider(seat.id, p)}
                      onModel={(m) => patchSeat(seat.id, { modelId: m })}
                      onRemove={() => removeSeat(seat.id)}
                    />
                  ))}
                  {roster.length >= INTERACTIVE_SCHEMA_MAX_PARTICIPANTS ? (
                    <p className="font-ui text-[11px] text-t4">{t("experience_setup_roster_full")}</p>
                  ) : (
                    <div className="flex flex-wrap items-center gap-2 self-start">
                      <button
                        type="button"
                        className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 font-ui text-[12px] text-t3 hover:border-accent hover:text-accent"
                        onClick={addSeat}
                        data-testid="experience-setup-add-seat"
                      >
                        <Ic.plus />
                        {t("experience_setup_add_participant")}
                      </button>
                      {modelGranted && (
                        <button
                          type="button"
                          className="flex items-center gap-1.5 rounded-md border border-dashed border-border px-2.5 py-1.5 font-ui text-[12px] text-t3 hover:border-accent hover:text-accent"
                          onClick={openAddCharacter}
                          data-testid="experience-setup-add-character"
                        >
                          <Ic.plus />
                          {t("experience_setup_add_character")}
                        </button>
                      )}
                    </div>
                  )}
                  {addCharOpen && (
                    <div className="flex flex-col gap-2 rounded-md border border-border bg-s2 px-2.5 py-2">
                      <div className="flex items-center justify-between">
                        <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">
                          {t("experience_setup_add_character_picker_title")}
                        </span>
                        <button
                          type="button"
                          className="shrink-0 rounded p-1 text-t4 hover:bg-s3 hover:text-t1"
                          onClick={cancelAddCharacter}
                          aria-label={t("experience_setup_remove_participant")}
                        >
                          <Ic.close />
                        </button>
                      </div>
                      {sortedAllCharacters.length === 0 ? (
                        <p className="font-ui text-[12px] text-t4">{t("experience_setup_add_character_empty")}</p>
                      ) : (
                        <div className="flex max-h-48 flex-col gap-1 overflow-y-auto">
                          {sortedAllCharacters.map((c) => (
                            <Checkbox
                              key={c.id}
                              checked={pendingCharIds.has(c.id)}
                              onChange={() => togglePendingCharacter(c.id)}
                              label={c.name}
                            />
                          ))}
                        </div>
                      )}
                      <div className="flex items-center justify-end">
                        <button
                          type="button"
                          className="rounded-md border border-accent px-2.5 py-1 font-ui text-[12px] text-accent hover:bg-accent/10 disabled:pointer-events-none disabled:opacity-40"
                          onClick={confirmAddCharacters}
                          disabled={pendingCharIds.size === 0}
                          data-testid="experience-setup-add-character-confirm"
                        >
                          {t("experience_setup_add_character_confirm")}
                        </button>
                      </div>
                    </div>
                  )}
                  {rosterError && <FieldError text={rosterError} />}
                  {noProvidersForModelSeat && <FieldError text={t("experience_setup_no_providers")} />}
                  {providerLoadError && <FieldError text={t("experience_setup_provider_load_error")} />}
                </div>
              </Section>
            )}

            {/* RP context mode (rp_context declared + granted) */}
            {contextControls && (
              <Section label={t("experience_setup_context_label")}>
                <SegmentedControl
                  value={effectiveMode}
                  options={CONTEXT_MODE_ORDER.map((mode) => ({
                    value: mode,
                    label: t(CONTEXT_MODE_LABEL_KEYS[mode]),
                  }))}
                  onChange={(v) => changeContextMode(v as ExperienceContextMode)}
                  compact
                  wrap
                  disabled={pendingStart}
                />
                {/* User-chosen RP-context source (report item 6) */}
                <div className="mt-2 flex flex-col gap-1.5">
                  <div className="flex flex-col gap-1.5 sm:flex-row">
                    <div className="flex-1">
                      <DropdownSelect
                        value={sourceCharacterId ?? ""}
                        options={sourceCharacterOptions}
                        defaultOption={t("experience_setup_source_ambient")}
                        placeholder={t("experience_setup_source_character_placeholder")}
                        onChange={pickSourceCharacter}
                        disabled={pendingStart}
                      />
                    </div>
                    <div className="flex-1">
                      <DropdownSelect
                        value={sourceChatId ?? ""}
                        options={sourceChatOptions}
                        defaultOption={t("experience_setup_source_no_chat")}
                        placeholder={t("experience_setup_source_chat_placeholder")}
                        onChange={pickSourceChat}
                        disabled={pendingStart}
                      />
                    </div>
                  </div>
                  {/* Wave 3 (PS-4): persona source — a SEPARATE picker row
                      (user identity override, independent of char/chat). */}
                  <div className="flex flex-col gap-1.5 sm:flex-row">
                    <div className="flex-1">
                      <DropdownSelect
                        value={sourcePersonaId ?? ""}
                        options={sourcePersonaOptions}
                        defaultOption={t("experience_setup_source_persona_ambient")}
                        placeholder={t("experience_setup_source_persona_placeholder")}
                        onChange={pickSourcePersona}
                        disabled={pendingStart}
                      />
                    </div>
                  </div>
                  <p className="text-xs text-text-secondary" data-testid="experience-setup-source-preview">
                    {sourcePreviewText}
                  </p>
                  {sourcePersonaPreviewText !== null && (
                    <p className="text-xs text-text-secondary" data-testid="experience-setup-source-persona-preview">
                      {sourcePersonaPreviewText}
                    </p>
                  )}
                </div>
              </Section>
            )}
          </>
        ) : (
          <PreparationBody
            phase={phase}
            mode={effectiveMode}
            phaseError={phaseError}
            pendingCapture={pendingCapture}
            modelGranted={modelGranted}
            overrides={overrides}
            overrideDrafts={overrideDrafts}
            saveError={saveError}
            pendingSave={pendingSave}
            providerOptions={providerOptions}
            modelsLoading={summaryProviderId ? loadingProfiles.has(summaryProviderId) : false}
            modelOptions={summaryProviderId ? modelOptionsFor(summaryProviderId) : []}
            summaryProviderId={summaryProviderId}
            summaryModelId={summaryModelId}
            t={t}
            onSummaryProvider={(p) => { setSummaryProviderId(p); setSummaryModelId(""); if (p !== "") ensureModels(p); }}
            onSummaryModel={(m) => setSummaryModelId(m)}
            onGenerate={() => runSummaryGeneration(scopeRef.current)}
            onCancelGenerate={() => { abortRef.current?.abort(); setPendingCapture(false); setPhase("awaiting-summary"); }}
            onChangeMode={(m) => changeContextMode(m)}
            onRetryCapture={() => runContextCapture(effectiveMode, scopeRef.current)}
            onGlobalOverride={(v) => setOverrideDrafts((prev) => ({ ...prev, global: v }))}
            onCharacterOverride={(v) => setOverrideDrafts((prev) => ({ ...prev, character: v }))}
          />
        )}

        {phaseError && phase === "config" && <FieldError text={phaseError} />}
      </div>
    );
  } else {
    body = null;
  }

  // ── Footer primary action per phase ──────────────────────────────────────
  // Start is gated only on a clean discovery + not-pending; validation errors
  // (required/length/range/step/select/roster/model-seat) surface as INLINE
  // errors from the Start click itself, never by disabling the button (a
  // disabled button cannot show the user what to fix).
  const canStart = discovery.status === "ok" && !pendingStart;
  const startDisabled = !canStart;

  return (
    <Modal open={open} onClose={handleClose} title={t("experience_setup_title")} description={t("experience_setup_title")}>
      <div
        className={
          isMobile
            ? "flex h-full w-full flex-col bg-surface"
            : "flex max-h-[88vh] w-[min(680px,94vw)] flex-col overflow-hidden rounded-lg border border-border bg-surface shadow-xl"
        }
        data-testid="experience-setup-modal"
        data-chat-id={chatId}
        data-branch-id={branchId}
      >
        {/* Header */}
        <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
          <h2 className="min-w-0 flex-1 truncate font-ui text-sm font-semibold text-t1">
            {t("experience_setup_title")}
          </h2>
          <button
            type="button"
            className="rounded p-1 text-t4 hover:bg-s3 hover:text-t2"
            onClick={handleClose}
            aria-label={t("experience_setup_close")}
            data-testid="experience-setup-close"
          >
            <Ic.close />
          </button>
        </header>

        {/* Scrollable body */}
        <div className="flex-1 overflow-y-auto px-4 py-3">{body}</div>

        {/* Stable footer */}
        <footer className="flex items-center justify-end gap-2 border-t border-border px-4 py-2.5">
          <button
            type="button"
            className="rounded px-3 py-1.5 font-ui text-[12px] text-t3 hover:bg-s3 hover:text-t1"
            onClick={handleClose}
            data-testid="experience-setup-cancel"
          >
            {t("experience_setup_close")}
          </button>
          {phase === "config" && discovery.status === "ok" && (
            <button
              type="button"
              className="rounded bg-accent px-3 py-1.5 font-ui text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-40"
              onClick={() => void handleStart()}
              disabled={startDisabled}
              data-testid="experience-setup-start"
            >
              {pendingStart
                ? t("experience_setup_starting")
                : restartSource !== null
                  ? t("experience_setup_restart")
                  : t("experience_setup_start")}
            </button>
          )}
          {phase === "generating-summary" && (
            <button
              type="button"
              className="rounded px-3 py-1.5 font-ui text-[12px] text-t3 hover:bg-s3 hover:text-t1"
              onClick={() => { abortRef.current?.abort(); setPendingCapture(false); setPhase("awaiting-summary"); }}
              data-testid="experience-setup-cancel-generate"
            >
              {t("experience_setup_cancel")}
            </button>
          )}
          {ready && (
            <button
              type="button"
              className="rounded bg-accent px-3 py-1.5 font-ui text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-40"
              onClick={() => void handleContinue()}
              disabled={pendingSave}
              data-testid="experience-setup-continue"
            >
              {pendingSave ? t("experience_setup_saving") : t("experience_setup_continue")}
            </button>
          )}
        </footer>
      </div>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Presentational helpers (same file — one component unit per the contract)
// ═══════════════════════════════════════════════════════════════════════════

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <span className="font-ui text-[11px] font-semibold uppercase tracking-[0.05em] text-t2">{label}</span>
      {children}
    </section>
  );
}

function ErrorBox({ title, detail }: { title: string; detail?: string | null }) {
  return (
    <div className="rounded-md border border-danger bg-danger-dim px-2.5 py-2">
      <div className="font-ui text-[11px] font-semibold uppercase text-danger-text">{title}</div>
      {detail && <pre className="mt-1 whitespace-pre-wrap font-mono text-[11px] text-danger-text">{detail}</pre>}
    </div>
  );
}

interface RosterRowProps {
  seat: RosterSeat;
  modelGranted: boolean;
  /** Resolved display name for a character-backed seat, or null (report item
   *  6b). Falls back to the raw id when the source was deleted. */
  characterName: string | null;
  controllerOptions: Array<{ value: SeatController; label: string }>;
  providerOptions: Array<{ id: string; label: string }>;
  modelOptions: Array<{ id: string; label: string }>;
  modelsLoading: boolean;
  t: (key: TKey, opts?: Record<string, unknown>) => string;
  onController: (c: SeatController) => void;
  onLabel: (v: string) => void;
  onProvider: (p: string) => void;
  onModel: (m: string) => void;
  onRemove: () => void;
}

function RosterRow({
  seat, modelGranted, characterName, controllerOptions, providerOptions, modelOptions, modelsLoading, t,
  onController, onLabel, onProvider, onModel, onRemove,
}: RosterRowProps) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md bg-s2 px-2.5 py-2" data-seat-id={seat.id}>
      <div className="flex items-center gap-2">
        <input
          type="text"
          className="min-w-0 flex-1 rounded-md border border-border bg-s2 px-2 py-1 font-ui text-[12px] text-t1 outline-none focus:border-accent"
          value={seat.label}
          maxLength={INTERACTIVE_SCHEMA_MAX_LABEL}
          placeholder={t("experience_setup_participant_name_placeholder")}
          onChange={(e) => onLabel(e.target.value)}
          aria-label={t("experience_setup_participant_name_placeholder")}
        />
        {seat.characterId !== undefined && (
          <span
            className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-s3 px-2 py-0.5 font-ui text-[11px] text-t3"
            title={t("experience_setup_seat_character_badge")}
            data-testid="experience-setup-seat-character"
          >
            <Ic.user />
            {characterName ?? seat.characterId}
          </span>
        )}
        <SegmentedControl
          value={seat.controller}
          options={controllerOptions.map((o) => ({ value: o.value, label: o.label }))}
          onChange={(v) => onController(v as SeatController)}
          compact
        />
        <button
          type="button"
          className="shrink-0 rounded p-1 text-t4 hover:bg-s3 hover:text-danger"
          onClick={onRemove}
          aria-label={t("experience_setup_remove_participant")}
          data-testid="experience-setup-remove-seat"
        >
          <Ic.del />
        </button>
      </div>
      {seat.controller === "model" && modelGranted && (
        <div className="flex flex-col gap-1.5 sm:flex-row">
          <div className="flex-1">
            <DropdownSelect
              value={seat.providerProfileId ?? ""}
              options={providerOptions}
              placeholder={t("experience_setup_provider_placeholder")}
              onChange={onProvider}
            />
          </div>
          <div className="flex-1">
            <DropdownSelect
              value={seat.modelId ?? ""}
              options={modelOptions}
              placeholder={modelsLoading ? t("experience_setup_loading_models") : t("experience_setup_model_placeholder")}
              onChange={onModel}
              disabled={seat.providerProfileId === undefined}
            />
          </div>
        </div>
      )}
    </div>
  );
}

interface PreparationBodyProps {
  phase: Phase;
  mode: ExperienceContextMode;
  phaseError: string | null;
  pendingCapture: boolean;
  modelGranted: boolean;
  overrides: ExperiencePromptOverridesResponse | null;
  overrideDrafts: { global: string; character: string };
  saveError: string | null;
  pendingSave: boolean;
  providerOptions: Array<{ id: string; label: string }>;
  modelsLoading: boolean;
  modelOptions: Array<{ id: string; label: string }>;
  summaryProviderId: string;
  summaryModelId: string;
  t: (key: TKey, opts?: Record<string, unknown>) => string;
  onSummaryProvider: (p: string) => void;
  onSummaryModel: (m: string) => void;
  onGenerate: () => void;
  onCancelGenerate: () => void;
  onChangeMode: (m: ExperienceContextMode) => void;
  onRetryCapture: () => void;
  onGlobalOverride: (v: string) => void;
  onCharacterOverride: (v: string) => void;
}

function PreparationBody(props: PreparationBodyProps) {
  const {
    phase, mode, phaseError, pendingCapture, modelGranted, overrides, overrideDrafts,
    saveError, pendingSave, providerOptions, modelsLoading, modelOptions, summaryProviderId,
    summaryModelId, t, onSummaryProvider, onSummaryModel, onGenerate, onChangeMode, onRetryCapture,
    onGlobalOverride, onCharacterOverride,
  } = props;

  return (
    <div className="flex flex-col gap-4">
      {/* Context preparation status */}
      <Section label={t("experience_setup_context_label")}>
        <SegmentedControl
          value={mode}
          options={CONTEXT_MODE_ORDER.map((m) => ({ value: m, label: t(CONTEXT_MODE_LABEL_KEYS[m]) }))}
          onChange={(v) => onChangeMode(v as ExperienceContextMode)}
          compact
          wrap
          disabled={pendingCapture}
        />

        {phase === "capturing" && (
          <div className="flex items-center gap-2">
            {pendingCapture ? (
              <>
                <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
                <span className="font-ui text-[12px] text-t3">{t("experience_setup_capturing")}</span>
              </>
            ) : (
              <>
                <span className="font-ui text-[12px] text-t3">{t("experience_setup_context_ready")}</span>
                <button
                  type="button"
                  className="rounded px-2 py-0.5 font-ui text-[11px] text-accent hover:bg-s3"
                  onClick={onRetryCapture}
                  data-testid="experience-setup-retry-capture"
                >
                  {t("experience_setup_capture_retry")}
                </button>
              </>
            )}
          </div>
        )}

        {phase === "awaiting-summary" && (
          <div className="flex flex-col gap-2">
            <p className="font-ui text-[12px] leading-relaxed text-t3">{t("experience_setup_summary_intro")}</p>
            <div className="flex flex-col gap-1.5 sm:flex-row">
              <div className="flex-1">
                <DropdownSelect
                  value={summaryProviderId}
                  options={providerOptions}
                  placeholder={t("experience_setup_provider_placeholder")}
                  onChange={onSummaryProvider}
                />
              </div>
              <div className="flex-1">
                <DropdownSelect
                  value={summaryModelId}
                  options={modelOptions}
                  placeholder={modelsLoading ? t("experience_setup_loading_models") : t("experience_setup_model_placeholder")}
                  onChange={onSummaryModel}
                  disabled={summaryProviderId === ""}
                />
              </div>
            </div>
            <button
              type="button"
              className="self-start rounded bg-accent px-3 py-1.5 font-ui text-[12px] font-medium text-on-accent hover:opacity-90 disabled:opacity-40"
              onClick={onGenerate}
              disabled={pendingCapture}
              data-testid="experience-setup-generate-summary"
            >
              {t("experience_setup_generate_summary")}
            </button>
          </div>
        )}

        {phase === "generating-summary" && (
          <div className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            <span className="font-ui text-[12px] text-t3">{t("experience_setup_generating")}</span>
          </div>
        )}

        {phase === "ready" && (
          <p className="font-ui text-[12px] leading-relaxed text-t3">{t("experience_setup_ready_note")}</p>
        )}

        {phaseError && <FieldError text={phaseError} />}
      </Section>

      {/* Model-only prompt overrides (capability gate, post-start) */}
      {modelGranted && (
        <Section label={t("experience_setup_overrides_label")}>
          <p className="font-ui text-[11px] leading-relaxed text-t4">{t("experience_setup_overrides_hint")}</p>
          <div className="flex flex-col gap-2">
            <div className="flex flex-col gap-1">
              <label className="font-ui text-[11px] font-medium text-t2">{t("experience_setup_overrides_global")}</label>
              <AutoTextarea
                className="rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-[12px] text-t1 outline-none focus:border-accent"
                value={overrideDrafts.global}
                onChange={(e) => onGlobalOverride(e.target.value)}
                minRows={2}
                maxRows={6}
                macroAutocomplete={false}
                data-testid="experience-setup-override-global"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="font-ui text-[11px] font-medium text-t2">{t("experience_setup_overrides_character")}</label>
              <AutoTextarea
                className="rounded-md border border-border bg-s2 px-2.5 py-1.5 font-ui text-[12px] text-t1 outline-none focus:border-accent"
                value={overrideDrafts.character}
                onChange={(e) => onCharacterOverride(e.target.value)}
                minRows={2}
                maxRows={6}
                macroAutocomplete={false}
                data-testid="experience-setup-override-character"
              />
            </div>
          </div>
          {saveError && <FieldError text={saveError} />}
          {/* overrides === null means the load is still pending or failed; the
              section still renders so a failed load is visible, not hidden. */}
          {overrides === null && !saveError && (
            <p className="font-ui text-[11px] text-t4">{t("experience_setup_overrides_loading")}</p>
          )}
        </Section>
      )}
    </div>
  );
}
