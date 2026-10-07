/** Public-kernel coverage for the owner-approved Breakout realtime export. */
import { describe, expect, test } from "bun:test";
import { BREAKOUT_RULES_SOURCE } from "@vibe-tavern/domain/builtins";
import { discoverExperienceDefinition, runCreate, runProject, runReduce, runUpdate, type ExperienceCapabilityContext } from "../src/domain/interactive/experience-kernel.js";

const CAPS: ExperienceCapabilityContext = { random: { float: () => 0.5, int: (min) => min } };

describe("Breakout builtin", () => {
  test("discovers the realtime manifest and capabilities", () => {
    const result = discoverExperienceDefinition(BREAKOUT_RULES_SOURCE, "breakout.js");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.manifest).toMatchObject({ id: "breakout_arcade", mode: "realtime", tickMs: 33 });
    expect(result.definition.declaredCapabilities.map((item) => item.capability)).toEqual(["participants", "deterministic_random"]);
  });

  test("starts from the lobby and projects the visual-safe state", () => {
    const created = runCreate(BREAKOUT_RULES_SOURCE, "breakout.js", {}, CAPS);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = runReduce(BREAKOUT_RULES_SOURCE, "breakout.js", created.value, { type: "start", requestId: "start", expectedRevision: 0 }, CAPS);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const projected = runProject(BREAKOUT_RULES_SOURCE, "breakout.js", started.value.state, { kind: "observer" }, CAPS);
    expect(projected.ok).toBe(true);
    if (!projected.ok) return;
    expect(projected.value).toMatchObject({ started: true, paused: false, level: 1 });
    expect(projected.value.balls).toHaveLength(1);
  });

  test("a realtime tick preserves the active state contract", () => {
    const created = runCreate(BREAKOUT_RULES_SOURCE, "breakout.js", {}, CAPS);
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const started = runReduce(BREAKOUT_RULES_SOURCE, "breakout.js", created.value, { type: "start", requestId: "start", expectedRevision: 0 }, CAPS);
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const tick = runUpdate(BREAKOUT_RULES_SOURCE, "breakout.js", started.value.state, 33, CAPS);
    expect(tick.ok).toBe(true);
    if (!tick.ok) return;
    expect(tick.value.status).toBe("active");
    expect(tick.value.state).toHaveProperty("balls");
  });
});