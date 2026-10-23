/**
 * AgentChatHeader — gear-button accessibility copy (AP-27 follow-up).
 *
 * Characterization: the gear opens the assistant-settings summary, so its
 * accessible name + tooltip must read that surface's title key.
 */
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";

useDomEnv();
const { render } = await import("@testing-library/react");

// SAFE module mock (capture real first, spread `...real`): identity `t` so
// the test pins WHICH key the gear reads, not the translated wording.
const realI18nContext = await import("../../../i18n/context.js");
mock.module("../../../i18n/context.js", () => ({
	...realI18nContext,
	useT: () => ({
		t: (key: string) => key,
		tDynamic: (key: string) => key,
		locale: "en",
		setLocale: () => {},
		ready: true,
	}),
}));

let AgentChatHeader: typeof import("./AgentChatHeader.js").AgentChatHeader;
beforeAll(async () => {
	({ AgentChatHeader } = await import("./AgentChatHeader.js"));
});

afterEach(() => {
	mock.restore();
});

function renderHeader() {
	return render(
		<AgentChatHeader
			sessions={[]}
			activeThreadId="t1"
			disabled={false}
			onActivate={mock()}
			onNew={mock()}
			onRename={mock()}
			onOpenSettings={mock()}
		/>,
	);
}

describe("AgentChatHeader — settings gear", () => {
	it("names the assistant-settings surface (not the old profiles window)", () => {
		const { getByTestId } = renderHeader();
		const gear = getByTestId("copilot-profile-gear-btn");
		expect(gear.getAttribute("aria-label")).toBe("agent_settings_title");
		expect(gear.getAttribute("title")).toBe("agent_settings_title");
	});
});
