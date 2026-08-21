/**
 * experience-realtime — RM-9/RM-10 helper boundary tests.
 *
 * Boundary under test: the PURE realtime helpers in
 * `lib/experience-realtime.ts` — no React, no DOM, no wire. (Moved from
 * `components/build/editors/` in RM-10: the live launcher shares the module.)
 * Pins the two contracts the panel relies on:
 *
 *   - `buildRealtimeLoopConfig`: the frame loop config assembled from launch
 *     inputs (viewers from the roster, ungated participants surface, seed /
 *     tickMs / settings passthrough) and the typed failures for the inputs a
 *     realtime round cannot start without.
 *   - `createPlaygroundModelSeam`: the RM-6 fail-closed seam contract — happy
 *     path forwards the visual's prompt verbatim with the seat's pinned
 *     provider/model; unknown/unpinned seats and endpoint failures resolve
 *     `null` with a normalized diagnostic, and raw error text never leaks.
 *
 * Runner: bun:test (pure-logic file — no DOM env, no mock.module).
 */
import { describe, expect, it, mock } from "bun:test";

import {
  buildRealtimeLoopConfig,
  createPlaygroundModelSeam,
  type PlaygroundRealtimeSeat,
} from "./experience-realtime.js";

const RULES = "context.experience.register({ apiVersion: 1 });";

const ROSTER: PlaygroundRealtimeSeat[] = [
  { id: "you", label: "You", controller: "human" },
  { id: "bot", label: "Bot", controller: "script" },
  { id: "ai", label: "AI", controller: "model", providerProfileId: "pp-1", modelId: "m-1" },
];

describe("buildRealtimeLoopConfig", () => {
  it("assembles the full config: viewers from the roster, seed/tickMs/settings passthrough", () => {
    const result = buildRealtimeLoopConfig({
      rulesSource: RULES,
      tickMs: 100,
      initialState: { t: 0 },
      initialSettings: { difficulty: "hard" },
      seed: 12345,
      seats: ROSTER,
      humanSeatId: "you",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { config } = result;
    expect(config.rulesSource).toBe(RULES);
    expect(config.tickMs).toBe(100);
    expect(config.initialState).toEqual({ t: 0 });
    expect(config.initialSettings).toEqual({ difficulty: "hard" });
    expect(config.seed).toBe(12345);
    expect(config.viewer).toEqual({ kind: "human", participantId: "you" });
    expect(config.scriptSeats).toEqual([{ kind: "script", participantId: "bot" }]);
    expect(config.modelSeats).toEqual([{ kind: "model", participantId: "ai" }]);
    expect(config.participants).toEqual([
      { id: "you", label: "You", controller: "human" },
      { id: "bot", label: "Bot", controller: "script" },
      { id: "ai", label: "AI", controller: "model" },
    ]);
  });

  it("falls back to the first human seat when humanSeatId is unset or stale", () => {
    const unset = buildRealtimeLoopConfig({
      rulesSource: RULES, tickMs: 50, initialState: {}, initialSettings: {},
      seed: 1, seats: ROSTER, humanSeatId: "",
    });
    expect(unset.ok).toBe(true);
    if (unset.ok) expect(unset.config.viewer).toEqual({ kind: "human", participantId: "you" });

    const stale = buildRealtimeLoopConfig({
      rulesSource: RULES, tickMs: 50, initialState: {}, initialSettings: {},
      seed: 1, seats: ROSTER, humanSeatId: "ghost",
    });
    expect(stale.ok).toBe(true);
    if (stale.ok) expect(stale.config.viewer).toEqual({ kind: "human", participantId: "you" });
  });

  it("uses the observer viewer when the roster has no human seat", () => {
    const result = buildRealtimeLoopConfig({
      rulesSource: RULES, tickMs: 50, initialState: {}, initialSettings: {},
      seed: 7, seats: [{ id: "bot", label: "Bot", controller: "script" }], humanSeatId: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.viewer).toEqual({ kind: "observer" });
    expect(result.config.scriptSeats).toEqual([{ kind: "script", participantId: "bot" }]);
    expect(result.config.modelSeats).toBeUndefined();
  });

  it("omits participants for an empty roster and drops empty-id rows", () => {
    const result = buildRealtimeLoopConfig({
      rulesSource: RULES, tickMs: 50, initialState: {}, initialSettings: {},
      seed: 3,
      seats: [{ id: "  ", label: "Blank", controller: "human" }],
      humanSeatId: "",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.participants).toBeUndefined();
    expect(result.config.viewer).toEqual({ kind: "observer" });
  });

  it("fails typed when tickMs is missing or invalid", () => {
    const missing = buildRealtimeLoopConfig({
      rulesSource: RULES, tickMs: undefined, initialState: {}, initialSettings: {},
      seed: 1, seats: ROSTER, humanSeatId: "you",
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.message).toContain("tickMs");

    const invalid = buildRealtimeLoopConfig({
      rulesSource: RULES, tickMs: 0, initialState: {}, initialSettings: {},
      seed: 1, seats: ROSTER, humanSeatId: "you",
    });
    expect(invalid.ok).toBe(false);
  });

  it("fails typed on an invalid seed or empty rules source", () => {
    const badSeed = buildRealtimeLoopConfig({
      rulesSource: RULES, tickMs: 50, initialState: {}, initialSettings: {},
      seed: -1, seats: ROSTER, humanSeatId: "you",
    });
    expect(badSeed.ok).toBe(false);
    if (!badSeed.ok) expect(badSeed.message).toContain("seed");

    const emptyRules = buildRealtimeLoopConfig({
      rulesSource: "   ", tickMs: 50, initialState: {}, initialSettings: {},
      seed: 1, seats: ROSTER, humanSeatId: "you",
    });
    expect(emptyRules.ok).toBe(false);
  });
});

describe("createPlaygroundModelSeam", () => {
  const profile = (seatId: string): { providerProfileId: string; modelId: string } | null =>
    seatId === "ai" ? { providerProfileId: "pp-1", modelId: "m-1" } : null;

  it("happy path: forwards the prompt verbatim with the pinned ids, resolves the reply result", async () => {
    const roundModel = mock(async (_body: Record<string, unknown>) => ({
      seatId: "ai",
      requestId: "rq-1",
      result: { type: "move", payload: { dx: 1 } },
    }));
    const onError = mock((_message: string) => undefined);
    const seam = createPlaygroundModelSeam({ roundModel, seatProfile: profile, onError });

    const reply = await seam({ seatId: "ai", requestId: "rq-1", prompt: { viewer: "ai", mode: "action", instruction: "go" } });

    expect(reply).toEqual({ type: "move", payload: { dx: 1 } });
    expect(roundModel).toHaveBeenCalledTimes(1);
    expect(roundModel.mock.calls[0]![0]).toEqual({
      seatId: "ai",
      requestId: "rq-1",
      providerProfileId: "pp-1",
      modelId: "m-1",
      prompt: { viewer: "ai", mode: "action", instruction: "go" },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it("unknown/unpinned seat: resolves null with a diagnostic, never calls the endpoint", async () => {
    const roundModel = mock(async (_body: Record<string, unknown>) => ({
      seatId: "ai",
      result: "unused",
    }));
    const onError = mock((_message: string) => undefined);
    const seam = createPlaygroundModelSeam({ roundModel, seatProfile: profile, onError });

    const reply = await seam({ seatId: "ghost", prompt: { mode: "text" } });

    expect(reply).toBeNull();
    expect(roundModel).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toContain("ghost");
  });

  it("endpoint failure: resolves null with a normalized message — no raw error text", async () => {
    const roundModel = mock(async (_body: Record<string, unknown>): Promise<{ seatId: string; result: unknown }> => {
      throw new Error("RAW-SECRET provider exploded with api_key=sk-live-123");
    });
    const onError = mock((_message: string) => undefined);
    const seam = createPlaygroundModelSeam({ roundModel, seatProfile: profile, onError });

    const reply = await seam({ seatId: "ai", prompt: "ping" });

    expect(reply).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    const message = onError.mock.calls[0]![0];
    expect(message).not.toContain("RAW-SECRET");
    expect(message).not.toContain("sk-live-123");
    expect(message).toContain("ai");
  });
});
