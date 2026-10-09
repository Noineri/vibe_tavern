import { describe, expect, it } from "bun:test";

import { parseHordeQueueState } from "./horde-queue-state.js";

describe("parseHordeQueueState", () => {
  it("parses a queued position and ETA", () => {
    expect(parseHordeQueueState("queue:2:300")).toEqual({
      kind: "queue",
      position: 2,
      etaSeconds: 300,
    });
  });

  it("parses the drawing state", () => {
    expect(parseHordeQueueState("drawing")).toEqual({ kind: "drawing" });
  });

  it("rejects undefined, malformed, non-horde, and invalid queue states", () => {
    expect(parseHordeQueueState(undefined)).toBeNull();
    expect(parseHordeQueueState("Generating…")).toBeNull();
    expect(parseHordeQueueState("queue:0:5")).toBeNull();
    expect(parseHordeQueueState("queue:-1:5")).toBeNull();
    expect(parseHordeQueueState("queue:2:-5")).toBeNull();
    expect(parseHordeQueueState("queue:2:5.5")).toBeNull();
    expect(parseHordeQueueState("other:2:300")).toBeNull();
  });
});
