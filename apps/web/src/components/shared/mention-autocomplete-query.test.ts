import { describe, test, expect } from "bun:test";
import {
  readMentionQuery,
  filterMentionItems,
  MAX_MENTION_QUERY_LEN,
} from "./mention-autocomplete-query.js";

describe("readMentionQuery (CX-5)", () => {
  test("reads the query after a word-start @ at position 0", () => {
    expect(readMentionQuery("@ali", 4)).toBe("ali");
    expect(readMentionQuery("@", 1)).toBe(""); // bare @ opens the session
  });

  test("reads the query after an @ preceded by whitespace", () => {
    expect(readMentionQuery("pin @alice please", 10)).toBe("alice");
    expect(readMentionQuery("a\n@lor", 6)).toBe("lor");
  });

  test("mid-word @ (email-style) never triggers", () => {
    expect(readMentionQuery("mail me a@b", 12)).toBeNull();
    expect(readMentionQuery("email a@b.com", 14)).toBeNull();
    expect(readMentionQuery("@@double", 8)).toBeNull(); // second @ is mid-word
  });

  test("whitespace or newline between the @ and the caret closes the session", () => {
    expect(readMentionQuery("@alice bob", 10)).toBeNull();
    expect(readMentionQuery("@alice\n", 7)).toBeNull();
  });

  test("only the caret-side text counts: @ before an earlier closed session", () => {
    // An @-mention already "sent" earlier in the text is dead when the caret
    // sits after a space following it.
    expect(readMentionQuery("@alice was pinned @bo", 21)).toBe("bo");
    expect(readMentionQuery("@alice was pinned", 18)).toBeNull();
  });

  test("caret before the @ reads no session", () => {
    expect(readMentionQuery("@alice", 0)).toBeNull();
    expect(readMentionQuery("hello", 2)).toBeNull();
    expect(readMentionQuery("", 0)).toBeNull();
  });

  test("oversized query is not a session", () => {
    const long = "a".repeat(MAX_MENTION_QUERY_LEN + 1); // 41 chars → query over the cap
    expect(readMentionQuery(`@${long}`, 1 + long.length)).toBeNull();
    // Exactly at the cap is still a session.
    const edge = "a".repeat(MAX_MENTION_QUERY_LEN);
    expect(readMentionQuery(`@${edge}`, 1 + edge.length)).toBe(edge);
  });
});

describe("filterMentionItems (CX-5)", () => {
  const items = [
    { targetType: "character", id: "char_1", label: "Alice", hint: "wanderer" },
    { targetType: "skill", id: "my-skill", label: "My Skill" },
    { targetType: "lorebook", id: "lb_2", label: "World Lore" },
  ];

  test("empty query returns the full list capped at the limit", () => {
    expect(filterMentionItems(items, "")).toEqual(items);
    expect(filterMentionItems(items, "", 2)).toHaveLength(2);
  });

  test("substring match on label, case-insensitive", () => {
    expect(filterMentionItems(items, "ali")).toEqual([items[0]]);
    expect(filterMentionItems(items, "SKILL")).toEqual([items[1]]);
    expect(filterMentionItems(items, "o")).toEqual([items[2]]); // preserves input order
  });

  test("id matches too (typing a slug)", () => {
    expect(filterMentionItems(items, "char_")).toEqual([items[0]]);
    expect(filterMentionItems(items, "my-sk")).toEqual([items[1]]);
  });

  test("no match → empty list (the caller renders the empty state)", () => {
    expect(filterMentionItems(items, "zzz")).toEqual([]);
  });
});
