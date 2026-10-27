import { beforeEach, describe, expect, it, mock } from "bun:test";
import { brandId, type ChatId, type ChatBranchId, type MessageId, type ExperienceMessageReport } from "@vibe-tavern/domain";
import type { AppMessage, AppSnapshot } from "../../../api/types.js";
import { useDomEnv } from "../../../../test/dom-env.js";
import { wireCharacter } from "../../../../test/wire-fixtures.js";
import { installI18nContextSeam } from "../../../../test/i18n-context-seam.js";

useDomEnv({ failOnNetwork: true });
installI18nContextSeam();
// MessageBlock loads voice-map choices at the HTTP boundary. Keep everything
// below that boundary real while ensuring this test never opens a socket.
const realTtsApi = { ...await import("../../../api/tts-api.js") };
mock.module("../../../api/tts-api.js", () => ({ ...realTtsApi,
  listAllTtsProfiles: async () => [], listAllTtsLinks: async () => [] }));
const { render, act, fireEvent } = await import("@testing-library/react");
const { useSnapshotStore } = await import("../../../stores/snapshot-store.js");
const { useChatStore } = await import("../../../stores/chat-store.js");
const { TooltipProvider } = await import("../../shared/Tooltip.js");
const { PendingUserMessage } = await import("./pending-user-message.js");
const { MessageBlock } = await import("../MessageBlock.js");
const { useDisplayMessageIds } = await import("../MessageScroller.js");

const chatId = brandId<ChatId>("chat-pending");
const report = { title: "Frozen Cards", eventCount: 1,
  participants: [{ id: "p1", label: "Player" }], events: [{ type: "played", participantId: "p1", detail: "played a red six" }] } satisfies ExperienceMessageReport;

/** Real display-id derivation and message shells, without virtualized geometry. */
function UserMessages() {
  const ids = useDisplayMessageIds();
  return <TooltipProvider>{ids.filter((id) => id !== "__pending-assistant").map((id, index) => (
    <MessageBlock key={id} messageId={id} index={index} isFirstAssistant={false} isLast={true} prevRole={null} />
  ))}</TooltipProvider>;
}

beforeEach(() => {
  useSnapshotStore.getState().clear();
  useSnapshotStore.setState({ character: wireCharacter(),
    activeChat: { id: chatId, mode: "rp" } as AppSnapshot["activeChat"] });
  useChatStore.setState({ activeChatId: chatId, generations: {} });
});

describe("pending user report chip (ERX-9)", () => {
  it("renders the real pending metadata row and opens the captured report without a live queue", async () => {
    useChatStore.getState().startGeneration(chatId, "Played", [], null, report);
    const view = render(<TooltipProvider><PendingUserMessage /></TooltipProvider>);
    const chip = view.getByTestId("experience-report-chip");
    expect(chip.textContent).toContain("Frozen Cards");
    await act(async () => { fireEvent.click(chip); });
    expect(view.getByTestId("experience-report-chip-detail").textContent).toContain("Player: played a red six");
    await act(async () => { useChatStore.getState().finishGeneration(chatId); });
    expect(view.queryByTestId("experience-report-chip")).toBeNull();
  });

  it("renders no report for ordinary sends and removes the frozen report on abort", async () => {
    useChatStore.getState().startGeneration(chatId, "Hello");
    const view = render(<TooltipProvider><PendingUserMessage /></TooltipProvider>);
    expect(view.queryByTestId("experience-report-chip")).toBeNull();
    await act(async () => { useChatStore.getState().startGeneration(chatId, "Played", [], null, report); });
    expect(view.getByTestId("experience-report-chip")).toBeDefined();
    await act(async () => { useChatStore.getState().abortGeneration(chatId); });
    expect(view.queryByTestId("experience-report-chip")).toBeNull();
  });

  it("shows exactly one chip through pending → committed snapshot → generation settlement", async () => {
    useChatStore.getState().startGeneration(chatId, "Played", [], null, report);
    const view = render(<UserMessages />);
    expect(view.getAllByTestId("experience-report-chip")).toHaveLength(1);
    const message: AppMessage = { id: brandId<MessageId>("committed"), chatId, branchId: brandId<ChatBranchId>("branch"), role: "user", authorType: "user",
      position: 1, content: "Played", state: "complete", createdAt: "2026-10-27T12:00:00Z", updatedAt: "2026-10-27T12:00:00Z",
      variants: [], selectedVariantIndex: null, modelId: null, sceneTracker: null, experienceReports: [report] };
    await act(async () => { useSnapshotStore.getState().ingestSnapshot({ messages: [message] }); });
    expect(view.getAllByTestId("experience-report-chip")).toHaveLength(1);
    expect(view.container.querySelector('[data-message-id="__pending-user"]')).toBeNull();
    await act(async () => { useChatStore.getState().finishGeneration(chatId); });
    expect(view.getAllByTestId("experience-report-chip")).toHaveLength(1);
    await act(async () => { fireEvent.click(view.getByTestId("experience-report-chip")); });
    expect(view.getByTestId("experience-report-chip-detail").textContent).toContain("Player: played a red six");
  });

  it("ERX-9a: mounts the report on an attachment-only pending message and reconciles without duplication", async () => {
    const attachments = [{ id: "file", assetId: "asset", type: "file" as const, name: "notes.txt", mimeType: "text/plain", sizeBytes: 10 }];
    useChatStore.getState().startGeneration(chatId, "", attachments, null, report);
    const view = render(<UserMessages />);
    expect(view.getAllByTestId("experience-report-chip")).toHaveLength(1);
    const message: AppMessage = { id: brandId<MessageId>("file-message"), chatId, branchId: brandId<ChatBranchId>("branch"), role: "user", authorType: "user",
      position: 1, content: "", state: "complete", createdAt: "2026-10-27T12:00:00Z", updatedAt: "2026-10-27T12:00:00Z",
      variants: [], selectedVariantIndex: null, modelId: null, sceneTracker: null, attachments, experienceReports: [report] };
    await act(async () => { useSnapshotStore.getState().ingestSnapshot({ messages: [message] }); });
    expect(view.getAllByTestId("experience-report-chip")).toHaveLength(1);
    expect(view.container.querySelector('[data-message-id="__pending-user"]')).toBeNull();
    await act(async () => { useChatStore.getState().finishGeneration(chatId); });
    expect(view.getAllByTestId("experience-report-chip")).toHaveLength(1);
  });
});
