import type { RegexPresetRecord, RegexLinkRecord } from "./types.js";
import type { RegexApplyTarget, RegexPlacement, RegexSubstituteMode } from "@vibe-tavern/domain";
import { client } from "./client.js";
import { unwrapRpc, unwrapError } from "./unwrap.js";

export async function listAllRegexPresets(): Promise<RegexPresetRecord[]> {
  const response = await client.api.regex.presets.all.$get();
  return unwrapRpc<RegexPresetRecord[]>(response);
}

export async function getRegexPreset(id: string): Promise<RegexPresetRecord | null> {
  const response = await client.api.regex.presets[":id"].$get({ param: { id } });
  if (response.status === 404) return null;
  return unwrapRpc<RegexPresetRecord>(response);
}

export interface CreateRegexPresetBody {
  name: string;
  findRegex: string;
  replaceString?: string;
  trimStrings?: string[];
  substituteRegex?: RegexSubstituteMode;
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  minDepth?: number | null;
  maxDepth?: number | null;
  placement?: RegexPlacement[];
  isGlobal?: boolean;
  sortOrder?: number;
}

export async function createRegexPreset(body: CreateRegexPresetBody): Promise<RegexPresetRecord> {
  const response = await client.api.regex.presets.$post({ json: body });
  return unwrapRpc<RegexPresetRecord>(response);
}

export interface UpdateRegexPresetBody {
  name?: string;
  findRegex?: string;
  replaceString?: string;
  trimStrings?: string[];
  substituteRegex?: RegexSubstituteMode;
  disabled?: boolean;
  markdownOnly?: boolean;
  promptOnly?: boolean;
  runOnEdit?: boolean;
  minDepth?: number | null;
  maxDepth?: number | null;
  placement?: RegexPlacement[];
  isGlobal?: boolean;
  sortOrder?: number;
  /** Write-mode selector — expanded server-side into markdownOnly/promptOnly. */
  applyTarget?: RegexApplyTarget;
}

export async function updateRegexPreset(id: string, body: UpdateRegexPresetBody): Promise<RegexPresetRecord> {
  const response = await client.api.regex.presets[":id"].$patch({ param: { id }, json: body });
  return unwrapRpc<RegexPresetRecord>(response);
}

export async function deleteRegexPreset(id: string): Promise<void> {
  const response = await client.api.regex.presets[":id"].$delete({ param: { id } });
  if (!response.ok) throw await unwrapError(response);
}

export async function getRegexLinks(id: string): Promise<RegexLinkRecord[]> {
  const response = await client.api.regex.presets[":id"].links.$get({ param: { id } });
  return unwrapRpc<RegexLinkRecord[]>(response);
}

export async function setRegexLinks(id: string, links: Array<{ targetType: "character" | "preset"; targetId: string }>): Promise<RegexLinkRecord[]> {
  const response = await client.api.regex.presets[":id"].links.$put({ param: { id }, json: { links } });
  return unwrapRpc<RegexLinkRecord[]>(response);
}

export async function resolveActiveRegexPresets(query: { characterId?: string; presetId?: string }): Promise<RegexPresetRecord[]> {
  const response = await client.api.regex["resolve-active"].$get({ query });
  return unwrapRpc<RegexPresetRecord[]>(response);
}
