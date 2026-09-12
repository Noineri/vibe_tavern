import { streamText } from "ai";
import type { ModelMessage } from "ai";
import { resolveProviderFetchForProfile } from "../../domain/providers/provider-fetch-factory.js";
import { resolveSystemPrompt } from "./ai-assistant-prompts.js";
import { regexAssistRuleDraftSchema, type RegexAssistRequest, type RegexAssistResponse } from "@vibe-tavern/api-contracts";
import type { StreamDeps } from "./ai-assistant-stream.js";

/** Test seam for the executor (experience-copilot-stream precedent):
 *  `mock.module("ai")` is process-global and permanent under bun:test, so
 *  the fake is injected via deps instead. The injected form takes no `model`
 *  — provider machinery is skipped entirely on the seam path. */
export type RegexAssistStreamFn = (opts: {
  messages: ModelMessage[];
  temperature: number;
  maxOutputTokens: number;
}) => Promise<{ textStream: AsyncIterable<string> }>;

function buildRegexAssistInstruction(req: RegexAssistRequest): string {
  const parts: string[] = [];
  const arch = req.archetype ?? "custom";
  parts.push(`Archetype: ${arch}`);
  parts.push(`Task: ${req.task}`);
  if (req.sampleText?.trim()) parts.push(`Sample text:\n${req.sampleText}`);
  if (req.currentRule) parts.push(`Current rule draft:\n${JSON.stringify(req.currentRule)}`);
  if (req.previousAttempt) {
    parts.push(`Previous attempt rule:\n${JSON.stringify(req.previousAttempt.rule)}`);
    parts.push(`Test result:\n${req.previousAttempt.testResult}`);
    parts.push("Refine the rule to fix the test result. Return the corrected JSON.");
  }
  return parts.join("\n\n");
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  return null;
}

function extractJsonFromText(text: string): Record<string, unknown> | null {
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    const p = tryParseJson(fenceMatch[1]);
    if (p) return p;
  }
  const firstBrace = text.indexOf("{");
  if (firstBrace === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = firstBrace; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") depth++;
    if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) return tryParseJson(text.slice(firstBrace, i + 1));
    }
  }
  return tryParseJson(text);
}

function normalizeDraft(obj: Record<string, unknown>): RegexAssistResponse["draft"] | null {
  const str = (k: string) => (typeof obj[k] === "string" ? String(obj[k]) : "");
  const name = str("name").trim();
  const find = str("findRegex").trim() || str("find").trim();
  if (!name || !find) return null;
  let trims: string[] = [];
  if (Array.isArray(obj.trimStrings)) trims = (obj.trimStrings as unknown[]).filter((v): v is string => typeof v === "string");
  const apply = typeof obj.applyTarget === "string" ? String(obj.applyTarget) : "persist";
  const depthM = typeof obj.depthMode === "string" ? String(obj.depthMode) : "all";
  const validApply = new Set(["persist", "display", "prompt", "display_prompt"]);
  const validDepth = new Set(["all", "recent", "older", "range"]);
  const candidate = {
    name,
    findRegex: find,
    replaceString: typeof obj.replaceString === "string" ? String(obj.replaceString) : "",
    trimStrings: trims,
    applyTarget: validApply.has(apply) ? apply : "persist",
    depthMode: validDepth.has(depthM) ? depthM : "all",
    explanation: str("explanation") || "Text transformation rule draft.",
    ...(typeof obj.depthValue === "number" && Number.isFinite(obj.depthValue) && obj.depthValue >= 1
      ? { depthValue: Math.floor(obj.depthValue) }
      : {}),
    ...(typeof obj.sampleText === "string" && obj.sampleText.trim() ? { sampleText: String(obj.sampleText) } : {}),
  };
  // Real contract validation — the api-contracts schema is the single
  // authority on what a wire-ready draft is.
  const parsed = regexAssistRuleDraftSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data;
}

export async function generateRegexAssist(
  req: RegexAssistRequest,
  deps: StreamDeps & { streamTextImpl?: RegexAssistStreamFn },
): Promise<RegexAssistResponse> {
  const profile = await deps.getProviderProfile(req.providerProfileId);
  if (!profile) throw new Error(`Provider profile not found: ${req.providerProfileId}`);
  const modelName = req.model ?? profile.defaultModel ?? "gpt-4o-mini";
  const effectiveProfile = await deps.getEffectiveProviderProfile(req.providerProfileId, modelName);
  let sysPrompt = "You are a precise regex-rule authoring engine.";
  try {
    const resolved = await resolveSystemPrompt(deps.db, "regex");
    sysPrompt = resolved.prompt;
  } catch (e) {
    // Resolver failure must not kill generation — fall back to a minimal
    // neutral system prompt, but leave a trace for debugging.
    deps.logDebug?.("api.regex-assist.prompt-resolve-failed", {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const instruction = buildRegexAssistInstruction(req);

  const messages: ModelMessage[] = [
    { role: "system", content: sysPrompt },
    { role: "user", content: instruction },
  ];

  // Sampling is pinned low + bounded for a JSON mode.
  const streamOpts = { messages, temperature: 0.2, maxOutputTokens: 2000 } as const;
  let fullText = "";
  if (deps.streamTextImpl) {
    const result = await deps.streamTextImpl(streamOpts);
    for await (const chunk of result.textStream) fullText += chunk;
  } else {
    const aiModel = deps.resolveModel(effectiveProfile, modelName, await resolveProviderFetchForProfile(effectiveProfile));
    const result = await streamText({ ...streamOpts, model: aiModel });
    for await (const chunk of result.textStream) fullText += chunk;
  }
  const json = extractJsonFromText(fullText);
  if (!json) throw new Error("Model returned no parsable JSON. Raw output: " + fullText.slice(0, 500));
  const draft = normalizeDraft(json);
  if (!draft) throw new Error("Parsed JSON missing required fields. Raw: " + JSON.stringify(json).slice(0, 500));
  return { draft, rawText: fullText };
}
