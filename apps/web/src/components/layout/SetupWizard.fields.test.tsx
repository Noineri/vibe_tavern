/**
 * Characterization test for the SetupWizard's field surfaces (FS-7 scope:
 * PersonaStep + CharacterStep). Pins the BEHAVIOR boundary, not chrome:
 * every step's fields render with their labels, controlled typing works,
 * the custom-pronouns input appears on demand. Element types stay stable
 * across the FS-7 primitive migration (TextInput renders input[type=text],
 * AutoTextarea renders textarea) — this file is the witness that the
 * migration changed styling only, never wiring.
 */
import { beforeEach, expect, mock, test } from "bun:test";
import { createElement } from "react";
import { fireEvent, render } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";
import { useBootstrapStore } from "../../stores/api-actions/bootstrap-actions.js";

useDomEnv();

// TopBar.test.tsx safe pattern: capture real exports first, spread, override.
const realI18nContext = await import("../../i18n/context.js");
const realMobileHook = await import("../../hooks/use-mobile.js");
const realProviderProfiles = await import("../../hooks/use-provider-profiles.js");

mock.module("../../i18n/context.js", () => ({ ...realI18nContext, useT: () => ({ t: (key: string) => key }) }));
mock.module("../../hooks/use-mobile.js", () => ({ ...realMobileHook, useIsMobile: () => false }));
mock.module("../../hooks/use-provider-profiles.js", () => ({
	...realProviderProfiles,
	useProviderProfiles: () => ({
		providerProfiles: [],
		handleFetchModelsForProfile: mock(),
		handleFetchModelsByEndpoint: mock(),
		handleTestProfileConnection: mock(),
		handleTestDraftConnection: mock(),
		handleTestChat: mock(),
		handleSaveProviderProfileFromForm: mock(),
	}),
}));

const { SetupWizard } = await import("./SetupWizard.js");

function seedFirstRun() {
	useBootstrapStore.setState({
		data: {
			initialChatId: null,
			snapshot: null,
			isFirstRun: true,
			allCharacters: [],
			promptPresets: [],
			personas: [],
			uiSettings: { githubStarred: true },
			isArmServer: false,
		} as never,
		personas: null,
		isLoading: false,
	});
}

/** Walk choose → Path A → (provider step) → PersonaStep. Returns the view. */
async function renderAtPersonaStep() {
	seedFirstRun();
	const view = render(createElement(SetupWizard, { onVisibilityChange: () => {} }));
	fireEvent.click(view.getByText("wizard_path_a_title"));
	// ProviderStep renders its own Skip (bottom-left) — take it to step 2.
	fireEvent.click(view.getByText("skip"));
	expect(view.getByText("ws_name_label")).toBeTruthy();
	return view;
}

beforeEach(() => {
	seedFirstRun();
});

test("persona step: fields render with labels and controlled typing works", async () => {
	const view = await renderAtPersonaStep();

	const nameInput = view.getByPlaceholderText("persona_name_placeholder") as HTMLInputElement;
	expect(nameInput.getAttribute("type")).toBe("text");
	fireEvent.change(nameInput, { target: { value: "Alice" } });
	expect(nameInput.value).toBe("Alice");

	const desc = view.getByPlaceholderText("persona_desc_placeholder") as HTMLTextAreaElement;
	fireEvent.change(desc, { target: { value: "loves long walks" } });
	expect(desc.value).toBe("loves long walks");

	// Custom pronouns: chip click reveals the free-text input, typing works.
	fireEvent.click(view.getByText("pronouns_custom"));
	const custom = view.getByPlaceholderText("pronouns_custom_placeholder") as HTMLInputElement;
	fireEvent.change(custom, { target: { value: "xe/xem" } });
	expect(custom.value).toBe("xe/xem");
});

test("character step: three fields render and typing works", async () => {
	const view = await renderAtPersonaStep();
	// PersonaStep Skip (bottom-left) advances to step 3.
	fireEvent.click(view.getByText("skip"));

	expect(view.getByText("ws_name_label")).toBeTruthy();
	expect(view.getByText("ws_desc_label")).toBeTruthy();
	expect(view.getByText("ws_first_msg_label")).toBeTruthy();

	const name = view.getByPlaceholderText("ws_name_placeholder") as HTMLInputElement;
	fireEvent.change(name, { target: { value: "Rin" } });
	expect(name.value).toBe("Rin");

	const fields = view.getAllByPlaceholderText("ws_desc_label").concat(view.getAllByPlaceholderText("ws_first_msg_label"));
	expect(fields.length).toBe(2);
	const firstMsg = view.getByPlaceholderText("ws_first_msg_label") as HTMLTextAreaElement;
	fireEvent.change(firstMsg, { target: { value: "Hello!" } });
	expect(firstMsg.value).toBe("Hello!");
});
