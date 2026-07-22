/**
 * Dice-script service (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B4).
 *
 * Orchestrates the dedicated Dice VM ({@link discoverDiceChecks} /
 * {@link executeDiceRoll}) against the store layer. This service is PURE
 * COMPUTE — it loads enabled Dice scripts, enforces home/link + actor
 * eligibility, runs discovery/roll under timeout, validates all script output
 * against the domain validators, and returns structured results or errors. It
 * performs NO prompt assembly, NO provider calls, NO EventBus publish, and NO
 * persistence (the roll/lane DB tables + authoritative roll service arrive in
 * Wave B3). B3's `dice-service.ts` wraps this layer's validated output into the
 * full `DiceRollSnapshot` with persistence fields.
 *
 * Isolation invariant: this module imports only the Dice VM, the domain dice
 * kernel, and the store container. It never imports `script-sandbox.ts`,
 * `prompt-resolver.ts`, provider executors, or the EventBus.
 */

import type { StoreContainer } from "@vibe-tavern/db";
import type {
  DiceActorSnapshot,
  DiceActorType,
  DiceAttempt,
  DiceCheckDefinition,
  DiceFaceShape,
  DiceFinalizationPolicy,
  DiceResolution,
  DiceRollFinal,
  Script,
} from "@vibe-tavern/domain";
import {
  DICE_ACTOR_TYPE,
  DICE_RESOLUTION,
  DICE_FINALIZATION_POLICY,
  parseDiceNotation,
  validateRollArithmetic,
  type RandomSource,
} from "@vibe-tavern/domain";
import {
  discoverDiceChecks,
  executeDiceRoll,
  type RawDiceCheckRegistration,
} from "./dice-script-sandbox.js";

// ─── Revision ────────────────────────────────────────────────────────────────

/**
 * Compute a stable, deterministic revision for a Dice script from its code.
 * The revision is captured on every roll snapshot so a later edit does not
 * invalidate an already-stored result (the snapshot keeps its old revision).
 * FNV-1a 32-bit over the UTF-16 code units — stable for identical code, changes
 * on any edit. Surfaced as `scriptRevision` on descriptors and roll results.
 */
export function computeScriptRevision(code: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < code.length; i += 1) {
    hash ^= code.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// ─── Validation helpers (raw VM registration → typed descriptor) ─────────────

const VALID_ACTOR_TYPES: ReadonlySet<DiceActorType> = new Set(
  Object.values(DICE_ACTOR_TYPE),
);
const VALID_RESOLUTIONS: ReadonlySet<DiceResolution> = new Set(
  Object.values(DICE_RESOLUTION),
);
const VALID_POLICIES: ReadonlySet<DiceFinalizationPolicy> = new Set(
  Object.values(DICE_FINALIZATION_POLICY),
);

/**
 * Validate one raw registration into a serializable {@link DiceCheckDefinition},
 * or return `null` if the registration is malformed (bad id/label/notation/
 * actors/resolution, or missing resolve). Invalid registrations are dropped
 * during discovery so one bad check does not poison the whole script.
 */
export function validateRegistration(
  raw: RawDiceCheckRegistration,
): DiceCheckDefinition | null {
  if (typeof raw.id !== "string" || raw.id.trim().length === 0) return null;
  if (typeof raw.label !== "string") return null;
  if (typeof raw.notation !== "string") return null;

  // Notation must parse (validates count/sides/modifier bounds).
  let notation;
  try {
    notation = parseDiceNotation(raw.notation);
  } catch {
    return null;
  }

  // actors: non-empty array of valid DiceActorType.
  if (!Array.isArray(raw.actors) || raw.actors.length === 0) return null;
  const actors: DiceActorType[] = [];
  for (const a of raw.actors) {
    if (typeof a !== "string" || !VALID_ACTOR_TYPES.has(a as DiceActorType)) return null;
    actors.push(a as DiceActorType);
  }

  // resolution: strict | narrative.
  if (typeof raw.resolution !== "string" || !VALID_RESOLUTIONS.has(raw.resolution as DiceResolution)) {
    return null;
  }

  // resolve must be a function (present at roll time).
  if (typeof raw.resolve !== "function") return null;

  // help: optional short rule-help string for the composer tray. Accept any
  // non-empty trimmed string; length-bounding happens at the schema boundary
  // (diceCheckDescriptorSchema.help is boundedLabel.optional()).
  const help = typeof raw.help === "string" && raw.help.trim().length > 0 ? raw.help.trim() : undefined;

  return {
    id: raw.id,
    label: raw.label,
    notation: notation.notation,
    actors,
    resolution: raw.resolution as DiceResolution,
    faceShape: notation.faceShape,
    ...(help ? { help } : {}),
  };
}

// ─── Discovery result ────────────────────────────────────────────────────────

/** One script's validated checks for a chat (GET /definitions, grouped). */
export interface DiceScriptDefinitions {
  scriptId: string;
  scriptLabel: string;
  scriptRevision: number;
  checks: DiceCheckDefinition[];
}

/** The full discovery response (mirrors `diceDefinitionsResponseSchema`). */
export interface DiceDefinitionsResponse {
  scripts: DiceScriptDefinitions[];
}

// ─── Roll result (no persistence fields — B3 adds those) ────────────────────

/**
 * The validated, server-computed result of one roll. This is the pure-compute
 * core; B3's `dice-service.ts` wraps it into a full {@link DiceRollSnapshot}
 * with `rollId`/`requestId`/`mode`/`included`/`finalAttemptId`/`boundMessageId`.
 */
export interface DiceResolvedRoll {
  scriptId: string;
  scriptLabel: string;
  scriptRevision: number;
  checkId: string;
  checkLabel: string;
  actor: DiceActorSnapshot;
  notation: string;
  faceShape: DiceFaceShape;
  resolution: DiceResolution;
  /** The attempt produced by this resolve() call. */
  attempt: DiceAttempt;
  /** Present on strict checks; absent on narrative checks. */
  final?: DiceRollFinal;
  /** Script-provided retry reason/policy channel (Immersive grants). */
  retryReason?: string;
  policy?: DiceFinalizationPolicy;
}

// ─── Structured errors ───────────────────────────────────────────────────────

export type DiceServiceError =
  | { code: "script_not_found" }
  | { code: "script_not_dice" }
  | { code: "script_disabled" }
  | { code: "script_not_enabled_for_chat" }
  | { code: "check_not_found"; checkId: string }
  | { code: "actor_ineligible"; actorType: string; allowed: DiceActorType[] }
  | { code: "actor_not_found"; actorType: DiceActorType; actorId: string }
  | { code: "vm_error"; message: string }
  | { code: "validation_error"; message: string };

export type DiceRollServiceResult =
  | { ok: true; roll: DiceResolvedRoll }
  | { ok: false; error: DiceServiceError };

// ─── Discovery ───────────────────────────────────────────────────────────────

/**
 * Resolve every enabled Dice script visible to a chat and return their
 * validated check descriptors. Each script's body runs once in the Dice VM
 * (discovery mode); malformed registrations are dropped per-script. A script
 * whose body throws/timeout contributes zero checks (its error is swallowed —
 * discovery is best-effort so one broken script does not hide the rest).
 *
 * Duplicate check ids across the whole response are rejected by the caller's
 * schema validation (`diceDefinitionsResponseSchema`); this function returns
 * them as-is and lets the schema boundary enforce global uniqueness.
 */
export async function discoverDiceScripts(
  stores: StoreContainer,
  input: { characterId: string; personaId: string | null; chatId: string },
): Promise<DiceDefinitionsResponse> {
  const scripts = await stores.scripts.listAllEnabledDiceScriptsForChat(
    input.characterId,
    input.personaId,
    input.chatId,
  );

  const out: DiceScriptDefinitions[] = [];
  for (const script of scripts) {
    const discovery = discoverDiceChecks(script.code, script.name);
    if (discovery.error) continue; // broken script → zero checks, skip silently.

    const checks: DiceCheckDefinition[] = [];
    for (const raw of discovery.registrations) {
      const def = validateRegistration(raw);
      if (def) checks.push(def);
    }
    if (checks.length === 0) continue;

    out.push({
      scriptId: script.id,
      scriptLabel: script.name,
      scriptRevision: computeScriptRevision(script.code),
      checks,
    });
  }

  return { scripts: out };
}

// ─── Roll ────────────────────────────────────────────────────────────────────

/**
 * Resolve one enabled Dice script/check for the active chat+actor, enforce
 * home/link eligibility and descriptor actor restrictions, execute the check's
 * `resolve()` under timeout, validate the output, and return a structured
 * result or error. Performs NO prompt assembly, provider call, or persistence.
 *
 * The injected {@link RandomSource} is the sole randomness source — production
 * injects a cryptographic source; tests inject deterministic values.
 */
export async function resolveDiceRoll(
  stores: StoreContainer,
  input: {
    scriptId: string;
    checkId: string;
    actorType: DiceActorType;
    actorId: string;
    characterId: string;
    personaId: string | null;
    chatId: string;
    /** Prior authorized attempts for this check (Immersive retry context). */
    priorAttempts?: DiceAttempt[];
    /** The injected randomness source (crypto in prod, deterministic in tests). */
    rng: RandomSource;
  },
): Promise<DiceRollServiceResult> {
  // 1. Load the script.
  const script = await stores.scripts.getById(input.scriptId);
  if (!script) return err({ code: "script_not_found" });
  if (script.scriptKind !== "dice") return err({ code: "script_not_dice" });
  if (!script.enabled) return err({ code: "script_disabled" });

  // 2. Home/link eligibility: the script must be enabled for THIS chat. We
  //    resolve the chat's enabled dice script set and verify membership rather
  //    than trusting the caller's scriptId blindly.
  const enabled = await stores.scripts.listAllEnabledDiceScriptsForChat(
    input.characterId,
    input.personaId,
    input.chatId,
  );
  if (!enabled.some((s) => s.id === input.scriptId)) {
    return err({ code: "script_not_enabled_for_chat" });
  }

  // 3. Discovery: find the target check + validate the actor is allowed.
  const discovery = discoverDiceChecks(script.code, script.name);
  if (discovery.error) return err({ code: "vm_error", message: discovery.error });

  const targetReg = findRegistration(discovery.registrations, input.checkId);
  if (!targetReg) return err({ code: "check_not_found", checkId: input.checkId });

  const def = validateRegistration(targetReg);
  if (!def) return err({ code: "check_not_found", checkId: input.checkId });
  if (!def.actors.includes(input.actorType)) {
    return err({
      code: "actor_ineligible",
      actorType: input.actorType,
      allowed: [...def.actors],
    });
  }

  // 4. Resolve the actor label (frozen snapshot identity).
  const actorResult = await resolveActor(stores, input.actorType, input.actorId);
  if (!actorResult.ok) return err(actorResult.error);

  // 5. Execute the roll inside the Dice VM.
  const priorAttempts = input.priorAttempts ?? [];
  const roll = executeDiceRoll(script.code, script.name, input.checkId, {
    actor: actorResult.actor,
    priorAttempts,
    rng: input.rng,
  });
  if (!roll.ok || roll.output == null) {
    if (roll.error === "check_not_found") {
      return err({ code: "check_not_found", checkId: input.checkId });
    }
    return err({ code: "vm_error", message: roll.error ?? "resolve() returned no output" });
  }

  // 6. Validate the resolve() output.
  const validated = validateResolveOutput(roll.output, def);
  if (!validated.ok) return err(validated.error);

  // 7. Build the attempt (server assigns the attemptId).
  const attemptId = `attempt_${priorAttempts.length + 1}`;
  const attempt: DiceAttempt = {
    attemptId,
    faces: validated.faces,
    modifier: validated.modifier,
    subtotal: validated.subtotal,
    total: validated.total,
    ...(validated.grantReason !== undefined ? { grantReason: validated.grantReason } : {}),
  };

  const result: DiceResolvedRoll = {
    scriptId: script.id,
    scriptLabel: script.name,
    scriptRevision: computeScriptRevision(script.code),
    checkId: def.id,
    checkLabel: def.label,
    actor: actorResult.actor,
    notation: def.notation,
    faceShape: def.faceShape,
    resolution: def.resolution,
    attempt,
    ...(validated.final !== undefined ? { final: validated.final } : {}),
    ...(validated.retryReason !== undefined ? { retryReason: validated.retryReason } : {}),
    ...(validated.policy !== undefined ? { policy: validated.policy } : {}),
  };

  return { ok: true, roll: result };
}

// ─── Actor resolution ────────────────────────────────────────────────────────

type ActorResult =
  | { ok: true; actor: DiceActorSnapshot }
  | { ok: false; error: Extract<DiceServiceError, { code: "actor_not_found" }> };

async function resolveActor(
  stores: StoreContainer,
  actorType: DiceActorType,
  actorId: string,
): Promise<ActorResult> {
  if (actorType === DICE_ACTOR_TYPE.persona) {
    const persona = await stores.personas.getById(actorId);
    if (!persona) {
      return { ok: false, error: { code: "actor_not_found", actorType, actorId } };
    }
    return {
      ok: true,
      actor: { actorType, actorId, actorLabel: persona.name },
    };
  }
  const character = await stores.characters.getById(actorId);
  if (!character) {
    return { ok: false, error: { code: "actor_not_found", actorType, actorId } };
  }
  return {
    ok: true,
    actor: { actorType, actorId, actorLabel: character.name },
  };
}

// ─── Resolve-output validation ───────────────────────────────────────────────

interface ValidatedResolve {
  ok: true;
  faces: number[];
  modifier: number;
  subtotal: number;
  total: number;
  final?: DiceRollFinal;
  retryReason?: string;
  policy?: DiceFinalizationPolicy;
  grantReason?: string;
}
type ResolveValidation =
  | ValidatedResolve
  | { ok: false; error: Extract<DiceServiceError, { code: "validation_error" }> };

/**
 * Validate the raw `resolve()` return value against the domain arithmetic +
 * strict/narrative rules. The script declares faces/modifier/subtotal/total;
 * the server re-checks `subtotal === sum(faces)` and `total === subtotal +
 * modifier` (defense against script drift / fabricated output). Strict
 * resolution requires `final.outcome`; narrative forbids it.
 */
export function validateResolveOutput(
  raw: unknown,
  def: DiceCheckDefinition,
): ResolveValidation {
  const validationErr = (message: string): ResolveValidation => ({
    ok: false,
    error: { code: "validation_error", message },
  });

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return validationErr("resolve() must return a plain object");
  }
  const obj = raw as Record<string, unknown>;

  // Faces/modifier/subtotal/total — required integers.
  const faces = obj.faces;
  const modifier = obj.modifier;
  const subtotal = obj.subtotal;
  const total = obj.total;
  if (!Array.isArray(faces) || faces.length === 0 || faces.length > 32) {
    return validationErr("resolve() faces must be a non-empty array (max 32)");
  }

  // Re-derive the sides bound from the descriptor notation for face validation.
  let sides = 100;
  try {
    sides = parseDiceNotation(def.notation).sides;
  } catch {
    // def.notation was already validated at registration; this is defensive.
  }
  for (const f of faces) {
    if (typeof f !== "number" || !Number.isInteger(f) || f < 1 || f > sides) {
      return validationErr(`resolve() face ${f} out of range [1..${sides}]`);
    }
  }

  if (typeof modifier !== "number" || !Number.isInteger(modifier)) {
    return validationErr("resolve() modifier must be an integer");
  }
  if (typeof subtotal !== "number" || !Number.isInteger(subtotal)) {
    return validationErr("resolve() subtotal must be an integer");
  }
  if (typeof total !== "number" || !Number.isInteger(total)) {
    return validationErr("resolve() total must be an integer");
  }

  // Centralized arithmetic guard (rejects fabricated/drifted tuples).
  const arithError = validateRollArithmetic({
    sides,
    modifier,
    faces,
    subtotal,
    total,
  });
  if (arithError) {
    return validationErr(arithError);
  }

  // Strict/narrative adjudication rules.
  let final: DiceRollFinal | undefined;
  const rawFinal = obj.final;
  if (def.resolution === DICE_RESOLUTION.strict) {
    if (typeof rawFinal !== "object" || rawFinal === null) {
      return validationErr("strict resolution requires resolve() to return final");
    }
    const f = rawFinal as Record<string, unknown>;
    if (typeof f.total !== "number" || !Number.isInteger(f.total)) {
      return validationErr("strict resolution final.total must be an integer");
    }
    if (typeof f.outcome !== "string" || f.outcome.trim().length === 0) {
      return validationErr("strict resolution requires a non-empty final.outcome");
    }
    final = {
      total: f.total,
      outcome: f.outcome,
      ...(typeof f.degree === "string" && f.degree.trim() ? { degree: f.degree } : {}),
      ...(typeof f.constraint === "string" && f.constraint.trim()
        ? { constraint: f.constraint }
        : {}),
    };
  } else {
    // narrative: no authoritative outcome. final may carry total/degree/
    // constraint as mechanical facts, but never outcome.
    if (typeof rawFinal === "object" && rawFinal !== null) {
      const f = rawFinal as Record<string, unknown>;
      if (typeof f.outcome === "string" && f.outcome.trim().length > 0) {
        return validationErr("narrative resolution must not carry an authoritative outcome");
      }
      if (typeof f.total === "number" && Number.isInteger(f.total)) {
        final = {
          total: f.total,
          ...(typeof f.degree === "string" && f.degree.trim() ? { degree: f.degree } : {}),
          ...(typeof f.constraint === "string" && f.constraint.trim()
            ? { constraint: f.constraint }
            : {}),
        };
      }
    }
  }

  // Optional retry-reason / policy / grant-reason channel (Immersive).
  let retryReason: string | undefined;
  let policy: DiceFinalizationPolicy | undefined;
  let grantReason: string | undefined;
  if (typeof obj.retryReason === "string" && obj.retryReason.trim().length > 0) {
    retryReason = obj.retryReason;
  }
  if (typeof obj.policy === "string" && VALID_POLICIES.has(obj.policy as DiceFinalizationPolicy)) {
    policy = obj.policy as DiceFinalizationPolicy;
  }
  if (typeof obj.grantReason === "string" && obj.grantReason.trim().length > 0) {
    grantReason = obj.grantReason;
  }

  return {
    ok: true,
    faces: faces as number[],
    modifier,
    subtotal,
    total,
    ...(final !== undefined ? { final } : {}),
    ...(retryReason !== undefined ? { retryReason } : {}),
    ...(policy !== undefined ? { policy } : {}),
    ...(grantReason !== undefined ? { grantReason } : {}),
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findRegistration(
  regs: RawDiceCheckRegistration[],
  checkId: string,
): RawDiceCheckRegistration | null {
  for (const r of regs) {
    if (typeof r.id === "string" && r.id === checkId) return r;
  }
  return null;
}

/** Narrow helper to build a `{ ok: false }` result without repeating the shape. */
function err(error: DiceServiceError): DiceRollServiceResult {
  return { ok: false, error };
}
