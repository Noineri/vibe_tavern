import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { AppMessage } from "../../api/types.js";
import { brandId, type ChatId } from "@vibe-tavern/domain";
import { useDomEnv } from "../../../test/dom-env.js";
import { useChatStore } from "../../stores/chat-store.js";
import { useGenerationQueueStore } from "../../stores/generation-queue-store.js";
import { useSnapshotStore } from "../../stores/snapshot-store.js";

useDomEnv();

const { render } = await import("@testing-library/react");
const { QueueTimeline } = await import("./queue-timeline.js");
const { LocaleProvider } = await import("../../i18n/context.js");
const { i18next, initI18n } = await import("../../i18n/i18n.js");

initI18n("en");
const CHAT = brandId<ChatId>("timeline-chat");
const initialChat = useChatStore.getState();
const initialQueue = useGenerationQueueStore.getState();
const initialSnapshot = useSnapshotStore.getState();

afterAll(async () => {
  useChatStore.setState(initialChat, true);
  useGenerationQueueStore.setState(initialQueue, true);
  useSnapshotStore.setState(initialSnapshot, true);
  await i18next.changeLanguage("en");
});

beforeEach(() => {
  useChatStore.setState({ activeChatId: CHAT });
  useGenerationQueueStore.setState({ jobsByChat: {}, batchesByChat: {}, recordsByChat: {} });
  useSnapshotStore.setState({ messageOrder: [], messagesById: {} });
});

describe("QueueTimeline", () => {
  test("renders durable finished, running, and waiting timeline rows", () => {
    const messageId = "timeline-message";
    useSnapshotStore.setState({
      messageOrder: [messageId],
      messagesById: { [messageId]: { id: messageId, selectedVariantIndex: 0, variants: [{ id: "variant-a", variantIndex: 0, modelId: "model-a", presetName: "Preset" }] } as AppMessage },
    });
    useGenerationQueueStore.getState().startBatch(CHAT, messageId, ["variant-a"]);
    useGenerationQueueStore.getState().addRecord(CHAT, { messageId, origin: "regenerate", status: "running", model: "model-b", presetName: "Preset", presetId: null });
    useGenerationQueueStore.getState().addRecord(CHAT, { messageId, origin: "queue", status: "pending", model: "model-c", presetName: "Preset", presetId: null });

    const { getByText } = render(<LocaleProvider initialLocale="en"><QueueTimeline onClose={() => undefined} /></LocaleProvider>);

    expect(getByText("More variants")).not.toBeNull();
    expect(getByText("Variant 1")).not.toBeNull();
    expect(getByText("Writing…")).not.toBeNull();
    expect(getByText("Waiting")).not.toBeNull();
  });
});
