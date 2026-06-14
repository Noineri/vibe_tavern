import type { RuntimeApi } from "../contract/runtime-api.js";
import type { StoreContainer } from "@vibe-tavern/db";
import type { SessionRuntime } from "../../runtime/session/session-runtime.js";
import type { ProviderProfileService } from "../../domain/providers/provider-profile-service.js";
import type { LiveChatOrchestrator } from "../../domain/chat/live-chat-orchestrator.js";
import type { ChatSummaryService } from "../../domain/chat/chat-summary-service.js";
import type { PromptPresetService } from "../../domain/prompt/prompt-preset-service.js";
import type { AssetService } from "../../domain/asset/asset-service.js";
import type { MobileAccessService } from "../../domain/mobile-access/mobile-access-service.js";
import { BootstrapAdapter } from "./bootstrap-adapter.js";
import { ChatAdapter } from "./chat-adapter.js";
import { CharacterAdapter } from "./character-adapter.js";
import { PersonaAdapter } from "./persona-adapter.js";
import { LorebookAdapter } from "./lorebook-adapter.js";
import { ScriptAdapter } from "./script-adapter.js";
import { ProviderAdapter } from "./provider-adapter.js";
import { PresetAdapter } from "./preset-adapter.js";
import { ImportExportAdapter } from "./import-export-adapter.js";
import { AssetAdapter } from "./asset-adapter.js";
import { AiAssistantAdapter } from "./ai-assistant-adapter.js";
import { SettingsAdapter } from "./settings-adapter.js";
import { MobileAccessAdapter } from "./mobile-access-adapter.js";

/**
 * Thin composite that wires domain adapters into the RuntimeApi contract.
 * No business logic lives here — every method is owned by a sub-adapter.
 *
 * This is the composition root for the adapter layer: it instantiates the 13
 * domain adapters and exposes them as the flat `RuntimeApi` shape that routes
 * consume. Each adapter is independently testable and owns its own store/service
 * dependencies. To add a new domain, create an adapter and wire it here.
 */
export class RuntimeApiAdapter implements RuntimeApi {
	readonly bootstrap: RuntimeApi["bootstrap"];
	readonly chat: ChatAdapter;
	readonly character: CharacterAdapter;
	readonly persona: PersonaAdapter;
	readonly lorebook: LorebookAdapter;
	readonly script: ScriptAdapter;
	readonly provider: ProviderAdapter;
	readonly preset: PresetAdapter;
	readonly importExport: ImportExportAdapter;
	readonly asset: AssetAdapter;
	readonly aiAssistant: AiAssistantAdapter;
	readonly settings: SettingsAdapter;
	readonly mobileAccess: MobileAccessAdapter;

	constructor(
		stores: StoreContainer,
		providerProfileService: ProviderProfileService,
		liveChatOrchestrator: LiveChatOrchestrator,
		chatSummaryService: ChatSummaryService,
		sessionRuntime: SessionRuntime,
		promptPresetService: PromptPresetService,
		assetService: AssetService,
		mobileAccessService: MobileAccessService,
	) {
		const bootstrapAdapter = new BootstrapAdapter(sessionRuntime);
		this.bootstrap = bootstrapAdapter.bootstrap;
		this.chat = new ChatAdapter(
			stores, sessionRuntime, liveChatOrchestrator,
			chatSummaryService, providerProfileService, assetService,
		);
		this.character = new CharacterAdapter(sessionRuntime, stores, assetService);
		this.persona = new PersonaAdapter(sessionRuntime, stores, assetService);
		this.lorebook = new LorebookAdapter(stores);
		this.script = new ScriptAdapter(stores);
		this.provider = new ProviderAdapter(stores, providerProfileService);
		this.preset = new PresetAdapter(promptPresetService);
		this.importExport = new ImportExportAdapter(sessionRuntime);
		this.asset = new AssetAdapter(assetService);
		this.aiAssistant = new AiAssistantAdapter(stores);
		this.settings = new SettingsAdapter(stores);
		this.mobileAccess = new MobileAccessAdapter(mobileAccessService);
	}
}
