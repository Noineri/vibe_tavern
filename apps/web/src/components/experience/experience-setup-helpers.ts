/**
 * The ExperienceSetupModal's pure setup model — an SS-7B3 extraction-only
 * move out of ExperienceSetupModal.tsx (SCRIPT_SAFETY_PLAN decision 13d):
 * the TKey/seat/roster/phase types, the context/controller label constants,
 * the fail-closed config normalization helpers, and the restart-snapshot
 * mappers are preserved verbatim (comments included); only the imports and
 * exports the move required were added. The modal keeps every stateful
 * effect and render.
 */
import {
  EXPERIENCE_CAPABILITY,
  EXPERIENCE_CONTEXT_MODE,
  type ExperienceCapability,
  type ExperienceContextMode,
} from "@vibe-tavern/domain";
import type Resources from "../../i18n/resources.js";
import type { ExperienceSessionResponse } from "../../api/types.js";
import type { SetupField } from "./setup-fields.js";

export type TKey = keyof Resources["en"];

/** Controller literal union (mirrors EXPERIENCE_CONTROLLER). */
export type SeatController = "human" | "script" | "model";

/** One editable participant row. The host owns the stable id; the label is
 *  user-editable free text. Model seats additionally pin a provider + model,
 *  and may be backed by a library character (report item 6b). */
export interface RosterSeat {
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
export type Phase = "config" | "capturing" | "awaiting-summary" | "generating-summary" | "ready";

/** Canonical display order for the context-mode segmented control. */
export const CONTEXT_MODE_ORDER: readonly ExperienceContextMode[] = [
  EXPERIENCE_CONTEXT_MODE.none,
  EXPERIENCE_CONTEXT_MODE.currentBranch,
  EXPERIENCE_CONTEXT_MODE.recent,
  EXPERIENCE_CONTEXT_MODE.summariesRecent,
  EXPERIENCE_CONTEXT_MODE.compactSummary,
];

export const CONTEXT_MODE_LABEL_KEYS: Record<ExperienceContextMode, TKey> = {
  [EXPERIENCE_CONTEXT_MODE.none]: "experience_context_none",
  [EXPERIENCE_CONTEXT_MODE.currentBranch]: "experience_context_current_branch",
  [EXPERIENCE_CONTEXT_MODE.recent]: "experience_context_recent",
  [EXPERIENCE_CONTEXT_MODE.summariesRecent]: "experience_context_summaries_recent",
  [EXPERIENCE_CONTEXT_MODE.compactSummary]: "experience_context_compact_summary",
};

export const CONTROLLER_LABEL_KEYS: Record<SeatController, TKey> = {
  human: "experience_setup_controller_human",
  script: "experience_setup_controller_script",
  model: "experience_setup_controller_model",
};

/** Fail-closed normalization of the DB config row's broad string fields into the
 *  canonical Domain unions (mirrors InsightsPanel — derived from the Domain
 *  constants, never a duplicate handwritten union or an unverified cast). */
const VALID_CAPABILITY_VALUES: ReadonlySet<string> = new Set(Object.values(EXPERIENCE_CAPABILITY));
const VALID_CONTEXT_MODE_VALUES: ReadonlySet<string> = new Set(Object.values(EXPERIENCE_CONTEXT_MODE));

export function normalizeCapabilityGrants(raw: string[] | undefined): ExperienceCapability[] {
  return (raw ?? []).filter((g): g is ExperienceCapability => VALID_CAPABILITY_VALUES.has(g));
}

function isContextMode(raw: string): raw is ExperienceContextMode {
  return VALID_CONTEXT_MODE_VALUES.has(raw);
}

export function normalizeContextMode(raw: string | undefined): ExperienceContextMode {
  if (raw !== undefined && isContextMode(raw)) return raw;
  return EXPERIENCE_CONTEXT_MODE.none;
}

/** Overlay a frozen settings snapshot onto seeded defaults (lobby LB-5).
 * Only declared fields with a type-compatible snapshot value are prefilled:
 * select values no longer in the authored option list are DROPPED (the UI must
 * never display an option that does not exist), numbers must be finite, and a
 * no-default boolean maps false back to absent (unchecked). */
export function applySnapshotPrefill(
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
export function seatsFromSnapshot(participants: ExperienceSessionResponse["participants"]): {
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
