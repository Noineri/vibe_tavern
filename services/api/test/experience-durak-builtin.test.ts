import { describe, expect, test } from "bun:test";
import { DURAK_RULES_SOURCE } from "@vibe-tavern/domain/builtins";
import type { ExperienceParticipant } from "@vibe-tavern/domain";
import {
  createDeterministicRandom,
  createEphemeralRandom,
  runActions,
  runChoose,
  runCreate,
  runReduce,
} from "../src/domain/interactive/experience-kernel.js";
import { buildCapabilityContext } from "../src/domain/interactive/experience-shared.js";
import { runExperienceTest, simulateExperienceTest } from "../src/domain/interactive/experience-tester.js";

const GRANTS = ["participants", "deterministic_random"] as const;
const HUMAN_FIRST: ExperienceParticipant[] = [
  { id: "you", label: "You", controller: "human" },
  { id: "bot", label: "Bot", controller: "script" },
];
const BOT_FIRST: ExperienceParticipant[] = [
  { id: "bot", label: "Bot", controller: "script" },
  { id: "you", label: "You", controller: "human" },
];

/** Unwrap a kernel `{ok, value}` result, bailing with its message. */
function unwrap<T>(r: { ok: true; value: T } | { ok: false; message: string }): T {
  if (!r.ok) throw new Error(r.message);
  return r.value;
}

describe("Durak built-in", () => {
  test("discovers the owner's setup contract and choose method", () => {
    const result = runExperienceTest({
      rulesCode: DURAK_RULES_SOURCE,
      participants: HUMAN_FIRST,
      capabilityGrants: GRANTS,
      seed: "durak-contract",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.definition.manifest.id).toBe("durak");
    expect(result.data.definition.hasChoose).toBe(true);
    expect(result.data.definition.declaredCapabilities.map((item) => item.capability)).toEqual(GRANTS);
    expect(result.data.definition.setup?.fields.map((field) => field.id)).toEqual([
      "deckSize",
      "targetWins",
      "first5",
      "botDifficulty",
      "adaptive",
    ]);
    expect(result.data.seatLegality.turnOwners).toEqual(["you"]);
    expect(result.data.seatLegality.seats.map((seat) => seat.actionTypes)).toEqual([["start_match"], []]);
  });

  test("a bot in the first seat opens and hands play to the human", () => {
    const result = simulateExperienceTest({
      rulesCode: DURAK_RULES_SOURCE,
      participants: BOT_FIRST,
      capabilityGrants: GRANTS,
      seed: "durak-bot-opening",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.iterations).toBeGreaterThan(0);
    expect(result.data.stopReason).toBe("awaiting_human");
    expect(result.data.steps[0]?.actionType).toBe("start_match");
    expect(result.data.steps.every((step) => step.participantId === "bot")).toBe(true);
  });

  test("lobby legality: only the FIRST seat can start_match at the initial state", () => {
    // The lobby gate is seat ORDER, not controller: whichever participant sits
    // first holds the only legal action. Pinned with the bot first — the human
    // seat (second) has none — complementing the human-first discovery matrix
    // above (turnOwners ["you"], seats [[start_match], []]).
    const result = runExperienceTest({
      rulesCode: DURAK_RULES_SOURCE,
      participants: BOT_FIRST,
      capabilityGrants: GRANTS,
      seed: "durak-lobby-bot-first",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.seatLegality.seats.map((seat) => seat.actionTypes)).toEqual([["start_match"], []]);
    expect(result.data.seatLegality.turnOwners).toEqual(["bot"]);
  });

  test("across the bot-first simulation exactly one seat has legal actions at every step", () => {
    // An independent kernel replay of the bot-first opening, mirroring the
    // tester's simulation loop (per-seat actions() → the acting seat's choose →
    // reduce) with a fixed deterministic-random stream. At EVERY state —
    // including the lobby and the final human boundary — exactly one of the two
    // seats may hold legal actions; the acting seat is the bot until the
    // boundary flips to the human (the awaiting_human stop of the suite above).
    const scriptName = "durak.js";
    const rng = createDeterministicRandom(20261007);
    let state: unknown = unwrap(
      runCreate(DURAK_RULES_SOURCE, scriptName, {}, buildCapabilityContext(GRANTS, BOT_FIRST, rng)),
    );
    let revision = 0;
    const actorIds: string[] = [];

    for (let step = 0; step < 16; step += 1) {
      const seatLegality = BOT_FIRST.map((participant) => ({
        participant,
        legal: unwrap(
          runActions(
            DURAK_RULES_SOURCE,
            scriptName,
            state,
            {
              kind: participant.controller === "human" ? "human" as const : "script" as const,
              participantId: participant.id,
            },
            buildCapabilityContext(GRANTS, BOT_FIRST),
          ),
        ),
      }));

      // THE pin: never two live seats at once (the turn-gating invariant).
      const live = seatLegality.filter((seat) => seat.legal.length > 0);
      expect(live).toHaveLength(1);

      const actor = live[0]!;
      actorIds.push(actor.participant.id);

      // The human boundary ends the bot's opening run — the state the tester's
      // simulation stops at with awaiting_human.
      if (actor.participant.controller === "human") break;

      const intent = unwrap(
        runChoose(
          DURAK_RULES_SOURCE,
          scriptName,
          state,
          { kind: "script", participantId: actor.participant.id },
          actor.legal,
          buildCapabilityContext(GRANTS, BOT_FIRST, undefined, createEphemeralRandom()),
        ),
      );
      const transition = unwrap(
        runReduce(
          DURAK_RULES_SOURCE,
          scriptName,
          state,
          {
            type: intent.type,
            requestId: `durak-one-seat-${revision}`,
            expectedRevision: revision,
            participantId: intent.participantId ?? actor.participant.id,
            ...(intent.payload !== undefined ? { payload: intent.payload } : {}),
          },
          buildCapabilityContext(GRANTS, BOT_FIRST, rng),
        ),
      );
      expect(transition.status).toBe("active");
      revision += 1;
      state = transition.state;
    }

    // The whole run was the bot's opening (start_match → …) and it ended by
    // handing the single live seat to the human — never back to the bot.
    expect(actorIds[0]).toBe("bot");
    expect(actorIds[actorIds.length - 1]).toBe("you");
    expect(actorIds.filter((id) => id === "you")).toHaveLength(1);
  });
});