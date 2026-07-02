import { describe, test, expect } from "bun:test";
import { getCoauthorModule, getCoauthorModules } from "../src/domain/coauthor/modules/module-registry.js";

describe("Coauthor Module Registry", () => {
  test("getCoauthorModules returns the list of seed modules", () => {
    const modules = getCoauthorModules();
    expect(modules.length).toBeGreaterThan(0);
    expect(modules[0].id).toBe("default");
  });

  test("getCoauthorModule returns a module by id", () => {
    const mod = getCoauthorModule("profile-editor");
    expect(mod.id).toBe("profile-editor");
  });

  test("getCoauthorModule falls back to default if id is not found", () => {
    const mod = getCoauthorModule("non-existent-module");
    expect(mod.id).toBe("default");
  });

  test("getCoauthorModule falls back to default if id is null or undefined", () => {
    expect(getCoauthorModule(null).id).toBe("default");
    expect(getCoauthorModule(undefined).id).toBe("default");
    expect(getCoauthorModule("").id).toBe("default");
  });
});
