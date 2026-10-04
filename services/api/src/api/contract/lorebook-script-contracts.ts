/**
 * Lorebook + Script runtime-API contracts, extracted from `runtime-api.ts`
 * (which sits on its arch-gate line baseline and could not grow when the
 * «Текущие» participating queries were added — LOREBOOK_LIST_FILTERS_REPORT
 * step 2). The interfaces are moved verbatim; `runtime-api.ts` re-exports
 * them so every existing import path keeps resolving. The canonical contract
 * file for the routing↔adapter boundary remains `runtime-api.ts`'s header
 * comment — this file holds exactly the two content-entity contracts.
 */
import type {
	LorebookLink,
	ScriptLink,
	ExperienceVisualRow,
	LorebookRow,
	LoreEntryRow,
	ScriptRow,
} from "@vibe-tavern/db";
import type { ScriptKind } from "@vibe-tavern/domain";
import type { LorebookExportResult } from "@vibe-tavern/api-contracts";
import type { LorebookImportResult } from "../../domain/lorebook/lorebook-import-service.js";
import type { ScriptTestResult } from "../../domain/scripts-engine/script-test-service.js";

/** DB row shape returned by the lorebook store (same alias as runtime-api.ts). */
type Lorebook = LorebookRow;
type LoreEntry = LoreEntryRow;
type Script = ScriptRow;

// ─── Lorebook ────────────────────────────────────────────────────────

export interface LorebookRuntimeApi {
	listAllLorebooks: () => Promise<Lorebook[]>;
	listLorebooks: (scopeType: string, ownerId?: string) => Promise<Lorebook[]>;
	/** «Текущие» (LOREBOOK_LIST_FILTERS_REPORT step 2): lorebooks participating
	 * in a chat through the pipeline's own binding rules — attached-list
	 * semantics (disabled character/persona/chat books included; disabled
	 * global-pool-only books excluded). Fails closed with NotFound for an
	 * unknown chat. */
	listParticipatingLorebooks: (chatId: string) => Promise<Lorebook[]>;
	createLorebook: (body: { name: string; description?: string; scopeType: string; links?: Array<{ targetType: string; targetId: string }>; chatId?: string; scanDepth?: number; tokenBudget?: number; tokenBudgetPercent?: number | null; recursiveScanning?: boolean }) => Promise<Lorebook>;
	updateLorebookMeta: (lorebookId: string, body: { name?: string; description?: string; scanDepth?: number; tokenBudget?: number; tokenBudgetPercent?: number | null; recursiveScanning?: boolean; enabled?: boolean; scopeType?: string }) => Promise<Lorebook>;
	deleteLorebook: (lorebookId: string) => Promise<void>;
	duplicateLorebook: (lorebookId: string, overrides?: { name?: string; scopeType?: string; characterId?: string | null; personaId?: string | null }) => Promise<{ lorebook: Lorebook; links: LorebookLink[] }>;
	exportLorebook: (lorebookId: string) => Promise<LorebookExportResult>;
	getLorebookLinks: (lorebookId: string) => Promise<LorebookLink[]>;
	setLorebookLinks: (lorebookId: string, links: Array<{ targetType: string; targetId: string }>) => Promise<LorebookLink[]>;
	importLorebook: (lorebookId: string | null, body: { format: string; data: unknown; mode: string; scopeType?: string; characterId?: string; personaId?: string; chatId?: string; fallbackName?: string; enabled?: boolean }) => Promise<LorebookImportResult>;

	// Entries
	createLoreEntry: (lorebookId: string, body: Record<string, unknown>) => Promise<LoreEntry>;
	updateLoreEntry: (lorebookId: string, entryId: string, body: Record<string, unknown>) => Promise<LoreEntry>;
	deleteLoreEntry: (lorebookId: string, entryId: string) => Promise<void>;
	listLoreEntries: (lorebookId: string) => Promise<LoreEntry[]>;
	reorderLoreEntries: (lorebookId: string, updates: Array<{ id: string; sortOrder: number; position?: string }>) => Promise<LoreEntry[]>;
	testLoreActivation: (lorebookId: string, body: { text: string }) => Promise<{ activatedIds: string[]; totalEntries: number }>;
}

// ─── Script ──────────────────────────────────────────────────────────

export interface ScriptRuntimeApi {
	listAllScripts: () => Promise<Script[]>;
	listScripts: (scopeType: string, ownerId?: string) => Promise<Script[]>;
	/** «Текущие» script counterpart (LOREBOOK_LIST_FILTERS_REPORT step 2):
	 * prompt- and dice-kind scripts participating in a chat through the script
	 * runtime's own binding rules — attached-list semantics, mirroring
	 * `LorebookRuntimeApi.listParticipatingLorebooks`. Fails closed with
	 * NotFound for an unknown chat. */
	listParticipatingScripts: (chatId: string) => Promise<Script[]>;
	getScript: (scriptId: string) => Promise<Script | null>;
	createScript: (body: { name: string; description?: string; code?: string; scriptKind?: ScriptKind; creationIntentId?: string; scopeType: string; links?: Array<{ targetType: string; targetId: string }>; chatId?: string; enabled?: boolean; sortOrder?: number }) => Promise<Script>;
	updateScript: (scriptId: string, body: { name?: string; description?: string; code?: string; enabled?: boolean; sortOrder?: number; defaultVisualId?: string | null; copilotProfileId?: string | null }) => Promise<Script>;
	setScriptScope: (scriptId: string, scopeType: 'global' | 'entity' | 'chat', ownerId: string | null) => Promise<Script>;
	deleteScript: (scriptId: string) => Promise<void>;
	testScript: (scriptId: string, body: { code?: string; messages?: Array<{ role: string; content: string }>; characterName?: string; characterPersonality?: string; characterScenario?: string; lastMessage?: string }) => Promise<ScriptTestResult>;
	importScript: (body: { format: "js" | "json"; code?: string; jsonText?: string; name?: string; scriptKind?: ScriptKind; scopeType?: string; chatId?: string }) => Promise<Script>;
	getScriptLinks: (scriptId: string) => Promise<ScriptLink[]>;
	setScriptLinks: (scriptId: string, links: Array<{ targetType: string; targetId: string }>) => Promise<ScriptLink[]>;
	/** List the visuals bound to a script (its equal-peer "skin" set; BE-5 junction). */
	getScriptVisuals: (scriptId: string) => Promise<ExperienceVisualRow[]>;
	/** Bind a visual to a script (idempotent; first bound visual auto-becomes the silent default). */
	bindScriptVisual: (scriptId: string, visualId: string) => Promise<void>;
	/** Unbind a visual (reassigns the silent default if it was the one removed). */
	unbindScriptVisual: (scriptId: string, visualId: string) => Promise<void>;
}
