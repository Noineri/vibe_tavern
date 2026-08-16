import { describe, expect, it } from "bun:test";
import {
  MESSAGE_PAGE_SIZE,
  STABLE_TAIL_PAGES,
  partitionMessageRenderWindow,
} from "./message-render-window.js";

function ids(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `message-${index}`);
}

describe("partitionMessageRenderWindow", () => {
  it("keeps short conversations entirely in the stable tail", () => {
    const messages = ids(45);

    expect(partitionMessageRenderWindow(messages)).toEqual({
      virtualizedIds: [],
      stableTailIds: messages,
      stableTailStartIndex: 0,
    });
  });

  it("bounds the stable DOM for conversations with thousands of messages", () => {
    const messages = ids(1_000);
    const result = partitionMessageRenderWindow(messages);

    expect(result.virtualizedIds).toHaveLength(900);
    expect(result.stableTailIds).toHaveLength(MESSAGE_PAGE_SIZE * STABLE_TAIL_PAGES);
    expect(result.stableTailStartIndex).toBe(900);
    expect(result.stableTailIds[0]).toBe("message-900");
    expect(result.stableTailIds.at(-1)).toBe("message-999");
  });

  it("keeps the visible end mounted when a new page starts", () => {
    const before = partitionMessageRenderWindow(ids(1_000));
    const after = partitionMessageRenderWindow(ids(1_001));

    expect(after.stableTailStartIndex).toBe(920);
    expect(after.stableTailIds).toHaveLength(81);
    expect(after.stableTailIds.slice(0, -1)).toEqual(before.stableTailIds.slice(20));
    expect(after.stableTailIds.at(-1)).toBe("message-1000");
  });

  it("does not move the virtualization boundary within a page", () => {
    const first = partitionMessageRenderWindow(ids(1_001));
    const last = partitionMessageRenderWindow(ids(1_020));

    expect(first.stableTailStartIndex).toBe(920);
    expect(last.stableTailStartIndex).toBe(920);
    expect(last.stableTailIds).toHaveLength(100);
  });
});
