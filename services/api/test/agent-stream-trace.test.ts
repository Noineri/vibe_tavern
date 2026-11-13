import { afterAll, afterEach, expect, it } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { LanguageModel } from "ai";
import type { ProviderProfile } from "@vibe-tavern/db";
import { streamAgentTurn, type AgentStreamDeps, type AgentStreamSeams } from "../src/domain/agent/agent-stream.js";
import { configureLogDir, getSendDebugLogDir } from "../src/shared/send-debug-log.js";
import { createAgentTransportTrace } from "../src/shared/agent-transport-trace.js";

// L1: derived temporary paths; env restored after EACH test and afterAll;
// real turn loop and persistence seam, only provider stream stubbed; no sleeps/DB.
const original = process.env.VT_AGENT_TRACE_DIR;
const originalLogDir = getSendDebugLogDir();
const roots: string[] = [];
function restoreEnv() {
  configureLogDir(originalLogDir);
  if (original === undefined) delete process.env.VT_AGENT_TRACE_DIR;
  else process.env.VT_AGENT_TRACE_DIR = original;
}
afterEach(restoreEnv);
afterAll(async () => {
  restoreEnv();
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

it("the opt-in marker enables tracing dynamically and removing it disables later turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-trace-marker-"));
  roots.push(dir);
  delete process.env.VT_AGENT_TRACE_DIR;
  configureLogDir(dir);
  const metadata = { threadId: "marker-thread" };
  expect(createAgentTransportTrace(metadata)).toBeUndefined();
  const marker = join(dir, "agent-trace.enabled");
  await writeFile(marker, join(dir, "captures"));
  const trace = createAgentTransportTrace(metadata)!;
  expect(trace).toBeDefined();
  await trace.flush();
  expect((await readdir(join(dir, "captures"))).length).toBe(1);
  await unlink(marker);
  expect(createAgentTransportTrace(metadata)).toBeUndefined();
});

it("traces the real agent assembly, prepared messages, ordered deltas and exact persisted row", async () => {
  const dir = await mkdtemp(join(tmpdir(), "agent-stream-trace-"));
  roots.push(dir);
  process.env.VT_AGENT_TRACE_DIR = dir;
  const stored: Array<Record<string, unknown>> = [];
  const profile = { id: "provider", endpoint: "http://localhost:8090", providerPreset: "openai", defaultModel: "test-model", proxyMode: "inherit", proxyId: null } as ProviderProfile;
  const deps: AgentStreamDeps = {
    store: {
      getById: async () => ({ id: "thread", scriptId: null, contextLinks: [] }),
      listMessages: async () => [],
      appendMessage: async (_threadId, input) => {
        const row = { id: `row-${stored.length}`, ...input };
        stored.push(row);
        return row;
      },
      setToolResultOutput: async () => {},
      updateContextMetrics: async () => {},
    },
    getProviderProfile: async () => profile,
    getEffectiveProviderProfile: async () => profile,
    resolveModel: () => ({}) as LanguageModel,
    streamText: (() => ({
      stream: (async function* () {
        yield { type: "text-delta", text: "Answer." };
        yield { type: "reasoning-delta", text: "Another thought" };
        yield { type: "text-delta", text: "Extra tail." };
      })(),
      finishReason: Promise.resolve("stop"),
      usage: Promise.resolve(undefined),
    })) as unknown as NonNullable<AgentStreamDeps["streamText"]>,
  };
  const seams: AgentStreamSeams = {
    logChannelPrefix: "test.trace",
    threadLabel: "Thread",
    limits: { contextBudgetTokens: 100000, responseReserveTokens: 4000, toolLoopCeiling: 1 },
    loadContext: async () => null,
    resolveProfile: async () => ({}),
    assemble: async () => ({ systemMessage: "System", messages: [{ role: "system", content: "System" }, { role: "user", content: "Question" }], tokenAccounting: { system: 1, digest: 0, history: 1, attached: 0, total: 2 } }),
    buildTools: () => ({}),
  };
  const events = [];
  for await (const event of streamAgentTurn({ threadId: "thread", content: "Question", providerProfileId: "provider" }, deps, seams)) events.push(event.event);
  expect(events).toEqual(["text-delta", "reasoning-delta", "text-delta", "reasoning-done", "finish"]);
  expect(stored.at(-1)?.content).toBe("Answer.Extra tail.");
  const files = await readdir(dir);
  expect(files).toHaveLength(1);
  const rows = (await readFile(join(dir, files[0]!), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  expect(rows.find((row) => row.event === "assembled").data.messages.at(-1).content).toBe("Question");
  expect(rows.find((row) => row.event === "model.messages").data.messages.at(-1).content).toBe("Question");
  expect(rows.filter((row) => row.event === "mapped.chunk").map((row) => row.data.type)).toEqual(["text-delta", "reasoning-delta", "text-delta"]);
  expect(rows.find((row) => row.event === "persisted.row").data.row.content).toBe("Answer.Extra tail.");
  expect(rows.at(-1).event).toBe("turn.end");
});
