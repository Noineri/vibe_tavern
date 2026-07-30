import { test, expect } from "bun:test";
import { filterAndSortList, type ListFilterable } from "./list-filter.js";

interface Item extends ListFilterable {
  id: string;
  name: string;
  recentKey: string;
  tags?: readonly string[];
}

const items: Item[] = [
  { id: "a", name: "Zelda", recentKey: "2026-01-01T00:00:00.000Z", tags: ["elf", "mage"] },
  { id: "b", name: "Aria", recentKey: "2026-06-01T00:00:00.000Z", tags: ["human", "mage"] },
  { id: "c", name: "Bram", recentKey: "2026-03-01T00:00:00.000Z", tags: ["human", "rogue"] },
];

const getName = (i: Item) => i.name;

test("alphabetical sorts by name localeCompare ascending", () => {
  const out = filterAndSortList({ items, getName, sortMode: "alphabetical", query: "", selectedTags: [] });
  expect(out.map((i) => i.id)).toEqual(["b", "c", "a"]); // Aria, Bram, Zelda
});

test("recent sorts by recentKey descending", () => {
  const out = filterAndSortList({ items, getName, sortMode: "recent", query: "", selectedTags: [] });
  expect(out.map((i) => i.id)).toEqual(["b", "c", "a"]); // Jun, Mar, Jan
});

test("name query is a case-insensitive substring filter", () => {
  const out = filterAndSortList({ items, getName, sortMode: "alphabetical", query: "AR", selectedTags: [] });
  expect(out.map((i) => i.id)).toEqual(["b"]); // Aria
});

test("single tag filters to matching items", () => {
  const out = filterAndSortList({ items, getName, sortMode: "alphabetical", query: "", selectedTags: ["mage"] });
  expect(out.map((i) => i.id)).toEqual(["b", "a"]); // Aria, Zelda
});

test("multiple tags use AND semantics (all must be present)", () => {
  const out = filterAndSortList({ items, getName, sortMode: "alphabetical", query: "", selectedTags: ["human", "mage"] });
  expect(out.map((i) => i.id)).toEqual(["b"]); // only Aria is human+mage
});

test("name query ANDs with tag filter", () => {
  const out = filterAndSortList({ items, getName, sortMode: "alphabetical", query: "z", selectedTags: ["mage"] });
  expect(out.map((i) => i.id)).toEqual(["a"]); // Zelda matches name 'z' and tag 'mage'
});

test("items without a tags field are excluded when tags are selected", () => {
  const noTag: Item[] = [{ id: "x", name: "Xander", recentKey: "2026-01-01T00:00:00.000Z" }];
  const out = filterAndSortList({ items: noTag, getName, sortMode: "alphabetical", query: "", selectedTags: ["anything"] });
  expect(out).toEqual([]);
});

test("empty query and empty tags pass everything through", () => {
  const out = filterAndSortList({ items, getName, sortMode: "recent", query: "   ", selectedTags: [] });
  expect(out).toHaveLength(3);
});

test("does not mutate the input array (sorts a copy)", () => {
  const snapshot = items.map((i) => i.id);
  filterAndSortList({ items, getName, sortMode: "recent", query: "", selectedTags: [] });
  expect(items.map((i) => i.id)).toEqual(snapshot);
});

test("empty recentKey sorts last under recent mode", () => {
  const withEmpty: Item[] = [
    { id: "old", name: "Older", recentKey: "2025-01-01T00:00:00.000Z" },
    { id: "none", name: "NoChat", recentKey: "" },
  ];
  const out = filterAndSortList({ items: withEmpty, getName, sortMode: "recent", query: "", selectedTags: [] });
  expect(out.map((i) => i.id)).toEqual(["old", "none"]); // "" < any ISO → last
});
