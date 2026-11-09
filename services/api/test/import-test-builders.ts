/**
 * Typed fixture builders for the session-runtime import/export cluster (Wave B
 * step 6e — TYPE_SAFETY_CAST_DEBT_REPORT).
 *
 * Every import suite (import-batch / import-lean / import-vtf-monolith /
 * import-dropped-macro-warning / import-chat-swipe-selection) used to hand
 * `importJson`/`importJsonBatch` a partial `ImportExportModuleDeps` literal
 * through `as unknown as ImportExportModuleDeps` — the DK-9 erasure class: the
 * cast hid which members exist, which nested store methods the import path
 * really calls, and the incomplete row shapes the mocks returned (e.g. the
 * `create` stubs returned `{ id }` fragments against a full `Character` row).
 *
 * {@link makeImportExportDeps} takes the narrow fixture subset a suite
 * exercises, wires it through `strictTestDouble` at every nesting level (each
 * provided member is checked against the REAL store/service member type; every
 * unprovided member throws a labeled miss instead of reading `undefined`), and
 * completes the row returns through the standing row builders. The defaults
 * mirror the OLD stubs' explicit values (getById → null, folder resolve → the
 * id itself, createChat → `chat_${characterId}`, a complete snapshot for
 * `getSnapshot`) so the lean-path pins keep their exact behavior; the
 * per-suite call-counting mocks stay in the suite files, passed in through the
 * fixture.
 *
 * Builders are infrastructure: they land with this batch's consumers and
 * later step-6 batches may import and extend them.
 */
import type {
	CharacterStore,
	ChatStore,
	ContentStore,
	FileStore,
	LorebookStore,
	MessageStore,
	StoreContainer,
} from "@vibe-tavern/db";
import type { ChatId, PersonaId, PromptPresetId } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";
import type { SessionSnapshot } from "../src/api/contract/session-types.js";
import type { ImportExportResolver, ImportExportModuleDeps } from "../src/runtime/session/session-runtime-import-export.js";
import type { ChatApplicationService } from "../src/domain/chat/chat-application-service.js";
import type { IChatOrder } from "../src/runtime/session/session-runtime-chat-order.js";
import { makeCharacterRow } from "./copilot-test-builders.js";
import { makeLorebookRow, makeSessionSnapshot } from "./insights-test-builders.js";
import { strictTestDouble } from "./strict-test-double.js";

export interface ImportExportDepsFixture {
	/** `stores.characters` members the suite exercises (bun `mock`s for any
	 *  member a call-count assertion reads). */
	characters?: Partial<
		Pick<CharacterStore, "getById" | "create" | "update" | "resolveFolderName" | "listAll">
	>;
	/** `stores.lorebooks` members (the embedded-book path). */
	lorebooks?: Partial<
		Pick<LorebookStore, "createLorebook" | "bulkCreateEntries" | "addLink" | "getLorebook" | "deleteAllEntries">
	>;
	/** `stores.content` members (the card/original writes). */
	content?: Partial<Pick<ContentStore, "writeEntity">>;
	/** `stores.chats` members — usually a REAL `ChatStore` instance (the
	 *  round-trip suites); a partial satisfies the type the same way. */
	chats?: Partial<ChatStore>;
	/** `stores.messages` — the real `MessageStore` on the round-trip suites. */
	messages?: Partial<MessageStore>;
	/** `resolver` members — export-only; unprovided members throw a labeled
	 *  miss (the old stubs' explicit throwers, kept as the seam's invariant). */
	resolver?: Partial<ImportExportResolver>;
	/** `fileStore` members — export-only; unprovided members throw labeled. */
	fileStore?: Partial<Pick<FileStore, "resolvePath">>;
	/** `chatApp.createChat` (the target chat the import lands in). */
	chatApp?: Partial<Pick<ChatApplicationService, "createChat">>;
	/** `chatOrder.add`. */
	chatOrder?: Partial<Pick<IChatOrder, "add">>;
	/** The branded-id default resolvers (overridable for a counting mock). */
	resolveDefaultPersonaId?: () => Promise<PersonaId>;
	resolveDefaultPromptPresetId?: () => Promise<PromptPresetId>;
	/** The snapshot seam — the LEAN flag's whole contract. Provide the suite's
	 *  counting mock here; the default never records. */
	getSnapshot?: (chatId: ChatId) => Promise<SessionSnapshot>;
	/** The seeded opening (first message + greeting alternates). */
	seedImportedOpening?: ImportExportModuleDeps["seedImportedOpening"];
}

export function makeImportExportDeps(
	fixture: ImportExportDepsFixture = {},
	label = "ImportExportModuleDeps",
): ImportExportModuleDeps {
	const sliceLabel = (slice: string) => `${label}: ${slice}`;
	return strictTestDouble<ImportExportModuleDeps>(
		{
			stores: strictTestDouble<StoreContainer>(
				{
					characters: strictTestDouble<CharacterStore>(
						{
							getById: async () => null,
							create: async (data) => makeCharacterRow(`char_${data.name}`, { name: data.name }),
							update: async () => makeCharacterRow("char_fixture_1"),
							resolveFolderName: async (id) => id,
							listAll: async () => [],
							...(fixture.characters ?? {}),
						},
						sliceLabel("stores.characters"),
					),
					lorebooks: strictTestDouble<LorebookStore>(
						{
							createLorebook: async (data) => makeLorebookRow({ ...data }),
							bulkCreateEntries: async () => 1,
							addLink: async () => {},
							...(fixture.lorebooks ?? {}),
						},
						sliceLabel("stores.lorebooks"),
					),
					content: strictTestDouble<ContentStore>(
						{
							writeEntity: async () => "stub/path",
							...(fixture.content ?? {}),
						},
						sliceLabel("stores.content"),
					),
					...(fixture.chats ? { chats: strictTestDouble<ChatStore>(fixture.chats, sliceLabel("stores.chats")) } : {}),
					...(fixture.messages
						? { messages: strictTestDouble<MessageStore>(fixture.messages, sliceLabel("stores.messages")) }
						: {}),
				},
				sliceLabel("stores"),
			),
			chatApp: strictTestDouble<ChatApplicationService>(
				{
					createChat: async (input) => ({
						id: brandId<ChatId>(`chat_${input.characterId}`),
						activeBranchId: "br_fixture_1",
					}),
					...(fixture.chatApp ?? {}),
				},
				sliceLabel("chatApp"),
			),
			chatOrder: strictTestDouble<IChatOrder>(
				{ add: () => {}, ...(fixture.chatOrder ?? {}) },
				sliceLabel("chatOrder"),
			),
			resolveDefaultPersonaId: fixture.resolveDefaultPersonaId ?? (async () => brandId<PersonaId>("persona_default")),
			resolveDefaultPromptPresetId:
				fixture.resolveDefaultPromptPresetId ?? (async () => brandId<PromptPresetId>("preset_default")),
			getSnapshot: fixture.getSnapshot ?? (async () => makeSessionSnapshot()),
			seedImportedOpening: fixture.seedImportedOpening ?? (async () => {}),
			...(fixture.resolver ? { resolver: strictTestDouble<ImportExportResolver>(fixture.resolver, sliceLabel("resolver")) } : {}),
			...(fixture.fileStore ? { fileStore: strictTestDouble<FileStore>(fixture.fileStore, sliceLabel("fileStore")) } : {}),
		},
		label,
	);
}
