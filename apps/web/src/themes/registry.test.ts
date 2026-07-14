import { describe, expect, it } from "vitest";
import { THEMES, applyThemeClass, isValidTheme, normalizeTheme, themeClassName } from "./registry.js";

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
