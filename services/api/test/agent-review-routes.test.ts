/** BR-2b1: real routes, production adapter/service and SQLite, no test doubles. */
import { describe, expect, test } from "bun:test";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createStoreContainer } from "@vibe-tavern/db";
import type { AgentReviewEnvelope } from "@vibe-tavern/api-contracts";
import { ExperienceCopilotAdapter } from "../src/api/adapters/experience-copilot-adapter.js";
import { createExperienceCopilotRoutes } from "../src/api/routes/experience-copilot.js";
import { domainErrorToJson, httpStatusForDomainError, isDomainError } from "../src/shared/errors.js";

function envelope(proposed = "New rules"): AgentReviewEnvelope {
  return {
    _v: 2,
    activities: [{ toolCallId: "write", toolName: "write_buffer", status: "done", target: "rules", proposed, summary: "Changed", args: { content: proposed } }],
    round: {
      snapshots: [{ id: 1, rules: "Old rules", visual: "Old visual" }], nextSnapshotId: 2,
      acceptedRules: [0], acceptedVisual: [], dismissedRules: [1], dismissedVisual: [],
      rulesKey: `Old rules\0${proposed}`, visualKey: null,
      dangling: { visual: "Pending visual", baseRules: "Old rules", baseVisual: "Old visual" },
    },
  };
}
async function setup() {
  const stores = await createStoreContainer(":memory:");
  const thread = await stores.experienceCopilot.startNewSession("script", "Review");
  const adapter = new ExperienceCopilotAdapter(stores);
  const app = createExperienceCopilotRoutes(adapter);
  app.onError((error, c) => isDomainError(error)
    ? c.json(domainErrorToJson(error), httpStatusForDomainError(error) as ContentfulStatusCode)
    : c.json({ error: error.message }, 500));
  const path = `/api/experience-copilot/${thread.id}/review`;
  const put = (body: unknown, url = path) => app.request(url, {
    method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  return { stores, thread, app, path, put };
}

describe("agent review routes", () => {
  test("GET absent, PUT complete envelope, GET saved and PUT replacement round-trip", async () => {
    const h = await setup();
    expect(await (await h.app.request(h.path)).json()).toBeNull();
    const first = envelope();
    const response = await h.put(first);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(first);
    expect(await (await h.app.request(h.path)).json()).toEqual(first);
    expect(JSON.parse((await h.stores.agentReviewRounds.get(h.thread.id))!.envelopeJson)).toEqual(first);
    const replacement = envelope("Revised");
    expect((await h.put(replacement)).status).toBe(200);
    expect(await (await h.app.request(h.path)).json()).toEqual(replacement);
  });

  test("malformed/version-skewed/transient input is rejected before overwriting the saved review", async () => {
    const h = await setup();
    const first = envelope();
    await h.put(first);
    for (const bad of [
      {}, { ...first, _v: 1 }, { ...first, round: { snapshots: "bad" } },
      { ...first, activities: [{ ...first.activities[0], status: "streaming" }] },
      { ...first, activities: [{ ...first.activities[0], proposed: "" }] },
      { ...first, extra: "not an envelope field" },
    ]) expect((await h.put(bad)).status).toBe(400);
    expect(await (await h.app.request(h.path)).json()).toEqual(first);
  });

  test("DELETE is idempotent, thread-scoped, and does not delete the owning session", async () => {
    const h = await setup();
    const other = await h.stores.experienceCopilot.startNewSession("other", "Other");
    await h.put(envelope());
    await h.put(envelope("Other"), `/api/experience-copilot/${other.id}/review`);
    for (let i = 0; i < 2; i++) {
      const response = await h.app.request(h.path, { method: "DELETE" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    }
    expect(await (await h.app.request(h.path)).json()).toBeNull();
    expect(await h.stores.experienceCopilot.getById(h.thread.id)).not.toBeNull();
    expect(await h.stores.agentReviewRounds.get(other.id)).not.toBeNull();
  });

  test("all three methods return 404 for a nonexistent thread", async () => {
    const h = await setup();
    const missing = "/api/experience-copilot/missing/review";
    for (const method of ["GET", "DELETE"]) expect((await h.app.request(missing, { method })).status).toBe(404);
    expect((await h.put(envelope(), missing)).status).toBe(404);
    expect(await h.stores.agentReviewRounds.get("missing")).toBeNull();
  });

  test("corrupt saved JSON is not silently deleted or served as a valid empty review", async () => {
    const h = await setup();
    await h.stores.agentReviewRounds.put(h.thread.id, "broken JSON");
    expect((await h.app.request(h.path)).status).toBe(500);
    expect((await h.stores.agentReviewRounds.get(h.thread.id))!.envelopeJson).toBe("broken JSON");
    expect((await h.put(envelope())).status).toBe(200);
    expect(await (await h.app.request(h.path)).json()).toEqual(envelope());
  });
});
