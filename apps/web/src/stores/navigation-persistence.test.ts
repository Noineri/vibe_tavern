import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { useDomEnv } from "../../test/dom-env.js";
import { registerBuildPanel } from "../lib/build-panel-registry.js";
import { useCharacterStore } from "./character-store.js";
import { useNavigationStore } from "./navigation-store.js";
import {
  __resetNavigationPersistenceForTests,
  __restoreNavigationPersistenceForTests,
  __snapshotNavigationPersistenceForTests,
  initNavigationPersistence,
  restoreNavigationSession,
} from "./navigation-persistence.js";

useDomEnv();

// R2: snapshot the module guards at import, reset before each test, restore after the file.
const navPersistenceSnapshot = __snapshotNavigationPersistenceForTests();

const MODE_KEY = "vibe-tavern.nav.mode";
const BUILD_TAB_KEY = "vibe-tavern.nav.build-tab";

// Stub build panels so tab validation runs against the real registry path
// (register-core-panels is a main.tsx side effect — never imported in tests).
const disposePanels = [
  registerBuildPanel({ id: "character", icon: null, labelKey: "x", render: () => null }),
  registerBuildPanel({ id: "lorebook", icon: null, labelKey: "x", render: () => null }),
];

afterAll(() => {
  for (const dispose of disposePanels) dispose();
  __restoreNavigationPersistenceForTests(navPersistenceSnapshot);
});

beforeEach(() => {
  window.sessionStorage.clear();
  useNavigationStore.setState({ mode: "play" });
  useCharacterStore.setState({ buildTab: "character" });
  __resetNavigationPersistenceForTests();
});

describe("restoreNavigationSession", () => {
  test("restores build mode and build tab after a reload (with an active chat)", () => {
    window.sessionStorage.setItem(MODE_KEY, "build");
    window.sessionStorage.setItem(BUILD_TAB_KEY, "lorebook");

    restoreNavigationSession(true);

    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useCharacterStore.getState().buildTab).toBe("lorebook");
  });

  test("without an active chat nothing is restored — stays on play", () => {
    window.sessionStorage.setItem(MODE_KEY, "build");
    window.sessionStorage.setItem(BUILD_TAB_KEY, "lorebook");

    restoreNavigationSession(false);

    expect(useNavigationStore.getState().mode).toBe("play");
    expect(useCharacterStore.getState().buildTab).toBe("character");
  });

  test("a stored value that is not a current mode/tab id is ignored", () => {
    window.sessionStorage.setItem(MODE_KEY, "bogus-mode");
    window.sessionStorage.setItem(BUILD_TAB_KEY, "dead-tab");

    restoreNavigationSession(true);

    expect(useNavigationStore.getState().mode).toBe("play");
    expect(useCharacterStore.getState().buildTab).toBe("character");
  });

  test("empty storage leaves the defaults untouched", () => {
    restoreNavigationSession(true);

    expect(useNavigationStore.getState().mode).toBe("play");
    expect(useCharacterStore.getState().buildTab).toBe("character");
  });
});

describe("initNavigationPersistence", () => {
  test("mode and build tab changes are written to sessionStorage", () => {
    initNavigationPersistence();
    restoreNavigationSession(true); // persistence goes live only after restore

    useNavigationStore.getState().setMode("build");
    useCharacterStore.getState().setBuildTab("lorebook");

    expect(window.sessionStorage.getItem(MODE_KEY)).toBe("build");
    expect(window.sessionStorage.getItem(BUILD_TAB_KEY)).toBe("lorebook");
  });

  test("writes before the first restore are suppressed (mount-time setTheme must not clobber the persisted mode)", () => {
    window.sessionStorage.setItem(MODE_KEY, "build");
    window.sessionStorage.setItem(BUILD_TAB_KEY, "lorebook");

    initNavigationPersistence();
    // Mount-time store setStates (the theme layout effect's setTheme fires the
    // whole-state listener) must NOT overwrite the persisted values.
    useNavigationStore.getState().setTheme("coffee");
    useCharacterStore.getState().setMdViewMode("form");

    expect(window.sessionStorage.getItem(MODE_KEY)).toBe("build");
    expect(window.sessionStorage.getItem(BUILD_TAB_KEY)).toBe("lorebook");

    restoreNavigationSession(true);

    expect(useNavigationStore.getState().mode).toBe("build");
    expect(useCharacterStore.getState().buildTab).toBe("lorebook");

    // Persistence is live from now on: a real mode change IS written.
    useNavigationStore.getState().setMode("play");
    expect(window.sessionStorage.getItem(MODE_KEY)).toBe("play");
  });

  test("the no-chat early return also unsuppresses writes", () => {
    initNavigationPersistence();
    restoreNavigationSession(false);

    useNavigationStore.getState().setMode("build");

    expect(window.sessionStorage.getItem(MODE_KEY)).toBe("build");
  });

  test("subsequent calls stay single-subscribed (idempotent init)", () => {
    initNavigationPersistence();
    initNavigationPersistence();
    restoreNavigationSession(true);

    useNavigationStore.getState().setMode("build");

    expect(window.sessionStorage.getItem(MODE_KEY)).toBe("build");
  });
});
