/**
 * ExperiencePlayground's local view model — the roster seat and typed-error
 * shapes plus the pure helpers that build them (error normalization, seat-id
 * slugs). Module-private to the playground panel; extracted from
 * ExperiencePlayground.tsx to keep that file within its arch-gate size budget.
 */
import type { ExperienceController } from "@vibe-tavern/domain";
import { ExperienceApiError } from "../../../api/experience-api.js";
import type {
  ExperiencePlaygroundData,
  ExperienceTestConsoleEntry,
} from "../../../api/types.js";

// ─── Local types ─────────────────────────────────────────────────────────────
//
// The roster/grants/error-normalization helpers below deliberately MIRROR the
// IR-81D InteractiveTester's module-private ones (same structural reason the
// IR-84A driver reimplements the tester's helpers locally: the two surfaces
// are independent panels with independent evolution, and the shared-primitive
// chrome they compose is the actual sharing boundary).

/** One editable roster row (local state only — never a store). */
export interface PlaygroundSeat {
  id: string;
  label: string;
  controller: ExperienceController;
  /** Pinned provider profile for a model seat (IR-90E). */
  providerProfileId?: string;
  /** Pinned model id for a model seat (IR-90E). */
  modelId?: string;
  /** True while the id is auto-managed (tracks the label): becomes false the
   *  moment the user edits the id by hand. Local-only — never persisted, so a
   *  restored seat keeps its stored id verbatim (renames do not regenerate it). */
  idAuto?: boolean;
}

/** The typed-error view model this panel renders. Normalized from the client
 *  {@link ExperienceApiError} (which preserves the backend's structured
 *  `details`: code, kernel kind, currentRevision, granted/needs, console). */
export interface PlaygroundErrorView {
  message: string;
  status?: number;
  code?: string;
  kind?: string;
  currentRevision?: number;
  participantId?: string;
  granted?: string[];
  needs?: string[];
  console: ExperienceTestConsoleEntry[];
}

export type AdvanceOutcome =
  | { readonly ok: true; readonly data: ExperiencePlaygroundData }
  | { readonly ok: false; readonly error: PlaygroundErrorView };

// ─── Normalization helpers (no `as any`; the wire details record is unknown) ──

function asStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

/** LOBBY-A: narrow a parsed JSON value to a plain settings object. Null for
 *  arrays/scalars/null — the setup form is unavailable for those and the raw
 *  JSON path applies. Runtime-checked narrowing (not a suppressed cast). */
export function asSettingsObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asConsole(value: unknown): ExperienceTestConsoleEntry[] {
  if (!Array.isArray(value)) return [];
  const entries: ExperienceTestConsoleEntry[] = [];
  for (const entry of value as unknown[]) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    entries.push({
      level: record.level === "warn" || record.level === "error" ? record.level : "log",
      args: asStringList(record.args) ?? [],
    });
  }
  return entries;
}

export function toPlaygroundError(error: unknown): PlaygroundErrorView {
  if (error instanceof ExperienceApiError) {
    const details = error.details ?? {};
    const view: PlaygroundErrorView = {
      message: error.message,
      status: error.status,
      console: asConsole(details.console),
    };
    if (error.code !== undefined) view.code = error.code;
    if (typeof details.kind === "string") view.kind = details.kind;
    if (typeof details.currentRevision === "number") view.currentRevision = details.currentRevision;
    if (typeof details.participantId === "string") view.participantId = details.participantId;
    const granted = asStringList(details.granted);
    if (granted !== undefined) view.granted = granted;
    const needs = asStringList(details.needs);
    if (needs !== undefined) view.needs = needs;
    return view;
  }
  return { message: error instanceof Error ? error.message : String(error), console: [] };
}

/** Slugify a participant name into a stable seat id: lowercase, latin
 *  alphanumerics + dashes only, "seat" fallback for an empty name. */
export function slugifyId(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return base === "" ? "seat" : base;
}

/** Dedupe a candidate id against an already-taken set with -2/-3 suffixes. */
export function uniqueIdFor(base: string, taken: ReadonlySet<string>): string {
  let candidate = base;
  let n = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${n}`;
    n += 1;
  }
  return candidate;
}

/** First letter for the participant's avatar circle (label → id → "?"). */
export function seatInitial(seat: PlaygroundSeat): string {
  const source = seat.label.trim() !== "" ? seat.label.trim() : seat.id.trim();
  return source === "" ? "?" : source.charAt(0).toUpperCase();
}
