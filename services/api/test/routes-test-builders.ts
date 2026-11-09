/**
 * Typed builders for the route-level suites that stub the whole `RuntimeApi`
 * (Wave B step 6e — TYPE_SAFETY_CAST_DEBT_REPORT).
 *
 * `createApiRouter` decomposes EVERY runtime slice at construction (each
 * route factory stores its slice), so a suite that exercises one route used to
 * satisfy `createApp({ runtime })` with a partial literal erased through
 * `as unknown as RuntimeApi` — the cast hid both which slice was real and the
 * ~36 slices the router construction reads as `undefined`. This builder is the
 * ONE derivation: the suite provides the slice(s) under test (each member
 * checked against the real slice type), and every other slice becomes an inert
 * strict double that throws a labeled miss if a route on these paths ever
 * reaches it.
 *
 * forks: 2 — dice-send-http-error.test.ts / experience-send-http-error.test.ts
 * carry the same `uncalled`-slice lists as pre-6e local helpers (their batch's
 * precedent); adopt this builder on their next touch.
 */
import type { RuntimeApi } from "../src/api/contract/runtime-api.js";
import { strictTestDouble, type PartialMembers } from "./strict-test-double.js";

export function makeRuntimeApi(
	provided: PartialMembers<RuntimeApi>,
	label = "RuntimeApi (routes)",
): RuntimeApi {
	const uncalled = <K extends keyof RuntimeApi>(k: K) =>
		strictTestDouble<RuntimeApi[K]>({}, `${label}: ${String(k)} (uncalled seam)`);
	return strictTestDouble<RuntimeApi>(
		{
			userThemes: uncalled("userThemes"),
			chat: uncalled("chat"),
			system: uncalled("system"),
			diagnostics: uncalled("diagnostics"),
			bootstrap: uncalled("bootstrap"),
			servicePrompts: uncalled("servicePrompts"),
			imagePromptProfiles: uncalled("imagePromptProfiles"),
			character: uncalled("character"),
			persona: uncalled("persona"),
			lorebook: uncalled("lorebook"),
			script: uncalled("script"),
			regex: uncalled("regex"),
			tts: uncalled("tts"),
			stt: uncalled("stt"),
			imageGen: uncalled("imageGen"),
			provider: uncalled("provider"),
			proxy: uncalled("proxy"),
			preset: uncalled("preset"),
			importExport: uncalled("importExport"),
			asset: uncalled("asset"),
			coauthorSkills: uncalled("coauthorSkills"),
			copilotSkills: uncalled("copilotSkills"),
			aiAssistant: uncalled("aiAssistant"),
			settings: uncalled("settings"),
			mobileAccess: uncalled("mobileAccess"),
			insights: uncalled("insights"),
			dice: uncalled("dice"),
			experience: uncalled("experience"),
			experienceCopilot: uncalled("experienceCopilot"),
			agentThreadProposals: uncalled("agentThreadProposals"),
			agentFeed: uncalled("agentFeed"),
			copilotProfiles: uncalled("copilotProfiles"),
			agentPlan: uncalled("agentPlan"),
			storyDeck: uncalled("storyDeck"),
			samplerSets: uncalled("samplerSets"),
			formatTemplates: uncalled("formatTemplates"),
			aiInstructionTemplates: uncalled("aiInstructionTemplates"),
			...provided,
		},
		label,
	);
}
