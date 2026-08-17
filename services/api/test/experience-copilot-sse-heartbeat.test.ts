import { describe, it, expect } from "bun:test";
import { writeCopilotSseEvents } from "../src/api/routes/experience-copilot.js";

/** Minimal SseStreamWriter fake: records raw writes and writeSSE calls. */
function fakeStream() {
  const writes: string[] = [];
  const sse: { event: string; data: string }[] = [];
  return {
    writes,
    sse,
    aborted: false,
    onAbort: (_cb: () => void) => {},
    write: async (message: string) => {
      writes.push(message);
    },
    writeSSE: async (msg: { event: string; data: string }) => {
      sse.push(msg);
    },
  };
}

function bridge() {
  let aborted = false;
  return {
    get signal() {
      return { aborted } as AbortSignal;
    },
    abort: () => {
      aborted = true;
    },
    cleanup: () => {},
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("writeCopilotSseEvents — SSE heartbeat", () => {
  it("writes an SSE comment when the generator is silent past heartbeatMs", async () => {
    // A slow generator: two real events with a silence longer than the heartbeat
    // between them — the exact shape of a thinking model or a held non-streaming
    // provider response (before this fix the socket idled into Bun.serve's
    // idleTimeout and the client saw "request timed out").
    async function* events() {
      yield { event: "start", data: "1" };
      await sleep(60);
      yield { event: "finish", data: "2" };
    }
    const stream = fakeStream();
    await writeCopilotSseEvents(stream, events(), bridge(), 10);
    expect(stream.sse).toEqual([
      { event: "start", data: "1" },
      { event: "finish", data: "2" },
    ]);
    // At least one comment heartbeat bridged the 60ms silence.
    expect(stream.writes.some((w) => w === ": ping\n\n")).toBe(true);
  });

  it("writes no heartbeat when events flow faster than the interval", async () => {
    async function* events() {
      yield { event: "text-delta", data: "a" };
      yield { event: "text-delta", data: "b" };
    }
    const stream = fakeStream();
    await writeCopilotSseEvents(stream, events(), bridge(), 10_000);
    expect(stream.sse).toEqual([
      { event: "text-delta", data: "a" },
      { event: "text-delta", data: "b" },
    ]);
    expect(stream.writes).toEqual([]);
  });
});
