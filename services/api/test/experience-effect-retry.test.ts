/**
 * ExperienceService.retryEffect — lobby effect diagnostics + retry (pending
 * queue position 1 of EXPERIENCE_ENGINE_LOBBY_REPORT).
 *
 * Boundary under test: the REAL ExperienceService over a REAL in-memory store
 * container (same setup as experience-service.test.ts) — no HTTP layer. Pins
 * the legality vocabulary the route/adapter map onto 404/409:
 *  - failed/cancelled rows retry to `pending` (same id, attemptCount+1, error
 *    cleared) — the caller never runs the effect here;
 *  - a missing effect is a typed 404 `effect_not_found`;
 *  - succeeded/running/pending rows are a typed 409 `effect_not_retryable`
 *    carrying the observed status.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStoreContainer, type StoreContainer } from "@vibe-tavern/db";
import { ExperienceResourceService } from "../src/domain/interactive/experience-resource-service.js";
import { ExperienceService } from "../src/domain/interactive/experience-service.js";

/** Emits one model effect per "ask" action (the Wave-4 effect source). */
const MODEL_EFFECT_SOURCE = `
context.experience.register({
  apiVersion: 1,
  manifest: { id: "m-eff", name: "ModelEffect" },
  capabilities: [],
  create() { return { asked: false }; },
  project(c) { return { asked: c.state.asked }; },
  actions() { return [{ type: "ask" }]; },
  reduce(c) {
    return { state: { asked: true }, status: "active", events: [], effects: [{ kind: "model", request: { prompt: "reply" } }] };
  },
});
`;

let stores: StoreContainer;

async function setup() {
  const dataRoot = await mkdtemp(join(tmpdir(), "vt-xeffretry-"));
  stores = await createStoreContainer(join(dataRoot, "test.db"), dataRoot);
  const resources = new ExperienceResourceService(stores);
  const service = new ExperienceService(stores, resources);
  return { service, resources };
}

async function seedActiveSessionWithFailedEffect(errorText = "provider unavailable") {
  const { service, resources } = await setup();
  const character = await stores.characters.create({ name: "Hero" } as never);
  const chat = await stores.chats.createChat({ characterId: character.id, title: "T" });
  const script = await stores.scripts.create({ name: "Rules", scriptKind: "interactive", code: MODEL_EFFECT_SOURCE });
  await resources.updateConfig(chat.id, { enabled: true, scriptId: script.id, capabilityGrants: [] });

  const started = await service.startSession({ chatId: chat.id, branchId: chat.activeBranchId, settings: {}, participants: [] });
  expect(started.ok).toBe(true);
  if (!started.ok) throw new Error("startSession failed");
  await service.submitAction(started.data.sessionId, { type: "ask", requestId: "a1", expectedRevision: 0 });
  const pending = (await stores.experiences.getEffectsForSession(started.data.sessionId)).find(
    (e) => e.status === "pending",
  );
  if (pending === undefined) throw new Error("no pending effect after ask");
  await stores.experiences.failEffect(pending.id, errorText);
  return { service, effectId: pending.id, sessionId: started.data.sessionId };
}

describe("ExperienceService.retryEffect (lobby effect diagnostics)", () => {
  test("failed → pending: same id, attemptCount+1, error cleared; the effect is NOT run", async () => {
    const { service, effectId } = await seedActiveSessionWithFailedEffect("boom");
    const retried = await service.retryEffect(effectId);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.data.id).toBe(effectId);
    expect(retried.data.status).toBe("pending");
    expect(retried.data.attemptCount).toBe(1);
    expect(retried.data.error).toBeNull();
    // Nothing ran it: the row is pending, not running/succeeded.
    const row = await stores.experiences.getEffectById(effectId);
    expect(row?.status).toBe("pending");
  });

  test("cancelled → pending is retryable too", async () => {
    const { service, effectId } = await seedActiveSessionWithFailedEffect();
    await stores.experiences.cancelEffect(effectId);
    const retried = await service.retryEffect(effectId);
    expect(retried.ok && retried.data.status).toBe("pending");
    expect(retried.ok && retried.data.attemptCount).toBe(1);
  });

  test("missing effect → typed 404 effect_not_found", async () => {
    const { service } = await seedActiveSessionWithFailedEffect();
    const result = await service.retryEffect("eff_missing");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.status).toBe(404);
    expect(result.error.code).toBe("effect_not_found");
  });

  test.each(["pending", "running", "succeeded"] as const)(
    "%s row → typed 409 effect_not_retryable with the observed status",
    async (status) => {
      const { service, effectId } = await seedActiveSessionWithFailedEffect();
      // The seeded row is failed; move it to the target non-retryable state.
      if (status === "pending" || status === "running") {
        // failed → pending (db retry), then claim for running — claimEffect
        // only transitions pending rows.
        await stores.experiences.retryEffect(effectId);
        if (status === "running") await stores.experiences.claimEffect(effectId);
      } else {
        await stores.experiences.completeEffect(effectId, '{"ok":true}');
      }
      const current = await stores.experiences.getEffectById(effectId);
      expect(current?.status).toBe(status);

      const result = await service.retryEffect(effectId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.status).toBe(409);
      expect(result.error.code).toBe("effect_not_retryable");
      expect(result.error.currentStatus).toBe(status);
    },
  );
});
