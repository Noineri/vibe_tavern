import { describe, it, expect, afterAll } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRuntimeStore } from "../src/runtime/session/session-runtime-store.js";
import { SessionRuntime } from "../src/runtime/session/session-runtime.js";
import type { ChatId } from "@vibe-tavern/domain";
import type { ExtractedToolCall, ExtractedToolResult } from "../src/infrastructure/ai/provider-execution-types.js";

/**
 * CTX-S5 — `read_skill_file` is a NON-proposal tool (its result is
 * `{path, content}`, not a CoauthorToolOutput). This file pins that such a
 * read-only tool call flows through the SAME persistence + replay path as the
 * proposal tools, unchanged:
 *
 *   1. PERSISTENCE — a read_skill_file pair (assistant call + tool result +
 *      final text) commits as three separate branch messages, the `{path,
 *      content}` result survives byte-for-byte, and the replay-critical
 *      provider metadata round-trips for BOTH provider families the app ships:
 *      the OpenAI-compatible streaming namespace AND the Google non-streaming
 *      `thoughtSignature`. (Self-check: "OpenAI-compatible streaming and Google
 *      non-streaming checks green".)
 *   2. REPLAY / NO ORPHANING — after commit, every tool RESULT still has its
 *      carrier assistant tool-call co-located in the branch, so a follow-up
 *      turn's assembled prompt can reconstruct the pair. The reconstruction
 *      itself (history → SDK v6 ToolCallPart + tool-result) is pinned generically
 *      in coauthor-prompt.test.ts (CS-4); this file pins the DB side that feeds
 *      it: the call/result rows survive together with matching toolCallIds.
 *      (Self-check: "no tool-result orphaning".)
 *
 * The persistence layer (`appendAssistantReply`) is tool-name-agnostic, so a
 * read_skill_file pair is expected to behave identically to the `runCommand`
 * pair pinned in agentic-message-sequence.test.ts — this file exists to pin
 * that invariant for the read-only tool specifically, guarding against a future
 * regression that special-cases proposal tools and silently drops reads.
 */

async function createTestRuntime(): Promise<{
  runtime: SessionRuntime;
  chatId: ChatId;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = resolve(tmpdir(), "vt-ctx-s5-" + crypto.randomUUID().slice(0, 8));
  await mkdir(resolve(tmpDir, "data"), { recursive: true });
  const stores = await createRuntimeStore(resolve(tmpDir, "data"));
  await Promise.all([
    stores.personas.ensureDefault(),
    stores.presets.ensureDefault(),
    stores.uiSettings.ensureDefaults(),
  ]);
  const runtime = new SessionRuntime(stores, { getActiveProviderProfile: async () => null });
  const created = await runtime.character.createFromScratch({
    name: "CoAuthorSkillReadProbe",
    description: "a probe character",
    firstMessage: "Hello!",
  });
  return {
    runtime,
    chatId: created.activeChatId,
    cleanup: async () => {
      try {
        await rm(tmpDir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    },
  };
}

/** The canonical read_skill_file result shape produced by skill-read-tool.ts. */
const READ_RESULT = {
  path: "general-writing/SKILL.md",
  content: "---\nname: general-writing\n---\n\n# General Writing\nWrite vivid prose.\n",
};

describe("CTX-S5: read_skill_file persistence + replay (non-proposal tool activity)", () => {
  let env: Awaited<ReturnType<typeof createTestRuntime>>;
  afterAll(async () => {
    if (env) await env.cleanup();
  });

  it("OpenAI-compatible streaming shape: persists the read pair + provider metadata; result content survives", async () => {
    env = await createTestRuntime();
    await env.runtime.chatApp.appendUserMessage(env.chatId, {
      content: "Polish the personality using general-writing.",
      mode: "reply",
    });

    const toolCalls: ExtractedToolCall[] = [
      {
        toolCallId: "tc_read_oai",
        toolName: "read_skill_file",
        args: { path: READ_RESULT.path },
        // OpenAI-compatible providers carry replay metadata under their own
        // namespace (matches sampler-mapper's openai_compat name). The streaming
        // executor forwards this from the SDK tool-call part verbatim.
        providerOptions: { openaiCompat: { index: 0 } },
      },
    ];
    const toolResults: ExtractedToolResult[] = [
      {
        toolCallId: "tc_read_oai",
        toolName: "read_skill_file",
        args: { path: READ_RESULT.path },
        result: READ_RESULT,
        isError: false,
      },
    ];

    await env.runtime.chatRuntime.appendAssistantReply(env.chatId, "Done — applied the guidance.", 100, {
      reasoning: undefined,
      toolCalls,
      toolResults,
    });

    const snap = await env.runtime.getSnapshot(env.chatId);
    // 1 seed + 1 user + 3 (assistant-toolcall / tool-result / assistant-text) = 5.
    expect(snap.messages.length).toBe(5);
    const seq = snap.messages.slice(2); // drop seed firstMessage + our user msg

    // assistant carrier with the read_skill_file tool call + provider metadata.
    expect(seq[0].role).toBe("assistant");
    const callVar = seq[0].variants[seq[0].selectedVariantIndex];
    expect(callVar.toolCalls?.length).toBe(1);
    expect(callVar.toolCalls?.[0].id).toBe("tc_read_oai");
    expect(callVar.toolCalls?.[0].name).toBe("read_skill_file");
    expect(callVar.toolCalls?.[0].args).toEqual({ path: READ_RESULT.path });
    expect(callVar.toolCalls?.[0].providerOptions).toEqual({ openaiCompat: { index: 0 } });

    // tool RESULT row — content is the JSON-stringified {path, content}; the
    // toolCallId ties it to its carrier (no orphaning).
    expect(seq[1].role).toBe("tool");
    const resultVar = seq[1].variants[seq[1].selectedVariantIndex];
    expect(resultVar.toolCallId).toBe("tc_read_oai");
    // The result object is JSON-stringified on persist; parse it back and
    // confirm the full read content survives byte-for-byte.
    expect(JSON.parse(resultVar.content)).toEqual(READ_RESULT);

    // final assistant text.
    expect(seq[2].role).toBe("assistant");
    expect(seq[2].variants[seq[2].selectedVariantIndex].content).toBe("Done — applied the guidance.");
  });

  it("Google non-streaming shape: thoughtSignature provider metadata round-trips through the read pair", async () => {
    // Same persistence path, different provider family. Gemini stores its
    // replay-critical thoughtSignature under the `google` namespace; losing it
    // would break the next turn's functionCall continuation. A read_skill_file
    // call must preserve it just like a proposal call does.
    await env.runtime.chatApp.appendUserMessage(env.chatId, {
      content: "Also check the references.",
      mode: "reply",
    });

    const toolCalls: ExtractedToolCall[] = [
      {
        toolCallId: "tc_read_google",
        toolName: "read_skill_file",
        args: { path: "general-writing/references/rules.md" },
        providerOptions: { google: { thoughtSignature: "sig_google_read" } },
      },
    ];
    const toolResults: ExtractedToolResult[] = [
      {
        toolCallId: "tc_read_google",
        toolName: "read_skill_file",
        args: { path: "general-writing/references/rules.md" },
        result: { path: "general-writing/references/rules.md", content: "# Rules\n..." },
        isError: false,
      },
    ];

    await env.runtime.chatRuntime.appendAssistantReply(env.chatId, "Got it.", 80, {
      reasoning: undefined,
      toolCalls,
      toolResults,
    });

    const snap = await env.runtime.getSnapshot(env.chatId);
    // Find the just-appended tool-call carrier (last assistant-with-toolCalls).
    const callCarrier = [...snap.messages]
      .reverse()
      .find((m) => m.role === "assistant" && m.variants[m.selectedVariantIndex]?.toolCalls?.some((tc) => tc.id === "tc_read_google"));
    expect(callCarrier).toBeDefined();
    const tc = callCarrier!.variants[callCarrier!.selectedVariantIndex].toolCalls!.find((t) => t.id === "tc_read_google")!;
    expect(tc.providerOptions).toEqual({ google: { thoughtSignature: "sig_google_read" } });

    // And its paired result row is present (no orphaning).
    const resultRow = snap.messages.find(
      (m) => m.role === "tool" && m.variants[m.selectedVariantIndex]?.toolCallId === "tc_read_google",
    );
    expect(resultRow).toBeDefined();
    expect(JSON.parse(resultRow!.variants[resultRow!.selectedVariantIndex].content)).toEqual({
      path: "general-writing/references/rules.md",
      content: "# Rules\n...",
    });
  });
});
