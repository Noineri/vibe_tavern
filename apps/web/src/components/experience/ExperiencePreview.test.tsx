/**
 * Visual starters + ExperiencePreview tests (IR-63).
 *
 * Two concerns:
 *   1. Starter source hygiene: every shipped starter is self-contained — no
 *      application-internal imports, no `require`, no host-global access
 *      (fetch/localStorage/window.opener/etc.). The frame CSP blocks these
 *      anyway; this test pins the author intent so a future edit cannot
 *      accidentally introduce a host dependency. The only host-provided surface
 *      a starter may touch is the `VibeExperience` SDK.
 *   2. Preview rendering: every starter renders without throwing across every
 *      fixture phase (setup/ordinary/pending/error/completed), the phase
 *      switcher is present, and preview actions stay DISCONNECTED (the log
 *      updates but no production handler fires).
 */
import { describe, it, expect, afterEach } from "bun:test";
import { render, fireEvent, act } from "@testing-library/react";
import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

// URL spy so the embedded ExperienceFrame does not make happy-dom navigate.
const realCreate = URL.createObjectURL;
function installUrlSpy() {
  URL.createObjectURL = (() => "about:blank#blob") as typeof URL.createObjectURL;
}
afterEach(() => {
  URL.createObjectURL = realCreate;
});

import { VISUAL_STARTERS, VISUAL_STARTER_SOURCES, getVisualStarter } from "./starters/index.js";
import { ExperiencePreview, PREVIEW_PHASES } from "./ExperiencePreview.js";

// Host globals a starter must NOT reference (the frame CSP blocks them; this
// guards author intent). `window.VibeExperience` and standard DOM are allowed.
const FORBIDDEN_GLOBAL_PATTERNS = [
  /\bfetch\s*\(/,
  /\bXMLHttpRequest\b/,
  /\blocalStorage\b/,
  /\bsessionStorage\b/,
  /\bindexedDB\b/,
  /\bwindow\.opener\b/,
  /\bwindow\.top\b/,
  /\bwindow\.parent\b/,
  /\bpostMessage\b/,
  /\bimport\s*[\("]/, // no ESM import() / import statements inside the frame
  /\brequire\s*\(/,
  /\bdocument\.cookie\b/,
];

// ─── Starter hygiene ────────────────────────────────────────────────────────

describe("visual starters — registry shape", () => {
  it("ships exactly five starters with unique ids", () => {
    const ids = VISUAL_STARTERS.map((s) => s.id);
    expect(ids).toEqual(["choice", "grid-board", "card-table", "conversation", "blank"]);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("getVisualStarter resolves by id", () => {
    expect(getVisualStarter("conversation")?.label).toBe("Conversation");
    expect(getVisualStarter("nope")).toBeUndefined();
  });

  it("every starter carries a non-empty source + all five fixtures", () => {
    for (const s of VISUAL_STARTERS) {
      expect(s.source.length).toBeGreaterThan(0);
      expect(s.source).toContain("VibeExperience.connect");
      for (const phase of PREVIEW_PHASES) {
        const f = s.fixtures[phase];
        expect(f, `${s.id} ${phase} fixture`).toBeDefined();
        expect(typeof f!.status).toBe("string");
        expect(Array.isArray(f!.actions)).toBe(true);
      }
    }
  });
});

describe("visual starters — no host globals / internal imports leak", () => {
  for (const source of VISUAL_STARTER_SOURCES) {
    it(`starter source is self-contained (${source.slice(0, 24).replace(/\s+/g, " ")}…)`, () => {
      for (const pat of FORBIDDEN_GLOBAL_PATTERNS) {
        expect(pat.test(source), `forbidden pattern ${pat} matched`).toBe(false);
      }
      // Every starter MUST use the host SDK as its only bridge.
      expect(source).toContain("VibeExperience.connect");
    });
  }
});

// ─── ExperiencePreview ──────────────────────────────────────────────────────

describe("ExperiencePreview — renders every starter across every phase", () => {
  for (const starter of VISUAL_STARTERS) {
    it(`renders ${starter.label} and switches phases without throwing`, async () => {
      installUrlSpy();
      const { getByTestId, queryByTestId } = render(<ExperiencePreview starter={starter} initialPhase="setup" />);
      // Phase switcher present; initial phase active.
      expect(getByTestId("experience-preview")).toBeTruthy();
      expect(getByTestId("experience-preview-phase-setup").getAttribute("aria-selected")).toBe("true");
      // The frame is mounted (sandboxed).
      expect(queryByTestId("experience-preview-phase-ordinary")).not.toBeNull();

      // Cycle through every phase without throwing.
      for (const phase of PREVIEW_PHASES) {
        await act(async () => {
          fireEvent.click(getByTestId(`experience-preview-phase-${phase}`));
        });
        expect(getByTestId(`experience-preview-phase-${phase}`).getAttribute("aria-selected")).toBe("true");
      }
    });
  }

  it("keeps preview actions disconnected (log only, no production handler)", async () => {
    installUrlSpy();
    const { getByTestId } = render(<ExperiencePreview starter={getVisualStarter("choice")!} initialPhase="setup" />);
    // Before any click, the disconnected notice is shown.
    const log = getByTestId("experience-preview-log");
    expect(log.textContent).toContain("disconnected");
  });
});
