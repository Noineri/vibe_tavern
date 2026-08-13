/**
 * ExperienceFrame — DOM + URL-lifecycle tests (IR-61).
 *
 * The live handshake/act round-trip is covered by the bridge integration test
 * (real MessagePort, no DOM). Here we pin what happy-dom CAN reliably assert:
 *   - the iframe sandbox attribute is `allow-scripts` and does NOT include
 *     `allow-same-origin` (the omission that forces the opaque origin);
 *   - the generated frame document carries the restrictive CSP
 *     (`connect-src 'none'`), the injected SDK, and the user visual source;
 *   - the blob URL is created on mount and revoked on unmount (no lingering
 *     reference to a stale frame document).
 *
 * URL.createObjectURL / revokeObjectURL are spied so we both observe the
 * lifecycle and can read back the exact document bytes handed to the frame.
 */
import { describe, it, expect, afterEach } from "bun:test";
import { render, act } from "@testing-library/react";
import { createRef } from "react";
import { useDomEnv } from "../../../test/dom-env.js";
import {
  ExperienceFrame,
  EXPERIENCE_FRAME_CSP,
  buildExperienceFrameDocument,
  type ExperienceFrameHandle,
} from "./ExperienceFrame.js";
import { VIBE_EXPERIENCE_SDK_SOURCE } from "../../lib/experience-sdk.js";

useDomEnv();

const VISUAL = [
  "<div id=\"game\">hello</div>",
  "<script>VibeExperience.connect(function(v){document.getElementById('game').textContent=JSON.stringify(v);});</script>",
].join("\n");

// ─── spies ──────────────────────────────────────────────────────────────────

const createdBlobs: Blob[] = [];
const revokedUrls: string[] = [];
const realCreate = URL.createObjectURL;
const realRevoke = URL.revokeObjectURL;

function installUrlSpies() {
  let n = 0;
  URL.createObjectURL = (blob: Blob) => {
    createdBlobs.push(blob);
    // Return `about:blank` so happy-dom does not attempt to navigate/fetch the
    // iframe (a real URL triggers BrowserFrameNavigator, whose async rejection
    // can interfere with passive-effect flush). The exact string is irrelevant
    // to these tests — only the blob lifecycle + document bytes are asserted.
    return `about:blank#blob-${n++}`;
  };
  URL.revokeObjectURL = (url: string) => {
    revokedUrls.push(url);
  };
}

function restoreUrl() {
  URL.createObjectURL = realCreate;
  URL.revokeObjectURL = realRevoke;
}

afterEach(() => {
  createdBlobs.length = 0;
  revokedUrls.length = 0;
  restoreUrl();
});

// ─── buildExperienceFrameDocument (pure) ────────────────────────────────────

describe("buildExperienceFrameDocument", () => {
  it("includes the restrictive CSP meta", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).toContain(`http-equiv="Content-Security-Policy"`);
    expect(doc).toContain(EXPERIENCE_FRAME_CSP);
    // network is explicitly closed
    expect(EXPERIENCE_FRAME_CSP).toContain("connect-src 'none'");
    expect(EXPERIENCE_FRAME_CSP).toContain("default-src 'none'");
  });

  it("injects the immutable VibeExperience SDK before the visual source", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).toContain(VIBE_EXPERIENCE_SDK_SOURCE);
    expect(doc).toContain(VISUAL);
    expect(doc.indexOf(VIBE_EXPERIENCE_SDK_SOURCE)).toBeLessThan(doc.indexOf(VISUAL));
  });

  it("runs under allow-scripts only (no allow-same-origin in the CSP)", () => {
    // The sandbox attribute is on the <iframe>, not the doc; here we only assert
    // the doc itself does not relax isolation. The attribute is asserted below.
    expect(EXPERIENCE_FRAME_CSP).not.toContain("allow-same-origin");
  });

  it("bakes the host scrollbar color into the base style (theme-aware)", () => {
    // The frame is opaque-origin, so it cannot inherit the host's ::-webkit-scrollbar
    // rule or --border2 token; the color must be baked into the srcdoc.
    const doc = buildExperienceFrameDocument(VISUAL, "oklch(0.4 0.02 290)");
    expect(doc).toContain("::-webkit-scrollbar");
    expect(doc).toContain("scrollbar-width:thin");
    expect(doc).toContain("oklch(0.4 0.02 290)");
  });

  it("falls back to a neutral scrollbar when no theme color is provided", () => {
    const doc = buildExperienceFrameDocument(VISUAL);
    expect(doc).toContain("::-webkit-scrollbar");
    expect(doc).toContain("rgba(140,140,140,0.5)");
  });
});

// ─── ExperienceFrame component (DOM + URL lifecycle) ────────────────────────

describe("ExperienceFrame", () => {
  it("renders an iframe sandboxed with allow-scripts and WITHOUT allow-same-origin", () => {
    installUrlSpies();
    const { container } = render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    const iframe = container.querySelector("iframe")!;
    expect(iframe).not.toBeNull();
    const sandbox = iframe.getAttribute("sandbox") ?? "";
    expect(sandbox).toContain("allow-scripts");
    expect(sandbox).not.toContain("allow-same-origin");
  });

  it("creates a blob URL on mount and revokes it on unmount", () => {
    installUrlSpies();
    const { unmount } = render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    expect(createdBlobs.length).toBe(1);
    expect(revokedUrls.length).toBe(0);
    unmount();
    expect(revokedUrls.length).toBe(1);
  });

  it("revokes the previous blob URL when the visual source changes", () => {
    installUrlSpies();
    const { rerender } = render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    expect(createdBlobs.length).toBe(1);
    rerender(
      <ExperienceFrame
        visualSource="<div>new source</div>"
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    // first URL revoked; a second blob created for the new source
    expect(revokedUrls.length).toBe(1);
    expect(createdBlobs.length).toBe(2);
  });

  it("hands the frame document (CSP + SDK + visual source) to createObjectURL", async () => {
    installUrlSpies();
    render(
      <ExperienceFrame
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    const doc = await createdBlobs[0]!.text();
    expect(doc).toContain(EXPERIENCE_FRAME_CSP);
    expect(doc).toContain(VIBE_EXPERIENCE_SDK_SOURCE);
    expect(doc).toContain(VISUAL);
  });

  it("exposes the imperative push surface through the ref", async () => {
    installUrlSpies();
    const ref = createRef<ExperienceFrameHandle>();
    await act(async () => {
      render(
        <ExperienceFrame
          ref={ref}
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={0}
          onAction={() => {}}
        />,
      );
    });
    const handle = ref.current;
    // The handle is wired (methods exist). isReady is false until a real
    // handshake, which happy-dom's iframe cannot drive — covered by the bridge
    // integration test. We assert the surface shape here.
    expect(handle).not.toBeNull();
    expect(typeof handle!.sendState).toBe("function");
    expect(typeof handle!.sendResult).toBe("function");
    expect(typeof handle!.sendError).toBe("function");
    expect(typeof handle!.sendPending).toBe("function");
    expect(typeof handle!.sendLifecycle).toBe("function");
    expect(handle!.isReady).toBe(false);
    // The bridge is created (nonce generated in its constructor) but not yet
    // attached to a frame port (no iframe load in happy-dom) — so isReady is
    // false but the session nonce is already a valid 32-hex identity token.
    expect(handle!.sessionNonce).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("ExperienceFrame — session-scoped bridge lifetime (IR-73B seam #4)", () => {
  it("does NOT recreate/strand the bridge when only initialRevision changes", async () => {
    installUrlSpies();
    const ref = createRef<ExperienceFrameHandle>();
    const { rerender } = render(
      <ExperienceFrame
        ref={ref}
        visualSource={VISUAL}
        sessionId="sess_1"
        initialRevision={3}
        onAction={() => {}}
      />,
    );
    const nonceBefore = ref.current!.sessionNonce;
    // A revision prop update for the SAME session must NOT dispose/recreate
    // the bridge — later authoritative revisions arrive through sendState, not
    // bridge reconstruction. The session nonce stays identical.
    await act(async () => {
      rerender(
        <ExperienceFrame
          ref={ref}
          visualSource={VISUAL}
          sessionId="sess_1"
          initialRevision={42}
          onAction={() => {}}
        />,
      );
    });
    expect(ref.current).not.toBeNull();
    expect(ref.current!.sessionNonce).toBe(nonceBefore);
  });

  it("recreates the bridge (new nonce) when the sessionId changes", async () => {
    installUrlSpies();
    const ref = createRef<ExperienceFrameHandle>();
    const { rerender } = render(
      <ExperienceFrame
        ref={ref}
        visualSource={VISUAL}
        sessionId="sess_a"
        initialRevision={0}
        onAction={() => {}}
      />,
    );
    const nonceA = ref.current!.sessionNonce;
    await act(async () => {
      rerender(
        <ExperienceFrame
          ref={ref}
          visualSource={VISUAL}
          sessionId="sess_b"
          initialRevision={0}
          onAction={() => {}}
        />,
      );
    });
    const nonceB = ref.current!.sessionNonce;
    // A genuine session id change creates a fresh handshake → new nonce.
    expect(nonceA).not.toBe(nonceB);
    expect(nonceA).toMatch(/^[0-9a-f]{32}$/);
    expect(nonceB).toMatch(/^[0-9a-f]{32}$/);
  });
});
