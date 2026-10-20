/** Settings + mobile-access runtime contracts (extracted from
 * `runtime-api.ts` for the size ratchet when SC-11 grew the composite —
 * same pattern as `skill-contracts.js` / `experience-copilot-contracts.ts`;
 * re-exported there so every existing import path keeps resolving). */

import type { UiSettings } from "@vibe-tavern/db";
import type { ScriptSafetySettings, UpdateScriptSafetySettings } from "@vibe-tavern/api-contracts";
import type { MobileAccessInfo } from "../../domain/mobile-access/mobile-access-service.js";

export interface SettingsRuntimeApi {
	getUiSettings: () => Promise<UiSettings>;
	updateUiSettings: (body: Record<string, unknown>) => Promise<UiSettings>;
	/** Script-safety singleton (SCRIPT_SAFETY_PLAN decision 3): one server-stored
	 *  "don't show again" flag for imported-script warnings, shared across all
	 *  devices. GET returns the defaults when no row exists yet. */
	getScriptSafetySettings: () => Promise<ScriptSafetySettings>;
	updateScriptSafetySettings: (body: UpdateScriptSafetySettings) => Promise<ScriptSafetySettings>;
}

export interface MobileAccessRuntimeApi {
	getMobileAccessInfo: () => Promise<MobileAccessInfo>;
	regenerateMobileAccessToken: () => Promise<{ token: string }>;
	revokeMobileAccess: () => Promise<{ token: null }>;
}
