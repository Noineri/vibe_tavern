import type { AppDb } from "@vibe-tavern/db";
import { normalizeTrackerTemplate, type TrackerTemplate } from "@vibe-tavern/domain";
import { trackerTemplateSchema } from "@vibe-tavern/api-contracts";
import { resolveSystemPrompt } from "../../ai-assistant/ai-assistant-prompts.js";
import type { ProviderExecutionInput } from "../../../infrastructure/ai/provider-execution-types.js";

/** The executor signature (typeof nonstreamingProviderExecute). */
export type TrackerExecutor = (input: ProviderExecutionInput) => Promise<{ text: string }>;

/** A resolved provider profile (the wire shape the executor consumes). */
export type TrackerResolvedProfile = ProviderExecutionInput["profile"];

/** Context gathered by set_tracker_template for one isolated generation call. */
export interface TrackerDelegateInput {
  action: "create" | "refine";
  modeHint?: "route" | "goals";
  focusNotes?: string;
  characterProfileMd: string;
  currentTemplate: TrackerTemplate | null;
}

/** The validated structured result handed back to the tool layer. */
export interface TrackerDelegateResult {
  trackerTemplate: TrackerTemplate;
}

/** The callback contract injected into buildCoauthorTools. */
export type TrackerDelegate = (input: TrackerDelegateInput, signal?: AbortSignal) => Promise<TrackerDelegateResult>;

export interface CreateTrackerDelegateDeps {
  execute: TrackerExecutor;
  profile: TrackerResolvedProfile;
  model: string;
  db: AppDb;
}

/** Build the minimal one-shot AssemblePromptResponse the executor consumes. */
function buildOneShotPrompt(system: string, user: string): import("@vibe-tavern/domain").AssemblePromptResponse {
  return {
    layers: [],
    tokenAccounting: { total: 0 },
    activatedLoreEntries: [],
    scriptInjections: [],
    retrievedMemories: [],
    finalPayload: {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
  };
}

/** Append the live character card and, for a refinement, its current base. */
function withGrounding(systemPrompt: string, input: TrackerDelegateInput): string {
  const profile = input.characterProfileMd.trim();
  const grounding = [
    "--- Grounding (co-author delegation) ---",
    profile ? `Character card being authored:\n${profile}` : "(no character profile available)",
    ...(input.action === "refine" && input.currentTemplate
      ? ["Refine base (current tracker template):", "```json", JSON.stringify(input.currentTemplate, null, 2), "```"]
      : []),
  ].join("\n");
  return `${systemPrompt}\n\n${grounding}`;
}

/** Render the tool's compact intent into the delegate's one-shot user turn. */
function buildUserMessage(input: TrackerDelegateInput): string {
  const lines = [
    "Generate a complete tracker template for this character.",
    `Action: ${input.action}.`,
  ];
  if (input.modeHint) lines.push(`Mode hint: ${input.modeHint}.`);
  if (input.focusNotes?.trim()) lines.push(`Focus notes: ${input.focusNotes.trim()}`);
  lines.push("Return exactly one JSON object and no prose or markdown fences.");
  return lines.join("\n");
}

function parseTrackerTemplate(text: string): TrackerTemplate {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch (error) {
    const detail = error instanceof Error ? ` ${error.message}` : "";
    throw new Error(`Tracker template delegate returned malformed JSON.${detail}`);
  }
  const result = trackerTemplateSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
      .join("; ");
    throw new Error(`Tracker template delegate failed validation: ${detail}`);
  }
  const normalized = normalizeTrackerTemplate(result.data);
  if (!normalized) {
    throw new Error("Tracker template delegate failed validation: the template has no scene or objective section.");
  }
  return normalized;
}

function buildRepairMessage(userMessage: string, error: Error): string {
  return [
    userMessage,
    "",
    `Your previous response was rejected: ${error.message}`,
    "Return the complete corrected tracker template as exactly one JSON object and no prose or markdown fences.",
  ].join("\n");
}

/**
 * Construct a TrackerDelegate bound to a resolved provider profile + model.
 * It resolves the overridable tracker-template teaching asset, then gives one
 * bounded repair attempt when JSON parsing or union-schema validation fails.
 */
export function createTrackerDelegate(deps: CreateTrackerDelegateDeps): TrackerDelegate {
  const { execute, profile, model, db } = deps;
  return async (input, signal): Promise<TrackerDelegateResult> => {
    const { prompt: asset } = await resolveSystemPrompt(db, "lore_entry", { field: "tracker_template" });
    const systemPrompt = withGrounding(asset, input);
    const userMessage = buildUserMessage(input);
    const first = await execute({ profile, model, prompt: buildOneShotPrompt(systemPrompt, userMessage), signal });
    try {
      return { trackerTemplate: parseTrackerTemplate(first.text) };
    } catch (error) {
      const reason = error instanceof Error ? error : new Error(String(error));
      const repaired = await execute({
        profile,
        model,
        prompt: buildOneShotPrompt(systemPrompt, buildRepairMessage(userMessage, reason)),
        signal,
      });
      return { trackerTemplate: parseTrackerTemplate(repaired.text) };
    }
  };
}
