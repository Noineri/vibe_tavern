/**
 * BuildMode — desktop panel-surface scroll wiring (CNR-8j).
 *
 * Pins the container conversion: the padded (non-full-bleed) desktop panel
 * surface scrolls on the shared thin ScrollArea lane, and the 32px/40px
 * padding rides the VIEWPORT (the real scroller) — the carrier
 * CharacterForm's sticky action bar depends on (its negative top must land
 * inside the scroll container's own padding region; see the glass-bar doc
 * comment in CharacterForm.tsx). Moving the padding onto the content element
 * would push the bar's sticky top outside the overflow clip rectangle and
 * clip the Save row — this pin breaks loudly on that regression.
 *
 * Rendered on the trace tab with no active trace/branch: the lightest
 * non-full-bleed surface (no CharacterForm / TracePayloadView mounts, and a
 * null branch disables the trace-history fetch entirely).
 */
import { afterAll, describe, expect, it, mock } from "bun:test";
import type { ChatId } from "@vibe-tavern/domain";
import { brandId } from "@vibe-tavern/domain";
import { wireChat, wireCharacter } from "../../../test/wire-fixtures.js";
import { useDomEnv } from "../../../test/dom-env.js";
import { installI18nContextSeam } from "../../../test/i18n-context-seam.js";

useDomEnv();

// Identity i18n — assertions match the i18n keys verbatim.
installI18nContextSeam();

// The controller is only a handler bag for BuildMode (save/export/delete
// callbacks fire from user actions); stub it so no controller store plumbing
// runs at render.
const realController = await import("../../hooks/use-character-controller.js");
const noop = () => {};
mock.module("../../hooks/use-character-controller.js", () => ({
	...realController,
	useCharacterController: () => ({
		handleSaveCharacter: noop,
		handleAvatarUpload: noop,
		handleExportCharacter: noop,
		handleExportPng: noop,
		handleExportVtf: noop,
		handleDuplicateCharacter: noop,
		handleCreateChat: noop,
		handleDeleteCharacter: noop,
	}),
}));

// Desktop viewport: the branch under test is the desktop one.
const realMobileHook = await import("../../hooks/use-mobile.js");
mock.module("../../hooks/use-mobile.js", () => ({
	...realMobileHook,
	useIsMobile: () => false,
}));

const { render } = await import("@testing-library/react");
const { useCharacterStore } = await import("../../stores/character-store.js");
const { useSnapshotStore } = await import("../../stores/snapshot-store.js");
const { useChatStore } = await import("../../stores/chat-store.js");
const { BuildMode } = await import("./BuildMode.js");

// Store state is seeded before render and restored after the suite (the
// snapshot/character/chat stores are process-global in the shared worker).
const characterBefore = useCharacterStore.getState();
const snapshotBefore = useSnapshotStore.getState();
const chatBefore = useChatStore.getState();

useCharacterStore.setState({ buildTab: "trace" });
useSnapshotStore.setState({
	character: wireCharacter(),
	// The component reads only activeChat.id off this row (BuildMode.tsx:52);
	// the complete wire chat row replaces the erased `{ id }` literal.
	activeChat: wireChat(),
});
useChatStore.setState({ activeChatId: brandId<ChatId>("chat-1"), selectedTraceId: null });

afterAll(() => {
	useCharacterStore.setState(characterBefore, true);
	useSnapshotStore.setState(snapshotBefore, true);
	useChatStore.setState(chatBefore, true);
});

describe("BuildMode desktop panel surface (CNR-8j)", () => {
	it("scrolls on the thin ScrollArea lane with the sticky-bar padding on the viewport", async () => {
		const { container, findByText } = render(<BuildMode />);
		await findByText("trace_no_active");

		const lane = container.querySelector<HTMLElement>("[data-scroll-area='thin']");
		if (!(lane instanceof HTMLElement)) throw new Error("thin ScrollArea missing on the desktop panel surface");
		expect(lane.className).toContain("flex-1");

		const viewport = lane.querySelector<HTMLElement>("[data-scroll-viewport]");
		if (!viewport) throw new Error("viewport missing on the panel-surface ScrollArea");
		// The 32/40 padding rides the REAL SCROLLER — CharacterForm's sticky
		// action bar pins via a negative top that must land inside the overflow
		// clip rectangle (the container's own padding region).
		expect(viewport.style.padding).toBe("32px 40px");
		// Vertical orientation clips X — the D4 glass-bar ::before bleed guard.
		expect(viewport.style.overflowX).toBe("hidden");

		// The panel body scrolls inside the lane (the max-w wrapper preserved).
		expect(lane.textContent).toContain("trace_no_active");
		expect(lane.querySelector(".mx-auto.max-w-4xl")).not.toBeNull();
	});
});
