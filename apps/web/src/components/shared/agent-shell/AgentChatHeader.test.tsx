/**
 * AgentChatHeader — gear-button accessibility copy (AP-27 follow-up) and the
 * DR-6 profile-chip slot.
 *
 * Characterization: the gear opens the assistant-settings summary, so its
 * accessible name + tooltip must read that surface's title key. DR-6: the
 * header is presentational chrome — the chip arrives as a slot (data and
 * the assignment writes live in the shell, through
 * `use-agent-profile-assignment.ts`), so the pin here is PLACEMENT: the
 * chip renders between the session switcher and the context ring; an
 * absent slot renders nothing (the default header stays byte-identical —
 * the pre-DR-6 render below carries no chip node at all).
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
		expect(gear.getAttribute("title")).toBeNull();
	});
});

describe("AgentChatHeader — DR-6 profile chip slot", () => {
	it("renders the slot between the session switcher and the context ring", () => {
		const { getByTestId } = render(
			<AgentChatHeader
				sessions={[]}
				activeThreadId="t1"
				disabled={false}
				onActivate={mock()}
				onNew={mock()}
				onRename={mock()}
				onOpenSettings={mock()}
				profileChip={<span data-testid="dr6-chip-stub">Director</span>}
				contextRing={<span data-testid="dr6-ring-stub">14%</span>}
			/>,
		);
		const trigger = getByTestId("copilot-session-switcher-trigger");
		const chip = getByTestId("dr6-chip-stub");
		const ring = getByTestId("dr6-ring-stub");
		// Document order (mockup §2): switcher → chip → ring → gear.
		expect(trigger.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(chip.compareDocumentPosition(ring) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
		expect(ring.compareDocumentPosition(getByTestId("copilot-profile-gear-btn")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	});
});
