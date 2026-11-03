import { describe, expect, it, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { THEMES, applyThemeClass, isValidTheme, normalizeTheme, themeClassName } from "./registry.js";

useDomEnv({ failOnNetwork: true });
describe("theme registry", () => {
  it("exposes the complete ordered theme list and light/dark icon variants", () => {
    expect(THEMES).toEqual([
      { id: "milk-coffee", className: "milk-coffee", icon: "coffee" },
      { id: "coffee", className: "", icon: "coffeeFilled" },
      { id: "mystic-dawn", className: "mystic-dawn", icon: "sparkles" },
      { id: "mystic-night", className: "mystic-night", icon: "sparklesFilled" },
      { id: "light-lava", className: "light-lava", icon: "flame" },
      { id: "dark-lava", className: "dark-lava", icon: "flameFilled" },
    ]);
  });

  it("normalizes unknown values and resolves registered class names", () => {
    expect(isValidTheme("mystic-night")).toBe(true);
    expect(isValidTheme("missing-theme")).toBe(false);
    expect(normalizeTheme("missing-theme")).toBe("coffee");
    expect(themeClassName("light-lava")).toBe("light-lava");
    expect(themeClassName("missing-theme")).toBe("");
  });

  it("removes stale theme classes before applying the selected theme", () => {
    const root = document.createElement("div");
    root.classList.add("milk-coffee", "dark-lava", "unrelated");
    applyThemeClass(root, "mystic-dawn");
    expect(root.classList.contains("mystic-dawn")).toBe(true);
    expect(root.classList.contains("milk-coffee")).toBe(false);
    expect(root.classList.contains("dark-lava")).toBe(false);
    expect(root.classList.contains("unrelated")).toBe(true);
  });
});

// L1: detached real DOM elements; no paths, global mutations, waits, mocks or DBs.
describe("built-in and user theme identity", () => {
  test("accepts only path-safe bounded user slugs and keeps unknown built-ins on the default", () => {
    expect(isValidTheme("user:sample-123")).toBe(true);
    expect(normalizeTheme("user:sample-123")).toBe("user:sample-123");
    expect(themeClassName("user:sample-123")).toBe("user-sample-123");
    for (const id of ["gone", "user:", "user:../outside", "user:a/b", "user:UPPER", `user:${"a".repeat(81)}`]) {
      expect(normalizeTheme(id)).toBe("coffee");
    }
  });
  test("built-in/user/user/default switches remove stale theme classes without removing unrelated classes", () => {
    const root = document.createElement("html");
    root.className = "debug-root dark-lava";
    applyThemeClass(root, "user:first");
    expect(root.className).toBe("debug-root user-first");
    applyThemeClass(root, "user:second");
    expect(root.className).toBe("debug-root user-second");
    applyThemeClass(root, "milk-coffee");
    expect(root.className).toBe("debug-root milk-coffee");
    applyThemeClass(root, "coffee");
    expect(root.className).toBe("debug-root");
  });
});
