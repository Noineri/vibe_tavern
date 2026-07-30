/**
 * Dedicated Dice-script VM (DICE_SYSTEM_BACKEND_PLAN, Wave B2 / DICE-B4).
 *
 * This is a SEPARATE `node:vm` sandbox from the prompt-script VM
 * (`script-sandbox.ts`). The prompt VM is behavior-pinned and must never be
 * modified to host Dice scripts; this VM is Dice-only. A Dice script runs here
 * and ONLY here — it can never reach prompt assembly, provider execution, or
 * the EventBus.
 *
 * The Dice-script contract has two phases, both synchronous and both bounded by
 * a timeout:
 *
 *  - **Discovery.** The script body runs once with `context.dice.register(...)`
 *    available. It publishes its stable checks. Discovery returns the raw
 *    registrations for the service layer to validate into serializable
 *    descriptors. `context.dice.roll` is deliberately absent here — a check's
 *    randomness lives inside its `resolve()`, not at registration time.
 *
 *  - **Roll.** The script body runs again, this time with the full roll context
 *    (`context.dice.roll`, a frozen `context.actor`, frozen `context.priorAttempts`).
 *    An appended orchestration snippet finds the target check by id and invokes
 *    its `resolve()` *inside the same VM execution* so the timeout envelope
 *    covers user-authored resolve logic. The raw resolve() return value is
 *    surfaced for the service layer to validate (faces/subtotal/total arithmetic,
 *    strict/narrative rules, retry-reason/policy channel).
 *
 * The roller is the server-owned bounded primitive from `@vibe-tavern/domain`
 * (`[N]dS[+/-M]` + `d%` under centralized limits). Advanced mechanics (advantage,
 * keep-high/low, explode, pools) are implemented by the script via repeated
 * bounded `roll()` calls — the notation grammar never grows. Production
 * randomness comes from an injected cryptographic source; tests inject
 * deterministic values.
 *
 * The sandbox exposes NO `context.chat.injectMessage`, NO prompt-mutation
 * channels, NO network/filesystem/process, and NO uncontrolled-randomness API.
 * Only `Math`/`JSON`/`Date`/etc. standard globals and the Dice context are
 * available — matching the prompt VM's allowlist posture but with a Dice-only
 * API surface.
 */

import { runInNewContext } from "node:vm";
import {
  parseDiceNotation,
  rollDice,
  type DiceRollResult,
  type RandomSource,
} from "@vibe-tavern/domain";
import type { DiceActorSnapshot, DiceAttempt } from "@vibe-tavern/domain";

/** Default timeout for a single Dice-script VM execution (discovery or roll), in ms. */
export const DICE_VM_DEFAULT_TIMEOUT_MS = 5000;

// ─── Raw registration shape (straight from the VM, unvalidated) ──────────────

/**
 * The raw object a Dice script passes to `context.dice.register(...)`. Every
 * field is `unknown` here — the service layer validates and narrows it. The
 * `resolve` field is a function the VM created; it is NOT serializable and
 * never leaves the process.
 */
export interface RawDiceCheckRegistration {
  id: unknown;
  label: unknown;
  notation: unknown;
  actors: unknown;
  resolution: unknown;
  resolve: unknown;
  help: unknown;
}

// ─── Roll context (frozen, injected into the roll-phase VM) ──────────────────

/**
 * The frozen context a check's `resolve()` reads at roll time.
 *  - `actor` — the identity+label of who is rolling (frozen: a script cannot
 *    rewrite the actor to impersonate another).
 *  - `priorAttempts` — the already-authorized attempts for this check in the
 *    current result envelope (Immersive retry grants read these).
 *  - `rng` — the injected randomness source. Production injects a cryptographic
 *    source; tests inject deterministic values.
 */
export interface DiceRollContext {
  actor: DiceActorSnapshot;
  priorAttempts: DiceAttempt[];
  rng: RandomSource;
}

// ─── Standard globals allowlist (matches the prompt VM's posture) ────────────

/**
 * The standard JS globals a Dice script may use. Deliberately excludes
 * `setTimeout`/`setInterval`, `fetch`, `require`, `process`, `globalThis`,
 * `import`, `eval`, `Function`, and `WebAssembly` — same confinement posture as
 * the prompt VM, applied to a Dice-only API.
 */
function buildStandardGlobals(): Record<string, unknown> {
  return {
    Math,
    JSON,
    Date,
    parseInt,
    parseFloat,
    isNaN,
    isFinite,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    Map,
    Set,
    Error,
    console: NOOP_CONSOLE,
  };
}

const NOOP_CONSOLE = Object.freeze({
  log(): void {},
  warn(): void {},
  error(): void {},
});

// ─── Discovery ───────────────────────────────────────────────────────────────

export interface DiceVmDiscoveryOutput {
  /** Raw registrations collected from the script, in registration order. */
  registrations: RawDiceCheckRegistration[];
  /** VM error message (timeout/syntax/runtime); `null` when the script ran clean. */
  error: string | null;
}

/**
 * Run a Dice script's body once in discovery mode, collecting the checks it
 * registers via `context.dice.register(...)`. The script cannot roll during
 * discovery — `context.dice.roll` throws if called outside a `resolve()`.
 *
 * Returns the raw registrations (unvalidated) plus any VM error. The service
 * layer validates the registrations into serializable descriptors.
 */
export function discoverDiceChecks(
  code: string,
  scriptName: string,
  timeoutMs: number = DICE_VM_DEFAULT_TIMEOUT_MS,
): DiceVmDiscoveryOutput {
  const registrations: RawDiceCheckRegistration[] = [];
  const sandbox: Record<string, unknown> = {
    context: {
      dice: {
        register(def: RawDiceCheckRegistration): void {
          registrations.push(def);
        },
        roll(): never {
          throw new Error(
            "context.dice.roll is only available inside a check's resolve()",
          );
        },
      },
    },
    ...buildStandardGlobals(),
  };

  try {
    runInNewContext(code, sandbox, {
      timeout: timeoutMs,
      filename: scriptName,
    });
  } catch (err: unknown) {
    return { registrations, error: extractMessage(err) };
  }
  return { registrations, error: null };
}

// ─── Roll ────────────────────────────────────────────────────────────────────

export interface DiceVmRollOutput {
  /** `true` when resolve() returned a value (still unvalidated). */
  ok: boolean;
  /** The raw resolve() return value; `null` when ok is false. */
  output: unknown;
  /** Error tag/message when ok is false: a VM error, `check_not_found`,
   *  `no_resolve_fn`, or the message resolve() threw. */
  error: string | null;
}

/**
 * Run a Dice script's body in roll mode for one check, invoking that check's
 * `resolve()` inside the VM under the timeout envelope.
 *
 * The script re-registers its checks (same body as discovery); an appended
 * orchestration snippet then locates the target check by id and calls its
 * `resolve()`. The resolve callback reads the frozen `context.actor`,
 * `context.priorAttempts`, and `context.dice.roll(notation)` from the VM global
 * — the only randomness channel. The raw return value is surfaced for the
 * service layer to validate (arithmetic, strict/narrative, retry-reason/policy).
 *
 * Deterministic given a deterministic {@link DiceRollContext.rng}.
 */
export function executeDiceRoll(
  code: string,
  scriptName: string,
  checkId: string,
  rollContext: DiceRollContext,
  timeoutMs: number = DICE_VM_DEFAULT_TIMEOUT_MS,
): DiceVmRollOutput {
  const registrations: RawDiceCheckRegistration[] = [];
  const roller = makeBoundedRoller(rollContext.rng);

  const sandbox: Record<string, unknown> = {
    context: {
      dice: {
        register(def: RawDiceCheckRegistration): void {
          registrations.push(def);
        },
        roll(notationInput: string): DiceRollResult {
          return roller(notationInput);
        },
      },
      // Frozen actor snapshot — a script cannot mutate who is rolling.
      actor: Object.freeze({ ...rollContext.actor }),
      // Frozen prior attempts — read-only context for retry-grant logic.
      priorAttempts: Object.freeze(
        rollContext.priorAttempts.map((a) => Object.freeze({ ...a })),
      ),
    },
    // Sandbox-visible handles the orchestration snippet reads/writes.
    __registered: registrations,
    __targetCheckId: String(checkId),
    __rollOutput: null,
    __rollError: null,
    ...buildStandardGlobals(),
  };

  // Orchestration appended to the user code: find the target check and invoke
  // resolve() inside the SAME runInNewContext call so the timeout covers it.
  // Uses `var` + plain loops for maximum VM compatibility.
  const orchestration = [
    ";(function () {",
    "  var target = null;",
    "  for (var i = 0; i < __registered.length; i++) {",
    "    if (String(__registered[i].id) === __targetCheckId) { target = __registered[i]; break; }",
    "  }",
    "  if (!target) { __rollError = 'check_not_found'; return; }",
    "  if (typeof target.resolve !== 'function') { __rollError = 'no_resolve_fn'; return; }",
    "  try {",
    "    __rollOutput = target.resolve();",
    "  } catch (e) {",
    "    __rollError = (e && e.message) ? String(e.message) : String(e);",
    "  }",
    "})();",
  ].join("\n");

  try {
    runInNewContext(code + "\n" + orchestration, sandbox, {
      timeout: timeoutMs,
      filename: scriptName,
    });
  } catch (err: unknown) {
    return { ok: false, output: null, error: extractMessage(err) };
  }

  const rollError = sandbox.__rollError as string | null;
  if (rollError) {
    return { ok: false, output: null, error: rollError };
  }
  return { ok: true, output: sandbox.__rollOutput, error: null };
}

// ─── Bounded roller factory ──────────────────────────────────────────────────

/**
 * Build the server-owned bounded roller from an injected {@link RandomSource}.
 * Each call parses+validates the notation, rolls exactly `count` faces via the
 * injected source, and returns the per-face result. This is the ONLY randomness
 * channel a Dice script has — no `Math.random`, no `context.random*`.
 */
function makeBoundedRoller(
  rng: RandomSource,
): (notationInput: string) => DiceRollResult {
  return (notationInput: string): DiceRollResult => {
    const notation = parseDiceNotation(notationInput);
    return rollDice(notation, rng);
  };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
