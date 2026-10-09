/**
 * Preset-import flow (REGEX_RULE_PROFILE_UX_PORTABILITY_PLAN, RXU-21).
 *
 * Owns the pure pieces of `PromptManagerModal`'s preset import: the
 * `PresetImportResult` contract (now carrying the embedded Regex rules),
 * the editor-draft payload builders for both import paths, and the
 * ONE-Profile-per-import Regex sequence with compensation.
 *
 * Extracted from PromptManagerModal.tsx (the RXU-14 pattern — the changed
 * part moves behind imports so the modal file stays under its arch-gate
 * baseline). The React glue (state, toasts, preset-tab selection) stays in
 * the modal; everything here is injectable and unit-testable without DOM.
 */

import type {
  CustomInjection,
  GenerationFormat,
  PromptOrderEntry,
  PromptPresetDto,
} from "@vibe-tavern/domain";
import type { RegexScriptImportDraft, VibeTavernPresetExtension } from "@vibe-tavern/import-export";
import type {
  CreateRegexProfileBundleBody,
  RegexProfileBundleRecord,
} from "../../api/regex-api.js";

// ─── Import result contract ─────────────────────────────────────────────────

/** What `PresetImportModal` hands its consumer on confirm. */
export interface PresetImportResult {
  system: string[];
  post: string[];
  authors: string[];
  authorsRole?: "system" | "user" | "assistant";
  nsfw: string[];
  enhanceDefinitions: string[];
  injections: CustomInjection[];
  promptOrder: PromptOrderEntry[];
  /** Present when the source file was exported by Vibe Tavern (carries the
   *  full DTO under `_vibe_tavern`). The consumer imports losslessly from it. */
  vibeTavern?: VibeTavernPresetExtension;
  target: "current" | "new";
  newPresetName?: string;
  /** RXU-21: embedded Regex rules carried through EVERY preset import
   *  (VT-native and ST files alike — both parse into the same drafts).
   *  Source-faithful: each draft's `disabled` mirrors the source file. */
  regexScripts: RegexScriptImportDraft[];
  /** The previewed «Enable Profile after import» toggle state (default off in
   *  the modal; carried so the consumer never re-derives it). */
  enableRegexProfile: boolean;
  /** Profile name shown in the preview card — derived from the preset name. */
  regexProfileName: string;
}

// ─── Editor draft shape + import-path builders ─────────────────────────────

/** The preset editor's editable form state (moved here with the builders that
 *  construct it from import results; re-exported by PromptManagerModal for
 *  existing importers). */
export type DraftData = {
  name: string;
  system: string;
  jailbreak: string;
  prefill: string;
  authorsNote: string;
  authorsNoteDepth: number;
  authorsNotePosition: "in_prompt" | "in_chat" | "after_chat";
  authorsNoteRole: "system" | "user" | "assistant";
  summary: string;
  tools: string;
  nsfw: string;
  enhanceDefinitions: string;
  scriptAiSystemPrompt: string;
  aiAssistantPrompts: Record<string, string>;
  customInjections: CustomInjection[];
  promptOrder: PromptOrderEntry[];
  advancedMode: boolean;
  mergeConsecutiveRoles: boolean;
  /** Per-send prefill entry point (LS-8): gates the chat input's one-shot prefill UI. */
  perSendPrefillEnabled: boolean;
  /** Generation format (LS-3a). Null = never configured (= auto). */
  generationFormat: GenerationFormat | null;
};

/** Build the create-preset payload for an ST-projected import into a NEW
 *  preset (the non-VT "new" target path). */
export function buildStPresetCreatePayload(
  result: PresetImportResult,
  name: string,
): Partial<Omit<PromptPresetDto, "id" | "createdAt" | "updatedAt">> & { name: string } {
  return {
    name,
    system: result.system.join("\n\n"),
    jailbreak: result.post.join("\n\n"),
    authorsNote: result.authors.join("\n\n"),
    nsfw: result.nsfw.join("\n\n"),
    enhanceDefinitions: result.enhanceDefinitions.join("\n\n"),
    prefill: "",
    authorsNoteDepth: 4,
    authorsNotePosition: "in_chat",
    authorsNoteRole: result.authorsRole ?? "system",
    summary: "",
    tools: "",
    scriptAiSystemPrompt: "",
    customInjections: result.injections,
    promptOrder: result.promptOrder,
    advancedMode: true,
  };
}

/** Lossless VT path, target "current": replace the current preset's editable
 *  fields wholesale with the `_vibe_tavern` DTO (reviewed via the draft; the
 *  user clicks Save to commit). `aiAssistantPrompts` is a JSON string in the
 *  DTO but a parsed Record in the draft. */
export function vtImportDraft(ext: VibeTavernPresetExtension): DraftData {
  return {
    name: ext.name,
    system: ext.system,
    jailbreak: ext.jailbreak,
    prefill: ext.prefill,
    authorsNote: ext.authorsNote,
    authorsNoteDepth: ext.authorsNoteDepth,
    authorsNotePosition: ext.authorsNotePosition,
    authorsNoteRole: ext.authorsNoteRole,
    summary: ext.summary,
    tools: ext.tools,
    nsfw: ext.nsfw,
    enhanceDefinitions: ext.enhanceDefinitions,
    scriptAiSystemPrompt: ext.scriptAiSystemPrompt,
    aiAssistantPrompts: parseAiAssistantPrompts(ext.aiAssistantPrompts),
    customInjections: ext.customInjections,
    promptOrder: ext.promptOrder,
    advancedMode: ext.advancedMode,
    mergeConsecutiveRoles: ext.mergeConsecutiveRoles ?? false,
    perSendPrefillEnabled: ext.perSendPrefillEnabled ?? false,
    generationFormat: ext.generationFormat ?? null,
  };
}

/** ST path, target "current": merge the imported blocks into the current
 *  draft (append per field; canvas merged by identifier). */
export function mergeStImportIntoDraft(d: DraftData, result: PresetImportResult): DraftData {
  const next: DraftData = { ...d };
  if (result.system.length) next.system = d.system + (d.system ? "\n\n" : "") + result.system.join("\n\n");
  if (result.post.length) next.jailbreak = d.jailbreak + (d.jailbreak ? "\n\n" : "") + result.post.join("\n\n");
  if (result.authors.length) {
    next.authorsNote = d.authorsNote + (d.authorsNote ? "\n\n" : "") + result.authors.join("\n\n");
    next.authorsNoteRole = result.authorsRole ?? d.authorsNoteRole;
  }
  if (result.nsfw.length) next.nsfw = d.nsfw + (d.nsfw ? "\n\n" : "") + result.nsfw.join("\n\n");
  if (result.enhanceDefinitions.length) next.enhanceDefinitions = d.enhanceDefinitions + (d.enhanceDefinitions ? "\n\n" : "") + result.enhanceDefinitions.join("\n\n");
  if (result.injections.length) next.customInjections = [...d.customInjections, ...result.injections];
  if (result.promptOrder.length) next.promptOrder = mergePromptOrder(d.promptOrder, result.promptOrder);
  if (result.injections.length || result.promptOrder.length) next.advancedMode = true;
  return next;
}

function mergePromptOrder(current: PromptOrderEntry[], imported: PromptOrderEntry[]): PromptOrderEntry[] {
  const map = new Map(current.map((entry) => [entry.identifier, entry]));
  for (const entry of imported) {
    map.set(entry.identifier, { ...map.get(entry.identifier), ...entry });
  }
  return Array.from(map.values()).sort((a, b) => (a.order ?? 10_000) - (b.order ?? 10_000));
}

/** Parse the DTO's `aiAssistantPrompts` JSON string into the draft's Record
 *  shape (shared by the preset load path and the VT import path). */
export function parseAiAssistantPrompts(raw: string | undefined | null): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed).filter(([, v]) => typeof v === "string"),
      ) as Record<string, string>;
    }
  } catch { /* ignore — malformed JSON yields the empty map */ }
  return {};
}

// ─── RXU-21: one Regex Profile per import operation ─────────────────────────

/** The Regex part of one preset import: the source-faithful rules, the
 *  previewed master-switch choice, and the previewed profile name. `null`
 *  when the file embeds no rules (no card, zero regex API calls). */
export interface PresetRegexImportPlan {
  rules: RegexScriptImportDraft[];
  enableProfile: boolean;
  profileName: string;
}

/** Derive the plan from an import result. Single derivation of "does this
 *  import carry Regex" — the modal and every caller read this. */
export function presetRegexImportPlan(
  result: Pick<PresetImportResult, "regexScripts" | "enableRegexProfile" | "regexProfileName">,
): PresetRegexImportPlan | null {
  if (result.regexScripts.length === 0) return null;
  return {
    rules: result.regexScripts,
    enableProfile: result.enableRegexProfile,
    profileName: result.regexProfileName,
  };
}

/** Preview counts for the card's `N Rules · X enabled · Y disabled` line —
 *  the ONE derivation (the card renders it, tests pin it). Source states are
 *  already on the drafts (RXU-11); no policy lives here. */
export function summarizeRegexImportRules(
  rules: RegexScriptImportDraft[],
): { total: number; enabled: number; disabled: number } {
  let enabled = 0;
  for (const rule of rules) if (!rule.disabled) enabled += 1;
  return { total: rules.length, enabled, disabled: rules.length - enabled };
}

/** Map source-faithful drafts onto bundle rule bodies. Drops the import-only
 *  `sourceScript` channel and `profileId` (membership is bundle-owned — the
 *  store stamps the new profile's id on every inserted rule). */
function toPresetBundleRules(rules: RegexScriptImportDraft[]): CreateRegexProfileBundleBody["rules"] {
  return rules.map((rule) => ({
    name: rule.name,
    findRegex: rule.findRegex,
    replaceString: rule.replaceString,
    trimStrings: [...rule.trimStrings],
    substituteRegex: rule.substituteRegex,
    disabled: rule.disabled,
    markdownOnly: rule.markdownOnly,
    promptOnly: rule.promptOnly,
    runOnEdit: rule.runOnEdit,
    minDepth: rule.minDepth,
    maxDepth: rule.maxDepth,
    placement: [...rule.placement],
    isGlobal: rule.isGlobal,
    sortOrder: rule.sortOrder,
  }));
}

/** Create exactly ONE Profile holding every imported rule, linked to the
 *  prompt preset (RXU-21: the bundle is atomic server-side — profile, link,
 *  and all members land or nothing does). The `disabled` inversion: the
 *  preview toggle names the ON state; the profile master flag is its
 *  negation. Source rule states are passed through untouched. */
export async function createPresetRegexProfile(
  plan: PresetRegexImportPlan,
  presetId: string,
  createBundle: (body: CreateRegexProfileBundleBody) => Promise<RegexProfileBundleRecord>,
): Promise<RegexProfileBundleRecord> {
  return await createBundle({
    name: plan.profileName,
    disabled: !plan.enableProfile,
    links: [{ targetType: "preset", targetId: presetId }],
    rules: toPresetBundleRules(plan.rules),
  });
}

export type PresetCreateWithRegexOutcome =
  | { ok: true; presetId: string }
  | { ok: false; reason: "presetCreateFailed" | "regexBundleFailed" };

/** The target-"new" import sequence: create the prompt preset FIRST, then the
 *  linked Regex Profile bundle. COMPENSATION: if the bundle fails, the newly
 *  created preset is removed again — no orphaned preset-without-profile can
 *  remain, and the bundle transaction guarantees no partial Regex rows ever
 *  landed. Preset-create failures surface as `presetCreateFailed` (the preset
 *  controller owns that toast); bundle failures as `regexBundleFailed`. */
export async function createPresetWithRegexProfile(options: {
  createPreset: () => Promise<{ id: string } | null>;
  /** Compensation — removes the preset created above when the bundle fails. */
  deletePreset: (presetId: string) => Promise<unknown>;
  plan: PresetRegexImportPlan | null;
  createBundle: (body: CreateRegexProfileBundleBody) => Promise<RegexProfileBundleRecord>;
}): Promise<PresetCreateWithRegexOutcome> {
  const created = await options.createPreset();
  if (!created?.id) return { ok: false, reason: "presetCreateFailed" };
  if (options.plan) {
    try {
      await createPresetRegexProfile(options.plan, created.id, options.createBundle);
    } catch {
      try {
        await options.deletePreset(created.id);
      } catch {
        // The deletion failed too — the preset stays behind; the caller's
        // failure toast is the only channel left (nothing more can be done).
      }
      return { ok: false, reason: "regexBundleFailed" };
    }
  }
  return { ok: true, presetId: created.id };
}
