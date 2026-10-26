/**
 * AgentChatHeader — gear-button accessibility copy (AP-27 follow-up).
 *
 * Characterization: the gear opens the assistant-settings summary, so its
 * accessible name + tooltip must read that surface's title key.
 */
import { afterEach, beforeAll, describe, expect, it, mock } from "bun:test";
import { useDomEnv } from "../../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv();
const { render } = await import("@testing-library/react");

// SAFE module mock (capture real first, spread `...real`): identity `t` so
// the test pins WHICH key the gear reads, not the translated wording.
installI18nContextSeam();

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
