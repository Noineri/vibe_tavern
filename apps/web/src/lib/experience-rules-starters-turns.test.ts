/**
 * Turn-ownership audit for the turn-mode rules starter corpus (grounding step 4.6).
 * The in-scope corpus is currently Round: the other participant starter is the
 * replaced Model Conversation built-in, while Breakout is a solo realtime round.
 */
import { describe, expect, it } from "bun:test";
import {
  runActions,
  runCreate,
  runReduce,
  type ExperienceCapabilityContext,
} from "../../../../services/api/src/domain/interactive/experience-kernel.js";
import { getRulesStarter } from "./experience-rules-starters.js";

const PARTICIPANTS = [
  { id: "you", label: "You", controller: "human" as const },
  { id: "bot", label: "Bot", controller: "human" as const },
];

describe("rules starter turn ownership audit", () => {
  it("Round gives legal actions to exactly one seat and alternates for four actions", () => {
    const starter = getRulesStarter("round");
    if (starter === undefined) throw new Error("Round starter is missing");
    const capabilities: ExperienceCapabilityContext = { participants: PARTICIPANTS };
    const created = runCreate(starter.source, "round.js", {}, capabilities);
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.message);

    let state = created.value;
    const expectedOwners = ["you", "bot", "you", "bot"];
    const actionTypes = ["pass", "pass", "pass", "pass"];

    for (const [index, expectedOwner] of expectedOwners.entries()) {
      const legalBySeat = PARTICIPANTS.map((participant) => {
        const result = runActions(
          starter.source,
          "round.js",
          state,
          { kind: "human", participantId: participant.id },
          capabilities,
        );
        expect(result.ok).toBe(true);
        if (!result.ok) throw new Error(result.message);
        return { participantId: participant.id, actions: result.value };
      });
      const owners = legalBySeat.filter(({ actions }) => actions.length > 0);
      expect(owners).toHaveLength(1);
      expect(owners[0]?.participantId).toBe(expectedOwner);
      expect(owners[0]?.actions.map((action) => action.type)).toEqual(["score", "pass"]);

      const transition = runReduce(starter.source, "round.js", state, {
        type: actionTypes[index] ?? "pass",
        participantId: expectedOwner,
        requestId: `round-audit-${index}`,
        expectedRevision: index,
      }, capabilities);
      expect(transition.ok).toBe(true);
      if (!transition.ok) throw new Error(transition.message);
      state = transition.value.state;
    }
  });
});