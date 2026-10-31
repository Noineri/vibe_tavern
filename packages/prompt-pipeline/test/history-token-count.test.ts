/**
 * History piece counting — TOKEN_COUNT_ONCE_PLAN TC-3.
 *
 * Characterization (written BEFORE the TC-3 change, against the pre-change
 * code): `formatRecentMessages` output, `countHistoryTokens` results and
 * `planHistoryCompaction` plans are pinned on fixtures with a deterministic
 * char-length counter. The per-message decomposition must keep every one of
 * these green UNCHANGED: with no side answer injected the counter keeps the
 * joined count, so prompt text, displayed counts and compaction cuts cannot
 * move.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { planHistoryCompaction, setModelHint, setSeparatorSideFn, setTokenCountFn } from "../src/compaction.ts";
import { countHistoryTokens, formatRecentMessages } from "../src/history-token-count.ts";
import type { RecentMessage } from "../src/types.js";
import type { Attachment } from "@vibe-tavern/domain";

const FIXTURE: RecentMessage[] = [
  { id: "msg_1", role: "user", content: "Old user turn." },
  { id: "msg_2", role: "assistant", content: "Old assistant turn." },
  { id: "msg_3", role: "user", content: "  Recent user turn with padding  " },
  { id: "msg_4", role: "assistant", content: "Recent assistant turn." },
];

function pieces(messages: RecentMessage[]): string[] {
  return messages.map((m) => `${m.role.toUpperCase()}: ${m.content.trim()}`);
}

/** Joined char costs of the fixture's suffixes under the char-length counter. */
const FULL_COST = pieces(FIXTURE).join("\n\n").length;
const TRIPLE_COST = pieces(FIXTURE.slice(1)).join("\n\n").length;
const PAIR_COST = pieces(FIXTURE.slice(2)).join("\n\n").length;

/** Recording spy: asserts the exact per-piece text forms that reach the
 *  injected counter — the forms the layered cache keys on. */
function recordingCounter(): { texts: string[]; count: (text: string) => number } {
  const texts: string[] = [];
  return { texts, count: (text: string) => { texts.push(text); return text.length; } };
}

beforeEach(() => {
  setTokenCountFn((text) => text.length);
  setSeparatorSideFn(null);
});

afterEach(() => {
  setSeparatorSideFn(null);
  setTokenCountFn(() => 0);
});

describe("formatRecentMessages output (characterization)", () => {
  it("joins trimmed role-labeled pieces with blank-line separators", () => {
    expect(formatRecentMessages(FIXTURE)).toBe(
      "USER: Old user turn.\n\nASSISTANT: Old assistant turn.\n\nUSER: Recent user turn with padding\n\nASSISTANT: Recent assistant turn.",
    );
  });

  it("formats every role the history layer carries", () => {
    const allRoles: RecentMessage[] = [
      { id: "m1", role: "system", content: "system note" },
      { id: "m2", role: "tool", content: "tool result" },
      { id: "m3", role: "assistant", content: "\tTabbed and spaced reply  \n" },
    ];
    expect(formatRecentMessages(allRoles)).toBe(
      "SYSTEM: system note\n\nTOOL: tool result\n\nASSISTANT: Tabbed and spaced reply",
    );
  });

  it("returns the empty string for an empty history and a single unjoined piece otherwise", () => {
    expect(formatRecentMessages([])).toBe("");
    expect(formatRecentMessages([{ id: "m1", role: "user", content: " only one " }])).toBe("USER: only one");
  });
});

describe("countHistoryTokens with the joined count (characterization)", () => {
  it("counts the joined history text through the injected counter", () => {
    expect(countHistoryTokens(FIXTURE)).toBe(pieces(FIXTURE).join("\n\n").length);
    expect(countHistoryTokens([])).toBe(0);
    expect(countHistoryTokens(FIXTURE.slice(0, 1))).toBe("USER: Old user turn.".length);
  });

  it("adds attachment weights on top of the formatted text, per message", () => {
    const file: Attachment = {
      id: "file_1", assetId: "asset_file_1", type: "file", name: "notes.md",
      mimeType: "text/markdown", sizeBytes: 10, tokenCount: 400_000,
    };
    const withFile = FIXTURE.map((m) => (m.id === "msg_3" ? { ...m, attachments: [file] } : m));
    expect(countHistoryTokens(withFile)).toBe(pieces(withFile).join("\n\n").length + 400_000);
    const summarized = FIXTURE.map((m) =>
      m.id === "msg_3" ? { ...m, attachments: [{ ...file, description: "Summary", summaryTokenCount: 9 }] } : m,
    );
    expect(countHistoryTokens(summarized)).toBe(pieces(summarized).join("\n\n").length + 9);
  });
});

describe("planHistoryCompaction through countHistoryTokens (characterization)", () => {
  it("returns null when the whole history fits the budget", () => {
    const plan = planHistoryCompaction({
      messages: FIXTURE,
      nonHistoryTokens: 0,
      contextBudget: FULL_COST,
      countHistoryTokens,
    });
    expect(plan).toBeNull();
  });

  it("cuts to the required pair as soon as one more message overflows", () => {
    const plan = planHistoryCompaction({
      messages: FIXTURE,
      nonHistoryTokens: 0,
      contextBudget: PAIR_COST - 1,
      countHistoryTokens,
    });
    expect(plan?.messages).toEqual(FIXTURE.slice(2));
    expect(plan?.preservedHistoryTokens).toBe(PAIR_COST);
    expect(plan?.fullHistoryTokens).toBeUndefined();
    expect(plan?.responseReserve).toBe(0);
  });

  it("keeps the largest fitting suffix with truthful full-history accounting", () => {
    const plan = planHistoryCompaction({
      messages: FIXTURE,
      nonHistoryTokens: 0,
      contextBudget: TRIPLE_COST,
      countHistoryTokens,
    });
    expect(plan?.messages).toEqual(FIXTURE.slice(1));
    expect(plan?.preservedHistoryTokens).toBe(TRIPLE_COST);
    expect(plan?.fullHistoryTokens).toBe(FULL_COST);
    expect(plan?.totalBeforeCompaction).toBe(FULL_COST);
  });
});

describe("per-message decomposition side arithmetic (TC-3)", () => {
  it("side \"after\" counts every piece but the newest with a trailing separator", () => {
    const spy = recordingCounter();
    setTokenCountFn(spy.count);
    setSeparatorSideFn(() => "after");
    const [p0, p1, p2, p3] = pieces(FIXTURE);
    const total = countHistoryTokens(FIXTURE);
    expect(spy.texts).toEqual([`${p0}\n\n`, `${p1}\n\n`, `${p2}\n\n`, p3]);
    expect(total).toBe(`${p0}\n\n`.length + `${p1}\n\n`.length + `${p2}\n\n`.length + p3.length);
  });

  it("side \"before\" counts the oldest piece bare and the rest with a leading separator", () => {
    const spy = recordingCounter();
    setTokenCountFn(spy.count);
    setSeparatorSideFn(() => "before");
    const [p0, p1, p2, p3] = pieces(FIXTURE);
    const total = countHistoryTokens(FIXTURE);
    expect(spy.texts).toEqual([p0, `\n\n${p1}`, `\n\n${p2}`, `\n\n${p3}`]);
    expect(total).toBe(p0.length + `\n\n${p1}`.length + `\n\n${p2}`.length + `\n\n${p3}`.length);
  });

  it("no side answer counts the single joined string — today's behavior", () => {
    const spy = recordingCounter();
    setTokenCountFn(spy.count);
    setSeparatorSideFn(null);
    const total = countHistoryTokens(FIXTURE);
    expect(spy.texts).toEqual([pieces(FIXTURE).join("\n\n")]);
    expect(total).toBe(pieces(FIXTURE).join("\n\n").length);
  });

  it("a null side ANSWER (measured-unmeasured tokenizer) also counts the joined string", () => {
    const spy = recordingCounter();
    setTokenCountFn(spy.count);
    setSeparatorSideFn(() => null);
    countHistoryTokens(FIXTURE);
    expect(spy.texts).toEqual([pieces(FIXTURE).join("\n\n")]);
  });

  it("the side answer receives the model hint set through setModelHint", () => {
    const seenModels: Array<string | undefined> = [];
    setTokenCountFn((text) => text.length);
    setSeparatorSideFn((model) => { seenModels.push(model); return null; });
    setModelHint("some-model");
    countHistoryTokens(FIXTURE);
    expect(seenModels).toEqual(["some-model"]);
    setModelHint(undefined);
  });

  it("the formatted history string is byte-identical under every side", () => {
    const joined = formatRecentMessages(FIXTURE);
    for (const side of ["after", "before"] as const) {
      setSeparatorSideFn(() => side);
      expect(formatRecentMessages(FIXTURE)).toBe(joined);
    }
  });

  it("growing suffixes never cost less on the \"before\" side (spy counter, prepends re-glue the old head)", () => {
    // A Map-keyed counter models the real tokenizer: same text → same count.
    const seen = new Map<string, number>();
    setTokenCountFn((text) => {
      const cached = seen.get(text);
      if (cached !== undefined) return cached;
      const value = text.length;
      seen.set(text, value);
      return value;
    });
    setSeparatorSideFn(() => "before");
    let previous = 0;
    for (let start = FIXTURE.length - 1; start >= 0; start -= 1) {
      const cost = countHistoryTokens(FIXTURE.slice(start));
      expect(cost).toBeGreaterThanOrEqual(previous);
      previous = cost;
    }
  });
});

describe("whitespace guard on the \"before\" side (TC-3)", () => {
  const WS_HISTORY: RecentMessage[] = [
    { id: "w1", role: "user", content: "Normal turn." },
    { id: "w2", role: "assistant", content: "" },
    { id: "w3", role: "user", content: "Another normal turn." },
    { id: "w4", role: "assistant", content: "Fine." },
  ];

  it("a whitespace-ending non-last piece (empty content ⇒ \"ROLE: \") falls back to the joined count", () => {
    const spy = recordingCounter();
    setTokenCountFn(spy.count);
    setSeparatorSideFn(() => "before");
    const total = countHistoryTokens(WS_HISTORY);
    expect(spy.texts).toEqual([pieces(WS_HISTORY).join("\n\n")]);
    expect(total).toBe(pieces(WS_HISTORY).join("\n\n").length);
  });

  it("a whitespace-ending LAST piece stays decomposed (no separator follows it)", () => {
    const spy = recordingCounter();
    setTokenCountFn(spy.count);
    setSeparatorSideFn(() => "before");
    const history: RecentMessage[] = [
      { id: "w1", role: "user", content: "Normal turn." },
      { id: "w4", role: "assistant", content: "" },
    ];
    const [p0, p1] = pieces(history);
    countHistoryTokens(history);
    expect(spy.texts).toEqual([p0, `\n\n${p1}`]);
  });

  it("the \"after\" side decomposes whitespace-ending pieces without a guard", () => {
    const spy = recordingCounter();
    setTokenCountFn(spy.count);
    setSeparatorSideFn(() => "after");
    const [p0, p1, p2, p3] = pieces(WS_HISTORY);
    countHistoryTokens(WS_HISTORY);
    expect(spy.texts).toEqual([`${p0}\n\n`, `${p1}\n\n`, `${p2}\n\n`, p3]);
  });

  it("growing suffixes never cost less when guarded and decomposed probes interleave", () => {
    // The empty message sits mid-history: short suffixes are decomposed,
    // longer ones are guarded-joined — exactly the interleaving the guard
    // creates inside one planHistoryCompaction probe sequence.
    const seen = new Map<string, number>();
    setTokenCountFn((text) => {
      const cached = seen.get(text);
      if (cached !== undefined) return cached;
      const value = text.length;
      seen.set(text, value);
      return value;
    });
    setSeparatorSideFn(() => "before");
    let previous = 0;
    for (let start = WS_HISTORY.length - 1; start >= 0; start -= 1) {
      const cost = countHistoryTokens(WS_HISTORY.slice(start));
      expect(cost).toBeGreaterThanOrEqual(previous);
      previous = cost;
    }
  });
});
