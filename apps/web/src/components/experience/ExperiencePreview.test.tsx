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
import { describe, it, expect, afterEach, afterAll, spyOn } from "bun:test";
import { testFetch } from "@vibe-tavern/test-fetch";

import { useDomEnv } from "../../../test/dom-env.js";

useDomEnv();

const { render, fireEvent, act, waitFor } = await import("@testing-library/react");

// URL spy so the embedded ExperienceFrame does not make happy-dom navigate.
const realCreate = URL.createObjectURL;
const realFetch = globalThis.fetch;
function installUrlSpy() {
  URL.createObjectURL = (() => "about:blank#blob") as typeof URL.createObjectURL;
}
afterEach(() => {
  URL.createObjectURL = realCreate;
  globalThis.fetch = realFetch;
});
afterAll(() => {
  URL.createObjectURL = realCreate;
  globalThis.fetch = realFetch;
});

import { BRIDGE_PROTOCOL_VERSION } from "../../lib/experience-bridge-schema.js";
import { useExperienceStore } from "../../stores/experience-store.js";
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
  it("ships exactly six starters with unique ids", () => {
    const ids = VISUAL_STARTERS.map((s) => s.id);
    expect(ids).toEqual(["choice", "grid-board", "card-table", "conversation", "breakout", "blank"]);
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
      const { container, getByTestId, queryByTestId } = render(<ExperiencePreview starter={starter} initialPhase="setup" />);
      // Phase switcher present; initial phase active alongside the sandboxed iframe.
      expect(getByTestId("experience-preview")).toBeTruthy();
      expect(getByTestId("experience-preview-phase-setup").getAttribute("aria-selected")).toBe("true");
      expect(queryByTestId("experience-preview-phase-ordinary")).not.toBeNull();
      const iframe = container.querySelector("iframe");
      expect(iframe).not.toBeNull();
      expect(iframe!.getAttribute("sandbox")).toBe("allow-scripts");

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
    const starter = getVisualStarter("choice")!;
    const store = useExperienceStore.getState();
    const submitSpy = spyOn(store, "submitAction");
    const endSpy = spyOn(store, "endSession");
    const queueReportSpy = spyOn(store, "queueReport");
    const fetchCalls: unknown[] = [];
    globalThis.fetch = testFetch((...args: unknown[]) => {
      fetchCalls.push(args);
      return Promise.reject(new Error("unexpected fetch in disconnected preview"));
    });

    try {
      const { container, getByTestId } = render(<ExperiencePreview starter={starter} initialPhase="setup" />);
      // Before any click, the disconnected notice is shown.
      const log = getByTestId("experience-preview-log");
      expect(log.textContent).toContain("disconnected");

      // Drive a real bridge handshake + action over the MessageChannel that
      // ExperienceFrame opens on iframe load.
      const iframe = container.querySelector("iframe")!;
      expect(iframe).not.toBeNull();
      let framePort: MessagePort | null = null;
      Object.defineProperty(iframe, "contentWindow", {
        configurable: true,
        value: {
          postMessage(msg: unknown) {
            if (msg && typeof msg === "object" && "kind" in msg && msg.kind === "port" && "port" in msg) {
              framePort = (msg as { port: MessagePort }).port;
            }
          },
        },
      });
      await act(async () => {
        fireEvent.load(iframe);
      });
      expect(framePort).not.toBeNull();

      let helloNonce: string | null = null;
      framePort!.onmessage = (ev: MessageEvent<unknown>) => {
        const data = ev.data as { kind?: string; nonce?: string } | null;
        if (data?.kind === "hello" && typeof data.nonce === "string") {
          helloNonce = data.nonce;
        }
      };
      framePort!.start?.();
      await waitFor(() => {
        expect(helloNonce).not.toBeNull();
      });

      framePort!.postMessage({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "ready",
        nonce: helloNonce!,
      });
      framePort!.postMessage({
        v: BRIDGE_PROTOCOL_VERSION,
        kind: "action",
        nonce: helloNonce!,
        action: {
          type: "pick_north",
          requestId: "preview-req-1",
          expectedRevision: starter.fixtures.setup.revision,
        },
      });

      await waitFor(() => {
        expect(log.textContent).toContain("pick_north");
      });
      expect(log.textContent).not.toContain("disconnected");
      expect(submitSpy).not.toHaveBeenCalled();
      expect(endSpy).not.toHaveBeenCalled();
      expect(queueReportSpy).not.toHaveBeenCalled();
      expect(fetchCalls).toHaveLength(0);
    } finally {
      submitSpy.mockRestore();
      endSpy.mockRestore();
      queueReportSpy.mockRestore();
    }
  });
});
