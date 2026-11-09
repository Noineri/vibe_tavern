/**
 * Typed fixture builders for the experience-copilot cluster (Wave B step 6 —
 * TYPE_SAFETY_CAST_DEBT_REPORT, the `makeActiveChat` pattern generalised).
 *
 * Every copilot-suite fixture used to reach its consumer through an `as
 * unknown as …` erasure (the DK-9 class: a partial literal silently cast to a
 * full type, hiding missing required fields). These builders are the honest
 * replacements: each takes the narrow fixture subset the cluster's tests
 * actually exercise, returns the consumer's REAL type (via
 * `strictTestDouble` — unprovided members throw on access), and fills inert
 * defaults ONLY where no test reads the field (or where today's erased
 * literal read `undefined` there deliberately).
 *
 * Builders are infrastructure: they land with this batch's consumers and
 * later step-6 batches may import and extend them.
 */
import type { ToolSet } from "ai";
import { z } from "zod";
import type {
	AppDb,
	ChatAgentSettingsStore,
	ChatStore,
	Character,
	ExperienceCopilotStore,
	Persona,
	ScriptRow,
	StoreContainer,
} from "@vibe-tavern/db";
import {
	type StoredProviderProfileRecord,
	PROVIDER_PROFILE_GENERATION_DEFAULTS,
	COAUTHOR_TRANSPORT,
	GENERATION_MODE,
	type ScriptKind,
} from "@vibe-tavern/domain";
import {
	BUILTIN_PROFILE_ID,
	type AgentKind,
	type AgentBuiltinProfileSeed,
} from "../src/domain/agent/agent-kind.js";
import type { ProviderProfileService } from "../src/domain/providers/provider-profile-service.js";
import type { ExperienceCopilotRuntimeApi } from "../src/api/contract/runtime-api.js";
import { strictTestDouble, type PartialMembers } from "./strict-test-double.js";

// ─── Store container (ExperienceCopilotAdapter's DI seam) ────────────────────

/**
 * The StoreContainer double the copilot suite feeds `new
 * ExperienceCopilotAdapter(...)`. The adapter's constructor reads
 * `chatAgentSettings` and `chats` eagerly — but only to HOLD the references
 * in closures the exercised paths never call (today the erased literals read
 * `undefined` there). This builder supplies inert no-op doubles for exactly
 * those two so construction succeeds without giving any test a capability it
 * did not already have; everything else throws on access unless the fixture
 * provides it.
 *
 * `db` is special: the fixtures carried NO db DELIBERATELY — the stream's
 * builtin-profile resolution branches on its presence (`db ? service-prompt
 * override : bundled asset`) and these pins exercise the no-db asset path,
 * while the constructor's own `stores.db` reads are references into closures
 * these paths never call. The typed container cannot express "no db"
 * (production always has one), so the builder carries the absence as `null` —
 * falsy for the branch, and a loud null-dereference if any exercised path
 * ever starts dereferencing it — instead of a truthy double that would
 * silently flip the profile resolution onto the service-prompt tier.
 */
export function makeCopilotStores(
	provided: PartialMembers<StoreContainer> & { db?: AppDb | null },
): StoreContainer {
	return strictTestDouble<StoreContainer>(
		{
			...provided,
			chatAgentSettings:
				provided.chatAgentSettings ??
				strictTestDouble<ChatAgentSettingsStore>({}, "copilot stores.chatAgentSettings (construction ref)"),
			chats:
				provided.chats ?? strictTestDouble<ChatStore>({}, "copilot stores.chats (construction ref)"),
			db: (provided.db ?? null) as AppDb,
		},
		"ExperienceCopilotAdapter stores",
	);
}

/** A partial `ExperienceCopilotStore` double with the full store's type —
 *  the thread/message fakes across the copilot suites (getById, listMessages,
 *  appendMessage, startNewSession, updateContextMetrics, get/setAutoCompact,
 *  updateTodo). */
export function makeExperienceCopilotStore(
	provided: PartialMembers<ExperienceCopilotStore> = {},
	label = "ExperienceCopilotStore",
): ExperienceCopilotStore {
	return strictTestDouble<ExperienceCopilotStore>(provided, label);
}

// ─── Script row ──────────────────────────────────────────────────────────────

/**
 * The stored script row fixture (every field filled — the erasure-cast
 * version relied on the literal already being complete and cast the
 * `scriptKind` string away). `scriptKind` takes the STORED column's real
 * domain (`string`), not the `ScriptKind` union: the bogus-kind pins exist
 * precisely to resolve a legacy/corrupted column value to nothing, and that
 * value is not expressible in the union. The single narrowing at the return
 * is the fixture seam for that unrepresentable case. The optional `over`
 * completes only the identity/display fields a suite reads (name, enabled,
 * scopeType, sortOrder, …) — everything else rides the inert defaults.
 */
export function makeScriptRow(scriptKind: string, id = "script_kr_1", over: Partial<ScriptRow> = {}): ScriptRow {
	return {
		id,
		name: "Kind resolution script",
		description: "",
		code: "",
		enabled: true,
		scriptKind: scriptKind as ScriptRow["scriptKind"],
		origin: "in_app",
		firstEnabledAt: null,
		creationIntentId: null,
		scopeType: "global",
		sortOrder: 0,
		characterId: null,
		personaId: null,
		chatId: null,
		defaultVisualId: null,
		copilotProfileId: null,
		extensions: {},
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

// ─── Owner rows (context cards) ──────────────────────────────────────────────

/** A complete stored character row; only the identity fields carry fixture
 *  data (the context-card paths read `name`/`id`; the full card body arrives
 *  through `getProfileMdText`). The rest is inert — nothing reads it. */
export function makeCharacterRow(
	id: string,
	over: Partial<Character> = {},
): Character {
	return {
		id,
		slug: id,
		name: "Fixture character",
		description: "",
		personalitySummary: null,
		defaultScenario: null,
		firstMessage: null,
		mesExample: null,
		mesExampleMode: "always",
		mesExampleDepth: 4,
		alternateGreetings: [],
		postHistoryInstructions: null,
		creatorNotes: null,
		characterBook: null,
		depthPrompt: null,
		depthPromptDepth: null,
		depthPromptRole: null,
		extensions: {},
		systemPrompt: null,
		tags: [],
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		avatarSourceAssetId: null,
		includeGalleryInPrompt: false,
		includeAvatarInPrompt: false,
		avatarDescription: null,
		status: "active",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

/** A complete stored persona row; only the identity fields carry fixture
 *  data (the context-card paths read `name`/`description`); the rest is
 *  inert. */
export function makePersonaRow(
	id: string,
	over: Partial<Persona> = {},
): Persona {
	return {
		id,
		name: "Fixture persona",
		description: "",
		pronouns: null,
		pronounForms: null,
		avatarAssetId: null,
		avatarFullAssetId: null,
		avatarCropJson: null,
		avatarExt: null,
		avatarFullExt: null,
		includeAvatarInPrompt: false,
		avatarDescription: null,
		defaultForNewChats: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

// ─── Agent kind ──────────────────────────────────────────────────────────────

/**
 * A registered test {@link AgentKind}. Required: the id and the script kinds
 * it serves; everything else gets inert defaults matching a minimal
 * script-owned kind (the shape the registry enforces: first builtin seed id
 * `"builtin"`). The serve-list accepts out-of-band script-kind values — the
 * unserved-kind pins need a value NO registered kind serves, and AS-7 made
 * every union member served, so that value is by construction outside the
 * union; the builder brands it at this one documented seam.
 */
export function makeAgentKind(
	id: string,
	over: Omit<Partial<AgentKind>, "servesScriptKinds"> & {
		servesScriptKinds?: readonly (ScriptKind | (string & {}))[];
	} = {},
): AgentKind {
	return {
		id,
		owner: over.owner ?? "script",
		inheritsLegacyCopilotPair: over.inheritsLegacyCopilotPair ?? false,
		servesScriptKinds: (over.servesScriptKinds ?? []) as readonly ScriptKind[],
		servesChatModes: over.servesChatModes ?? [],
		basePromptServiceKey: over.basePromptServiceKey ?? `${id}_base`,
		skillRootId: over.skillRootId ?? id,
		builtinSeeds: over.builtinSeeds ?? [{ id: BUILTIN_PROFILE_ID, name: id }],
		toolSetSchema: over.toolSetSchema ?? z.object({}).strict(),
		defaultToolSet: over.defaultToolSet ?? {},
		recencyAnchorText: over.recencyAnchorText ?? "",
		renderContextPackage:
			over.renderContextPackage ??
			(() => {
				throw new Error(`makeAgentKind(${id}): renderContextPackage is not wired in this fixture`);
			}),
	};
}

// ─── Provider profile row / service ──────────────────────────────────────────

/**
 * A complete stored provider profile row. The sampler fields come from the
 * domain's ONE defaults source (`PROVIDER_PROFILE_GENERATION_DEFAULTS` — the
 * same spread the provider store applies), the identity/connection fields
 * from inert no-op values; overrides win. Replaces the partial profile
 * literals the erasure casts let past the compiler.
 */
export function makeProviderProfileRow(
	over: Partial<StoredProviderProfileRecord> = {},
): StoredProviderProfileRecord {
	return {
		id: "prov_1",
		name: "Test profile",
		providerPreset: "openai",
		coauthorTransport: COAUTHOR_TRANSPORT.chatCompletions,
		generationMode: GENERATION_MODE.chat,
		endpoint: "http://localhost",
		apiKey: null,
		defaultModel: null,
		tokenPadding: 0,
		bindPerModel: false,
		modelFreeOnly: false,
		modelGroupByOwner: false,
		...PROVIDER_PROFILE_GENERATION_DEFAULTS,
		proxyMode: "inherit",
		proxyId: null,
		isActive: true,
		visionModel: null,
		generationFormat: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...over,
	};
}

/**
 * The `ProviderProfileService` double the compaction suites inject. Today's
 * fixture provides `getProviderProfile` (+ the overlay lookup returning
 * null); everything else throws on access. The profile literal is built
 * through {@link makeProviderProfileRow} so the returned row is a complete
 * stored record, not a cast-down fragment.
 */
export function makeProviderProfilesFixture(
	over: PartialMembers<ProviderProfileService> = {},
	label = "ProviderProfileService (compaction)",
): ProviderProfileService {
	return strictTestDouble<ProviderProfileService>(
		{
			getProviderProfile: async () =>
				makeProviderProfileRow({
					id: "prov_1",
					name: "Test",
					endpoint: "http://localhost",
					apiKey: "sk-test",
					defaultModel: "model_1",
				}),
			getProviderModelSettings: async () => null,
			...over,
		},
		label,
	);
}

// ─── Copilot routes runtime ──────────────────────────────────────────────────

/** A strict double for the copilot route layer's runtime contract — each
 *  route-level test provides exactly the members its endpoints touch. */
export function makeCopilotRuntime(
	provided: PartialMembers<ExperienceCopilotRuntimeApi>,
): ExperienceCopilotRuntimeApi {
	return strictTestDouble<ExperienceCopilotRuntimeApi>(provided, "ExperienceCopilotRuntimeApi");
}

// ─── Tool-schema probe (experience-copilot-tools.test.ts) ────────────────────

/**
 * The copilot toolset's zod input schemas, derived from the builder's REAL
 * return type: `buildExperienceCopilotTools()` returns `ToolSet`, whose
 * `inputSchema` is `FlexibleSchema` — a union in which only the zod member
 * carries `safeParse`/`shape`. Every copilot tool is declared with
 * `inputSchema: z.object(...)`, so the probe narrows honestly through an
 * `instanceof z.ZodObject` check (a non-zod schema is a build regression the
 * probe REPORTS, not silently probes). A renamed/removed tool is a compile
 * error here — the probe guards the shape instead of lying about it.
 *
 * The name union is the compile-time twin of the tools suite's runtime shape
 * pin (the `Object.keys(tools).sort()` assertion) — change both together.
 *
 * forks: 1 — `coauthorToolInputSchema` (provider-boundary-test-builders.ts),
 * the same narrowing pointed at the co-author toolset.
 */
export type CopilotToolName =
	| "write_buffer"
	| "edit_buffer"
	| "run_test"
	| "run_simulate"
	| "suggest_visual_binding"
	| "plan"
	| "read_plan"
	| "todo"
	| "ask_user"
	| "read_skill_file";

export function copilotToolInputSchema<const NAME extends CopilotToolName>(
	tools: ToolSet,
	name: NAME,
): z.ZodObject {
	const schema = tools[name].inputSchema;
	if (!(schema instanceof z.ZodObject)) {
		throw new Error(
			`copilotToolInputSchema(${name}): inputSchema is not a zod object schema — the probe contract is broken`,
		);
	}
	return schema;
}
